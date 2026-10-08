-- Patch B15 / migration 17 — real Hint purchases, real Buy Time, Final Submit with a terminal freeze.
--
-- Three new participant operations, all built on the B10/B13 engine exactly as unlock_theme is:
--     assert_member -> key present -> app.lock_team (competition share -> team update) -> idem_lookup -> assert_playable
--     -> settle_questions -> validate -> balance check -> coins + ledger + purchase row + state_version -> audit -> idem_store
--   * buy_hint(team, member, question, tier, key)
--   * buy_time(team, member, question, option, expected_purchase_count, key)
--   * final_submit(team, member, confirm, key)
-- Any rejection RAISES (P0001 + stable code), which rolls back every write, so there is never a partial charge.
--
-- Prices, rewards and durations are DATA: a hint costs hints.cost, a Buy Time option adds question_buy_time_options.seconds
-- for question_buy_time_options.cost. Nothing below contains 20, 40, 80, 100 or 50. Each purchase row stores the price
-- actually paid, so later content edits never rewrite history.
--
-- Also here:
--   * app.question_json (re-declared, additive): `hints` (cost, owned, purchasable, and body_md ONLY once the team owns it)
--     and `buy_time` (purchase_count, extra_seconds, can_buy, options). Nothing else in it changes.
--   * public.disapprove_submission (re-declared): the only change is the deadline given back to a question when the
--     team can no longer play. It was `now + frozen remaining`; on a frozen team the clock reads the team's end, so it
--     would have shown far more time than the question had when it was frozen. It is now `question clock + frozen remaining`
--     (identical to before for a live team, where the question clock is `now`).
--
-- Privileges: explicit REVOKE from PUBLIC/anon/authenticated and GRANT to service_role for every function.

-- ---------------------------------------------------------------------------------------------------------------
-- app.question_json — B13 body plus `hints` and `buy_time`. Participant-safe by construction (never question_keys, only
-- the team's own rows). A hint's text is included ONLY when this team has bought it; the price is always shown.
--   hints[]   { tier, cost, owned, purchasable, body_md? }       purchasable = the team can buy it right now
--   buy_time  { purchase_count, extra_seconds, can_buy, options: [{ id, seconds, cost, max_purchases, purchased,
--               remaining_purchases }] }                          options are listed only while the question is ACTIVE
-- ---------------------------------------------------------------------------------------------------------------
create or replace function app.question_json(p_team_id uuid, p_question_id smallint) returns jsonb
language plpgsql stable
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  t      teams%rowtype;
  qq     questions%rowtype;
  tq     team_questions%rowtype;
  v_qref timestamptz;
  v_state text;
  v_out  jsonb;
  d      answer_drafts%rowtype;
  s      submissions%rowtype;
  v_slot smallint;
  v_live boolean;
  v_has_t1 boolean;
  v_hints jsonb;
  v_buy  jsonb;
begin
  select * into t from teams where id = p_team_id;
  select * into qq from questions where id = p_question_id;
  if t.id is null or qq.id is null then
    perform app.fail('NOT_FOUND');
  end if;
  select * into tq from team_questions where team_id = p_team_id and question_id = p_question_id;
  if not found then
    perform app.fail(case when exists (select 1 from team_themes where team_id = p_team_id and theme_id = qq.theme_id)
                          then 'NOT_FOUND' else 'THEME_LOCKED' end);
  end if;

  v_qref := app.question_clock(t);
  v_state := case when tq.state = 'ACTIVE' and tq.timer_deadline <= v_qref then 'TIMED_OUT' else tq.state::text end;
  if v_state = 'LOCKED' then
    perform app.fail('QUESTION_NOT_ACTIVE');
  end if;

  -- can the team spend right now? (competition running, team running, its own timer not yet at zero)
  v_live := (select c.status = 'RUNNING' from competition c where c.id = 1)
            and t.status = 'RUNNING' and app.now() < t.ends_at;

  v_has_t1 := exists (select 1 from hint_purchases p join hints h on h.id = p.hint_id
                       where p.team_id = p_team_id and h.question_id = p_question_id and h.tier = 1);
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'tier', h.tier,
             'cost', h.cost,
             'owned', hp.hint_id is not null,
             'purchasable', v_live and v_state in ('ACTIVE', 'PENDING_APPROVAL', 'APPROVED')
                            and hp.hint_id is null and (h.tier = 1 or v_has_t1))
           || case when hp.hint_id is not null then jsonb_build_object('body_md', h.body_md) else '{}'::jsonb end
           order by h.tier), '[]'::jsonb)
    into v_hints
    from hints h
    left join hint_purchases hp on hp.hint_id = h.id and hp.team_id = p_team_id
   where h.question_id = p_question_id;

  v_buy := jsonb_build_object('purchase_count', tq.time_purchase_count, 'extra_seconds', tq.extra_seconds,
                              'can_buy', v_live and v_state = 'ACTIVE', 'options', '[]'::jsonb);
  if v_state = 'ACTIVE' then
    select jsonb_set(v_buy, '{options}', coalesce(jsonb_agg(
             jsonb_build_object(
               'id', o.id, 'seconds', o.seconds, 'cost', o.cost, 'max_purchases', o.max_purchases,
               'purchased', coalesce(u.n, 0),
               'remaining_purchases', case when o.max_purchases is null then null
                                           else greatest(o.max_purchases - coalesce(u.n, 0), 0) end)
             order by o.display_order), '[]'::jsonb))
      into v_buy
      from question_buy_time_options o
      left join lateral (select count(*)::int as n from team_time_purchases x
                          where x.team_id = p_team_id and x.question_id = p_question_id and x.option_id = o.id) u on true
     where o.question_id = p_question_id;
  end if;

  v_out := jsonb_build_object(
    'id', qq.id,
    'theme_id', qq.theme_id,
    'theme_code', (select code from themes where id = qq.theme_id),
    'ordinal', qq.ordinal,
    'state', v_state,
    'reward_coins', qq.reward_coins,
    'time_limit_seconds', qq.time_limit_seconds,
    'hints', v_hints,
    'buy_time', v_buy);

  if v_state = 'AVAILABLE' then
    return v_out;                                     -- metadata only: the body is withheld until the team enters
  end if;

  v_out := v_out || jsonb_build_object('body_md', qq.body_md);
  if v_state = 'ACTIVE' then
    v_out := v_out || jsonb_build_object(
      'deadline', app.epoch_ms(tq.timer_deadline),
      'remaining_seconds', greatest(0, floor(extract(epoch from (tq.timer_deadline - v_qref))))::int);
  elsif v_state = 'PENDING_APPROVAL' then
    v_out := v_out || jsonb_build_object('remaining_seconds', tq.timer_remaining_seconds);
  end if;

  select * into d from answer_drafts where team_id = p_team_id and question_id = p_question_id;
  select slot into v_slot from team_members where id = d.updated_by;
  v_out := v_out || jsonb_build_object('draft', jsonb_build_object(
    'answer', coalesce(d.answer, ''), 'explanation', coalesce(d.explanation, ''),
    'version', coalesce(d.version, 0), 'updated_by_slot', v_slot,
    'updated_at', app.epoch_ms(d.updated_at)));

  -- the team's own live submission (pending, or the approved one); never another team's, never a reviewer key
  select * into s from submissions
   where team_id = p_team_id and question_id = p_question_id and status in ('PENDING', 'APPROVED')
   order by submitted_at desc limit 1;
  if found then
    select slot into v_slot from team_members where id = s.member_id;
    v_out := v_out || jsonb_build_object('submission', jsonb_build_object(
      'id', s.id, 'status', s.status, 'answer', s.answer, 'explanation', s.explanation,
      'submitted_by_slot', v_slot, 'submitted_at', app.epoch_ms(s.submitted_at),
      'reviewed_at', app.epoch_ms(s.reviewed_at), 'review_note', s.review_note,
      'reward_awarded', s.reward_awarded));
  end if;

  if v_state = 'ACTIVE' then
    select * into s from submissions
     where team_id = p_team_id and question_id = p_question_id and status = 'REJECTED'
     order by reviewed_at desc limit 1;
    if found then
      v_out := v_out || jsonb_build_object('last_rejection', jsonb_build_object(
        'note', s.review_note, 'reviewed_at', app.epoch_ms(s.reviewed_at)));
    end if;
  end if;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- buy_hint(team_id, member_id, question_id, tier, idempotency_key)                         participant, TEAM-WIDE
-- A hint bought by one member belongs to the whole team (hint_purchases is keyed by team + hint). The price is read from
-- hints.cost under the team lock and charged once. Allowed while the question is ACTIVE, PENDING_APPROVAL or APPROVED
-- (a hint is a reading aid and costs no question time); refused on LOCKED / AVAILABLE (QUESTION_NOT_ACTIVE) and
-- TIMED_OUT (QUESTION_TIMED_OUT). Tier 2 needs Tier 1 of the same question (HINT_TIER1_REQUIRED, nothing charged).
-- Buying a hint the team already owns succeeds with already_owned = true: no charge, no ledger row, no version bump.
--   Rejections: FORBIDDEN · VALIDATION_FAILED (tier / key) · COMPETITION_NOT_RUNNING · COMPETITION_PAUSED ·
--               TEAM_NOT_STARTED · TEAM_ENDED · ALREADY_SUBMITTED · NOT_FOUND (question, or no hint at that tier) ·
--               THEME_LOCKED · QUESTION_NOT_ACTIVE · QUESTION_TIMED_OUT · HINT_TIER1_REQUIRED ·
--               INSUFFICIENT_COINS {have, need}
-- Result: { replayed, already_owned, tier, hint: { tier, body_md }, question: <app.question_json>, state: <snapshot> }
-- ---------------------------------------------------------------------------------------------------------------
create function public.buy_hint(p_team_id uuid, p_member_id uuid, p_question_id smallint, p_tier smallint, p_idem_key uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_team    teams%rowtype;
  v_tq      team_questions%rowtype;
  v_hint    hints%rowtype;
  v_fp      text := 'question:' || coalesce(p_question_id::text, '') || '|tier:' || coalesce(p_tier::text, '')
                    || '|member:' || coalesce(p_member_id::text, '');
  v_replay  jsonb;
  v_now     timestamptz;
  v_balance int;
  v_owned   boolean;
  v_resp    jsonb;
begin
  perform app.assert_member(p_team_id, p_member_id);
  if p_idem_key is null then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array('idempotencyKey')));
  end if;
  if p_question_id is null or p_tier is null or p_tier not in (1, 2) then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array('tier')));
  end if;

  v_team := app.lock_team(p_team_id);
  v_replay := app.idem_lookup(p_team_id, p_idem_key, 'buy_hint', v_fp);
  if v_replay is not null then
    return v_replay || '{"replayed": true}'::jsonb;
  end if;

  perform app.assert_playable(v_team);
  perform app.settle_questions(p_team_id);

  perform 1 from questions where id = p_question_id;
  if not found then
    perform app.fail('NOT_FOUND');
  end if;
  select * into v_tq from team_questions where team_id = p_team_id and question_id = p_question_id for update;
  if not found then
    perform app.fail('THEME_LOCKED');
  end if;
  if v_tq.state = 'TIMED_OUT' then
    perform app.fail('QUESTION_TIMED_OUT');
  elsif v_tq.state not in ('ACTIVE', 'PENDING_APPROVAL', 'APPROVED') then
    perform app.fail('QUESTION_NOT_ACTIVE');                           -- LOCKED, AVAILABLE
  end if;

  select * into v_hint from hints where question_id = p_question_id and tier = p_tier;
  if not found then
    perform app.fail('NOT_FOUND');                                     -- the content has no hint at that tier
  end if;

  v_owned := exists (select 1 from hint_purchases where team_id = p_team_id and hint_id = v_hint.id);
  if not v_owned then
    if p_tier = 2 and not exists (select 1 from hint_purchases p join hints h on h.id = p.hint_id
                                   where p.team_id = p_team_id and h.question_id = p_question_id and h.tier = 1) then
      perform app.fail('HINT_TIER1_REQUIRED');                         -- nothing charged
    end if;
    if v_team.coins < v_hint.cost then
      perform app.fail('INSUFFICIENT_COINS', jsonb_build_object('have', v_team.coins, 'need', v_hint.cost));
    end if;

    v_now := app.now();
    update teams set coins = coins - v_hint.cost, state_version = state_version + 1
     where id = p_team_id returning coins into v_balance;
    if v_hint.cost > 0 then
      insert into coin_transactions (team_id, type, amount, balance_after, hint_id, question_id, member_id, created_at)
      values (p_team_id, 'HINT_PURCHASE', -v_hint.cost, v_balance, v_hint.id, p_question_id, p_member_id, v_now);
    end if;
    insert into hint_purchases (team_id, hint_id, purchased_by, cost_paid, purchased_at)
    values (p_team_id, v_hint.id, p_member_id, v_hint.cost, v_now);

    insert into audit_events (occurred_at, actor_kind, member_id, team_id, event_type, entity_type, entity_id, payload, request_id)
    values (v_now, 'MEMBER', p_member_id, p_team_id, 'HINT_PURCHASED', 'HINT', v_hint.id::text,
            jsonb_build_object('question_id', p_question_id, 'tier', p_tier, 'hint_id', v_hint.id, 'cost', v_hint.cost,
                               'balance_before', v_team.coins, 'balance_after', v_balance),
            p_idem_key);
  end if;

  v_resp := jsonb_build_object('replayed', false, 'already_owned', v_owned, 'tier', p_tier,
                               'hint', jsonb_build_object('tier', p_tier, 'body_md', v_hint.body_md),
                               'question', app.question_json(p_team_id, p_question_id),
                               'state', app.team_state_json(p_team_id, p_member_id));
  perform app.idem_store(p_team_id, p_idem_key, 'buy_hint', v_fp, v_resp);
  return v_resp;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- buy_time(team_id, member_id, question_id, option_id, expected_purchase_count, idempotency_key)    participant, TEAM-WIDE
-- Moves the deadline of THIS question for the whole team by the option's seconds and charges the option's cost. It never
-- writes teams.ends_at: the Ultimate Team Timer is not extended, and the question's playable time stays bounded by it
-- (app.question_clock), so seconds that would run past the team's end simply cannot be used.
-- expected_purchase_count is the number of purchases the caller saw; if another member bought in the meantime the answer
-- is STALE_PURCHASE_COUNT {count} and nothing is charged (two members cannot buy twice by accident). Only an ACTIVE
-- question can be extended (an overdue one was just settled to TIMED_OUT; PENDING_APPROVAL has a frozen timer).
--   Rejections: FORBIDDEN · VALIDATION_FAILED · COMPETITION_NOT_RUNNING · COMPETITION_PAUSED · TEAM_NOT_STARTED ·
--               TEAM_ENDED · ALREADY_SUBMITTED · NOT_FOUND (question / option of another question) · THEME_LOCKED ·
--               QUESTION_TIMED_OUT · QUESTION_NOT_ACTIVE · STALE_PURCHASE_COUNT {count} · TIME_PURCHASE_LIMIT ·
--               INSUFFICIENT_COINS {have, need}
-- Result: { replayed, purchase: { seq, option_id, seconds, cost }, question: <app.question_json>, state: <snapshot> }
-- ---------------------------------------------------------------------------------------------------------------
create function public.buy_time(p_team_id uuid, p_member_id uuid, p_question_id smallint, p_option_id smallint,
                                p_expected_count int, p_idem_key uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_team    teams%rowtype;
  v_tq      team_questions%rowtype;
  v_opt     question_buy_time_options%rowtype;
  v_fp      text := 'question:' || coalesce(p_question_id::text, '') || '|option:' || coalesce(p_option_id::text, '')
                    || '|expected:' || coalesce(p_expected_count::text, '') || '|member:' || coalesce(p_member_id::text, '');
  v_replay  jsonb;
  v_now     timestamptz;
  v_used    int;
  v_seq     int;
  v_balance int;
  v_old_dl  timestamptz;
  v_new_dl  timestamptz;
  v_resp    jsonb;
begin
  perform app.assert_member(p_team_id, p_member_id);
  if p_idem_key is null then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array('idempotencyKey')));
  end if;
  if p_question_id is null or p_option_id is null or p_expected_count is null or p_expected_count < 0 then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array('optionId', 'expectedPurchaseCount')));
  end if;

  v_team := app.lock_team(p_team_id);
  v_replay := app.idem_lookup(p_team_id, p_idem_key, 'buy_time', v_fp);
  if v_replay is not null then
    return v_replay || '{"replayed": true}'::jsonb;
  end if;

  perform app.assert_playable(v_team);
  perform app.settle_questions(p_team_id);

  perform 1 from questions where id = p_question_id;
  if not found then
    perform app.fail('NOT_FOUND');
  end if;
  select * into v_tq from team_questions where team_id = p_team_id and question_id = p_question_id for update;
  if not found then
    perform app.fail('THEME_LOCKED');
  end if;
  if v_tq.state = 'TIMED_OUT' then
    perform app.fail('QUESTION_TIMED_OUT');
  elsif v_tq.state <> 'ACTIVE' then
    perform app.fail('QUESTION_NOT_ACTIVE');                           -- LOCKED, AVAILABLE, PENDING_APPROVAL, APPROVED
  end if;
  if v_tq.time_purchase_count <> p_expected_count then
    perform app.fail('STALE_PURCHASE_COUNT', jsonb_build_object('count', v_tq.time_purchase_count));
  end if;

  select * into v_opt from question_buy_time_options where id = p_option_id and question_id = p_question_id;
  if not found then
    perform app.fail('NOT_FOUND');
  end if;
  select count(*) into v_used from team_time_purchases
   where team_id = p_team_id and question_id = p_question_id and option_id = p_option_id;
  if v_opt.max_purchases is not null and v_used >= v_opt.max_purchases then
    perform app.fail('TIME_PURCHASE_LIMIT');
  end if;
  if v_team.coins < v_opt.cost then
    perform app.fail('INSUFFICIENT_COINS', jsonb_build_object('have', v_team.coins, 'need', v_opt.cost));
  end if;

  v_now := app.now();
  v_seq := v_tq.time_purchase_count + 1;
  v_old_dl := v_tq.timer_deadline;
  v_new_dl := v_tq.timer_deadline + make_interval(secs => v_opt.seconds);

  update teams set coins = coins - v_opt.cost, state_version = state_version + 1
   where id = p_team_id returning coins into v_balance;                -- teams.ends_at is deliberately NOT touched
  if v_opt.cost > 0 then
    insert into coin_transactions (team_id, type, amount, balance_after, question_id, purchase_seq, member_id, created_at)
    values (p_team_id, 'TIME_PURCHASE', -v_opt.cost, v_balance, p_question_id, v_seq, p_member_id, v_now);
  end if;
  insert into team_time_purchases (team_id, question_id, seq, option_id, seconds_added, cost_paid, purchased_by, purchased_at)
  values (p_team_id, p_question_id, v_seq, p_option_id, v_opt.seconds, v_opt.cost, p_member_id, v_now);
  update team_questions
     set timer_deadline = v_new_dl, extra_seconds = extra_seconds + v_opt.seconds, time_purchase_count = v_seq
   where team_id = p_team_id and question_id = p_question_id;

  insert into audit_events (occurred_at, actor_kind, member_id, team_id, event_type, entity_type, entity_id, payload, request_id)
  values (v_now, 'MEMBER', p_member_id, p_team_id, 'TIME_PURCHASED', 'QUESTION', p_question_id::text,
          jsonb_build_object('question_id', p_question_id, 'option_id', p_option_id, 'seq', v_seq,
                             'seconds', v_opt.seconds, 'cost', v_opt.cost,
                             'old_deadline', app.epoch_ms(v_old_dl), 'new_deadline', app.epoch_ms(v_new_dl),
                             'balance_before', v_team.coins, 'balance_after', v_balance),
          p_idem_key);

  v_resp := jsonb_build_object('replayed', false,
                               'purchase', jsonb_build_object('seq', v_seq, 'option_id', p_option_id,
                                                              'seconds', v_opt.seconds, 'cost', v_opt.cost),
                               'question', app.question_json(p_team_id, p_question_id),
                               'state', app.team_state_json(p_team_id, p_member_id));
  perform app.idem_store(p_team_id, p_idem_key, 'buy_time', v_fp, v_resp);
  return v_resp;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- final_submit(team_id, member_id, confirm, idempotency_key)                                participant, TEAM-WIDE
-- The team ends its own run: status FINAL_SUBMITTED, ended_at = now, final_submitted_at/by recorded, in one UPDATE under
-- the team lock. This is the same terminal freeze as the timer reaching zero: every clock reads ended_at from then on,
-- remaining time is constant, and every participant mutation is refused by app.assert_playable (ALREADY_SUBMITTED).
-- It persists across logout / login because it is only database state. Answers waiting for review stay reviewable
-- (approve pays once; the next question does not open). Scores (final_*) are NOT computed here (B16).
-- `confirm` must be true. The losing caller of a race gets ALREADY_SUBMITTED; a team whose timer ran out first gets
-- TEAM_ENDED (it is ENDED, not FINAL_SUBMITTED); while the competition is paused: COMPETITION_PAUSED.
-- Result: { replayed, state: <snapshot> }
-- ---------------------------------------------------------------------------------------------------------------
create function public.final_submit(p_team_id uuid, p_member_id uuid, p_confirm boolean, p_idem_key uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_team    teams%rowtype;
  v_fp      text := 'member:' || coalesce(p_member_id::text, '');
  v_replay  jsonb;
  v_now     timestamptz;
  v_pending int;
  v_active  int;
  v_resp    jsonb;
begin
  perform app.assert_member(p_team_id, p_member_id);
  if p_idem_key is null then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array('idempotencyKey')));
  end if;
  if p_confirm is distinct from true then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array('confirm')));
  end if;

  v_team := app.lock_team(p_team_id);
  v_replay := app.idem_lookup(p_team_id, p_idem_key, 'final_submit', v_fp);
  if v_replay is not null then
    return v_replay || '{"replayed": true}'::jsonb;
  end if;

  perform app.assert_playable(v_team);
  perform app.settle_questions(p_team_id);

  v_now := app.now();
  select count(*) filter (where state = 'PENDING_APPROVAL'), count(*) filter (where state = 'ACTIVE')
    into v_pending, v_active
    from team_questions where team_id = p_team_id;

  update teams
     set status = 'FINAL_SUBMITTED', ended_at = v_now, final_submitted_at = v_now, final_submitted_by = p_member_id,
         state_version = state_version + 1
   where id = p_team_id;

  insert into audit_events (occurred_at, actor_kind, member_id, team_id, event_type, entity_type, entity_id, payload, request_id)
  values (v_now, 'MEMBER', p_member_id, p_team_id, 'TEAM_FINAL_SUBMITTED', 'TEAM', p_team_id::text,
          jsonb_build_object('submitted_at', app.epoch_ms(v_now), 'pending_submissions', v_pending,
                             'active_questions', v_active, 'coins', v_team.coins,
                             'remaining_seconds', greatest(0, floor(extract(epoch from (v_team.ends_at - v_now))))::int),
          p_idem_key);

  v_resp := jsonb_build_object('replayed', false, 'state', app.team_state_json(p_team_id, p_member_id));
  perform app.idem_store(p_team_id, p_idem_key, 'final_submit', v_fp, v_resp);
  return v_resp;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- disapprove_submission — re-declared with ONE change (see the header): a frozen team's returned question gets
-- `question clock + frozen remaining` instead of `now + frozen remaining`.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.disapprove_submission(p_staff_id uuid, p_submission_id uuid, p_note text, p_idem_key uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_team_id uuid;
  v_team    teams%rowtype;
  v_sub     submissions%rowtype;
  v_tq      team_questions%rowtype;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_fp      text := 'submission:' || coalesce(p_submission_id::text, '') || '|note:' || md5(coalesce(v_note, ''));
  v_replay  jsonb;
  v_comp    competition%rowtype;
  v_now     timestamptz;
  v_resp    jsonb;
begin
  if p_staff_id is null or not exists (select 1 from staff_users where id = p_staff_id and is_active) then
    perform app.fail('FORBIDDEN');
  end if;
  if p_idem_key is null then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array('idempotencyKey')));
  end if;
  if v_note is not null and length(v_note) > 500 then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array('note')));
  end if;
  select team_id into v_team_id from submissions where id = p_submission_id;
  if not found then
    perform app.fail('NOT_FOUND');
  end if;
  perform app.require_reviewer(p_staff_id, v_team_id);

  v_team := app.lock_team(v_team_id);
  v_replay := app.idem_lookup(p_staff_id, p_idem_key, 'disapprove_submission', v_fp);
  if v_replay is not null then
    return v_replay || '{"replayed": true}'::jsonb;
  end if;

  select * into v_comp from competition where id = 1;
  if v_comp.status = 'PAUSED' then
    perform app.fail('COMPETITION_PAUSED');
  elsif v_comp.status <> 'RUNNING' then
    perform app.fail('COMPETITION_NOT_RUNNING');
  end if;

  select * into v_sub from submissions where id = p_submission_id for update;
  if v_sub.status <> 'PENDING' then
    perform app.fail('SUBMISSION_NOT_PENDING');
  end if;
  v_now := app.now();
  if v_team.status = 'RUNNING' and v_now < v_team.ends_at then
    perform app.settle_questions(v_team_id);
  end if;

  select * into v_tq from team_questions where team_id = v_team_id and question_id = v_sub.question_id for update;
  if not found or v_tq.state <> 'PENDING_APPROVAL' then
    perform app.fail('SUBMISSION_NOT_PENDING');
  end if;

  update submissions
     set status = 'REJECTED', reviewed_by = p_staff_id, reviewed_at = v_now, review_note = v_note
   where id = p_submission_id;
  update team_questions
     set state = 'ACTIVE', timer_deadline = app.question_clock(v_team) + make_interval(secs => v_tq.timer_remaining_seconds),
         timer_remaining_seconds = null
   where team_id = v_team_id and question_id = v_sub.question_id;

  update teams set state_version = state_version + 1 where id = v_team_id;
  insert into audit_events (occurred_at, actor_kind, staff_id, team_id, event_type, entity_type, entity_id, payload, request_id)
  values (v_now, 'STAFF', p_staff_id, v_team_id, 'SUBMISSION_REJECTED', 'SUBMISSION', p_submission_id::text,
          jsonb_build_object('question_id', v_sub.question_id, 'has_note', v_note is not null,
                             'resumed_remaining_seconds', v_tq.timer_remaining_seconds),
          p_idem_key);

  v_resp := jsonb_build_object('replayed', false,
                               'submission', jsonb_build_object('id', p_submission_id, 'status', 'REJECTED'));
  perform app.idem_store(p_staff_id, p_idem_key, 'disapprove_submission', v_fp, v_resp);
  return v_resp;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------------------
-- (the two re-declared functions are listed too: CREATE OR REPLACE keeps their old privileges, this just states them)
revoke all on function app.question_json(uuid, smallint)                            from public, anon, authenticated;
revoke all on function public.buy_hint(uuid, uuid, smallint, smallint, uuid)        from public, anon, authenticated;
revoke all on function public.buy_time(uuid, uuid, smallint, smallint, int, uuid)   from public, anon, authenticated;
revoke all on function public.final_submit(uuid, uuid, boolean, uuid)               from public, anon, authenticated;
revoke all on function public.disapprove_submission(uuid, uuid, text, uuid)         from public, anon, authenticated;
grant execute on function app.question_json(uuid, smallint)                            to service_role;
grant execute on function public.buy_hint(uuid, uuid, smallint, smallint, uuid)        to service_role;
grant execute on function public.buy_time(uuid, uuid, smallint, smallint, int, uuid)   to service_role;
grant execute on function public.final_submit(uuid, uuid, boolean, uuid)               to service_role;
grant execute on function public.disapprove_submission(uuid, uuid, text, uuid)         to service_role;

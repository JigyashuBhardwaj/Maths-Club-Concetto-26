-- Patch B13 / migration 14 — the participant game engine, first vertical slice: team-wide theme unlock, question
-- activation (start_question), the shared draft, submission, and the minimum controlled review path (approve /
-- disapprove) that proves PENDING_APPROVAL -> APPROVED / back to ACTIVE.
--
-- Everything here REUSES the B10 engine: app.lock_team (competition share lock -> team row), app.idem_lookup /
-- app.idem_store (request_log), app.fail (P0001 + stable code), app.now(), app.epoch_ms and the audit /
-- state_version conventions (docs/STATE_MACHINE.md §1). No parallel locking or idempotency mechanism is introduced.
--
-- Two B10 functions are corrected, minimally and explicitly (see the sections below):
--   1. app.team_state_json     - the snapshot now carries theme/question detail and derives an overdue ACTIVE question as
--                                TIMED_OUT (a pure read still never writes). start_team_competition and get_team_state
--                                call it, so both pick up the richer snapshot without being redefined.
--   2. public.set_competition_status - `resume` first materialises every ACTIVE question that was already past its
--                                deadline when the pause began, so the pause shift cannot revive it. (Before B13 no
--                                question could be ACTIVE, so B10 never needed this.) The rest of the body is unchanged.
--
-- Authorisation is enforced twice (SECURITY.md §4): the API passes the ids of the session's principal, and every function
-- re-checks them (member in team; staff active and, for review, the team's Admin or a Super Admin).
--
-- Never selected by any participant function: question_keys (reference_answer, solution_notes). Question bodies are
-- returned only once a question has been activated by the team (AVAILABLE returns metadata only; LOCKED is refused).
--
-- Privileges: explicit REVOKE from PUBLIC/anon/authenticated and GRANT to service_role for every function.

-- ---------------------------------------------------------------------------------------------------------------
-- Small shared helpers
-- ---------------------------------------------------------------------------------------------------------------
create function app.assert_member(p_team_id uuid, p_member_id uuid) returns void
language plpgsql stable
set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  if p_team_id is null or p_member_id is null
     or not exists (select 1 from team_members where id = p_member_id and team_id = p_team_id) then
    perform app.fail('FORBIDDEN');                                     -- a member can only act for their own team
  end if;
end $$;

-- Competition + team gate for every participant mutation (STATE_MACHINE §1.1 steps 3-5). The caller holds the team lock
-- (app.lock_team), so the competition status read here cannot change before commit.
create function app.assert_playable(p_team teams) returns void
language plpgsql stable
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_comp competition%rowtype;
begin
  select * into v_comp from competition where id = 1;
  if v_comp.id is null or v_comp.status in ('SETUP', 'ENDED') then
    perform app.fail('COMPETITION_NOT_RUNNING');
  elsif v_comp.status = 'PAUSED' then
    perform app.fail('COMPETITION_PAUSED');
  end if;
  if p_team.status = 'NOT_STARTED' then
    perform app.fail('TEAM_NOT_STARTED');
  elsif p_team.status = 'FINAL_SUBMITTED' then
    perform app.fail('ALREADY_SUBMITTED');
  elsif p_team.status <> 'RUNNING' or app.now() >= p_team.ends_at then
    perform app.fail('TEAM_ENDED');                                    -- ENDED / DISQUALIFIED, or the team timer ran out
  end if;
end $$;

-- The instant every clock of a team reads (STATE_MACHINE §1.3): now, frozen by a pause or by the end of the team.
create function app.team_clock(p_team teams) returns timestamptz
language sql stable
set search_path = pg_catalog, public, app, pg_temp
as $$
  select least(app.now(), coalesce(p_team.ended_at, 'infinity'::timestamptz),
               (select case when c.status = 'PAUSED' then c.paused_at end from competition c where c.id = 1))
$$;

-- Question timers never run past the team's own end.
create function app.question_clock(p_team teams) returns timestamptz
language sql stable
set search_path = pg_catalog, public, app, pg_temp
as $$ select least(app.team_clock(p_team), coalesce(p_team.ends_at, 'infinity'::timestamptz)) $$;

-- Materialises overdue ACTIVE questions of one team (STATE_MACHINE §1.1 step 6): TIMED_OUT, timed_out_at = the true
-- deadline. Called under the team lock at the start of every successful participant mutation. Returns how many changed.
-- A mutation that is then REJECTED rolls this back too; reads derive the same answer (team_state_json), so nothing is lost.
create function app.settle_questions(p_team_id uuid) returns int
language plpgsql
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_ids smallint[];
  v_now timestamptz := app.now();
begin
  with s as (
    update team_questions
       set state = 'TIMED_OUT', timed_out_at = timer_deadline, timer_deadline = null
     where team_id = p_team_id and state = 'ACTIVE' and timer_deadline <= v_now
    returning question_id)
  select array_agg(question_id order by question_id) into v_ids from s;

  if v_ids is null then
    return 0;
  end if;
  update teams set state_version = state_version + 1 where id = p_team_id;
  insert into audit_events (occurred_at, actor_kind, team_id, event_type, entity_type, entity_id, payload)
  select v_now, 'SYSTEM', p_team_id, 'QUESTION_TIMED_OUT', 'QUESTION', x::text,
         jsonb_build_object('question_id', x)
    from unnest(v_ids) as x;
  return array_length(v_ids, 1);
end $$;

-- Reviewer authority for one team (approve / disapprove). An unknown staff id, a disabled account or a non-staff id is
-- FORBIDDEN; an Admin who does not own the team gets NOT_FOUND (existence is not revealed); a Super Admin may review any team.
create function app.require_reviewer(p_staff_id uuid, p_team_id uuid) returns void
language plpgsql stable
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  s staff_users%rowtype;
begin
  select * into s from staff_users where id = p_staff_id;
  if p_staff_id is null or not found or not s.is_active then
    perform app.fail('FORBIDDEN');
  end if;
  if s.role = 'SUPER_ADMIN' then
    return;
  end if;
  if s.role = 'ADMIN' and exists (select 1 from teams where id = p_team_id and admin_id = p_staff_id) then
    return;
  end if;
  perform app.fail('NOT_FOUND');
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- B10 correction 1: the authoritative snapshot, extended (same name, same signature, same pure-read contract).
--   * Every theme carries name, description, topics, difficulty and unlock_cost (the dialog needs them); an unlocked theme
--     lists its five questions, a locked theme lists none ("no question data leaves the server").
--   * A question reports reward_coins and time_limit_seconds unless it is LOCKED, `deadline` + `remaining_seconds` while
--     ACTIVE, and the frozen `remaining_seconds` while PENDING_APPROVAL. No body, draft, answer or key is ever included.
--   * An ACTIVE question whose deadline has passed (on the question clock) is reported TIMED_OUT, and its theme FAILED,
--     even before a mutation materialises it. Nothing is written.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function app.team_state_json(p_team_id uuid, p_member_id uuid) returns jsonb
language plpgsql stable
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_now    timestamptz := app.now();
  t        teams%rowtype;
  c        competition%rowtype;
  m        team_members%rowtype;
  v_ref    timestamptz;
  v_qref   timestamptz;
  v_rem    int;
  v_themes jsonb;
begin
  select * into t from teams where id = p_team_id;
  select * into c from competition where id = 1;
  select * into m from team_members where id = p_member_id and team_id = p_team_id;
  if t.id is null or m.id is null or c.id is null then
    perform app.fail('NOT_FOUND');
  end if;

  v_ref := app.team_clock(t);
  v_qref := app.question_clock(t);
  v_rem := case when t.ends_at is null then c.ultimate_seconds
                else greatest(0, floor(extract(epoch from (t.ends_at - v_ref))))::int end;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', th.id,
             'code', th.code,
             'name', th.name,
             'description', th.description,
             'topics', to_jsonb(th.topics),
             'difficulty', th.difficulty,
             'unlock_cost', th.unlock_cost,
             'status', case when tt.theme_id is null then 'LOCKED'
                            when coalesce(p.timed_out, false) then 'FAILED'
                            when coalesce(p.completed, false) then 'COMPLETED'
                            else 'IN_PROGRESS' end,
             'questions', coalesce(qs.arr, '[]'::jsonb))
           order by th.display_order), '[]'::jsonb)
    into v_themes
    from themes th
    left join team_themes tt on tt.team_id = p_team_id and tt.theme_id = th.id
    left join lateral (
      select count(*) filter (where q.state = 'APPROVED') = 5 as completed,
             bool_or(q.state = 'TIMED_OUT' or (q.state = 'ACTIVE' and q.timer_deadline <= v_qref)) as timed_out
        from team_questions q
       where q.team_id = p_team_id and q.theme_id = th.id) p on true
    left join lateral (
      select jsonb_agg(
               jsonb_build_object('id', q.question_id, 'ordinal', q.ordinal, 'state', e.state)
               || case when e.state <> 'LOCKED'
                       then jsonb_build_object('reward_coins', qq.reward_coins,
                                               'time_limit_seconds', qq.time_limit_seconds)
                       else '{}'::jsonb end
               || case when e.state = 'ACTIVE'
                       then jsonb_build_object('deadline', app.epoch_ms(q.timer_deadline),
                                               'remaining_seconds',
                                               greatest(0, floor(extract(epoch from (q.timer_deadline - v_qref))))::int)
                       when e.state = 'PENDING_APPROVAL'
                       then jsonb_build_object('remaining_seconds', q.timer_remaining_seconds)
                       else '{}'::jsonb end
               order by q.ordinal) as arr
        from team_questions q
        join questions qq on qq.id = q.question_id
        cross join lateral (select case when q.state = 'ACTIVE' and q.timer_deadline <= v_qref
                                        then 'TIMED_OUT' else q.state::text end as state) e
       where q.team_id = p_team_id and q.theme_id = th.id) qs on true;

  return jsonb_build_object(
    'server_now', app.epoch_ms(v_now),
    'state_version', t.state_version,
    'competition', jsonb_build_object('status', c.status),
    'me', jsonb_build_object('member_id', m.id, 'slot', m.slot, 'team_id', t.id,
                             'team_code', t.team_code, 'team_name', t.name),
    'team', jsonb_build_object(
      'status', t.status,
      'coins', t.coins,
      'started_at', app.epoch_ms(t.started_at),
      'ends_at', app.epoch_ms(t.ends_at),
      'ended_at', app.epoch_ms(t.ended_at),
      'final_submitted_at', app.epoch_ms(t.final_submitted_at),
      'duration_seconds', c.ultimate_seconds,
      'remaining_seconds', v_rem,
      'expired', (t.status = 'RUNNING' and v_ref >= t.ends_at)),
    'themes', v_themes);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- app.question_json — one question as the team sees it. Participant-safe by construction: it selects from questions
-- (never question_keys), the team's own team_questions / answer_drafts / submissions rows, and nothing of any other team.
--   LOCKED            -> refused (THEME_LOCKED if the theme is not unlocked, QUESTION_NOT_ACTIVE otherwise); no body
--   AVAILABLE         -> metadata only: reward, time allowed. NO body, NO draft
--   ACTIVE / PENDING_APPROVAL / APPROVED / TIMED_OUT -> the body, the shared draft, the team's own submission,
--                        and (ACTIVE only) the note of the last rejection
-- ---------------------------------------------------------------------------------------------------------------
create function app.question_json(p_team_id uuid, p_question_id smallint) returns jsonb
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

  v_out := jsonb_build_object(
    'id', qq.id,
    'theme_id', qq.theme_id,
    'theme_code', (select code from themes where id = qq.theme_id),
    'ordinal', qq.ordinal,
    'state', v_state,
    'reward_coins', qq.reward_coins,
    'time_limit_seconds', qq.time_limit_seconds);

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
-- unlock_theme(team_id, member_id, theme_id, idempotency_key)                       participant, TEAM-WIDE
-- One row in team_themes (team_id + theme_id) is the unlock for every member. Under the team lock: charge the
-- configured unlock_cost once, write the THEME_UNLOCK ledger row, create the five question rows (Q1 AVAILABLE with NO
-- timer, Q2..Q5 LOCKED). Two members unlocking together: the second waits on the lock, finds the row and gets
-- THEME_ALREADY_UNLOCKED with no charge. The unique ledger index ctx_theme and the team_themes key are the final guards.
--   Rejections: FORBIDDEN · COMPETITION_NOT_RUNNING · COMPETITION_PAUSED · TEAM_NOT_STARTED · TEAM_ENDED ·
--               ALREADY_SUBMITTED · NOT_FOUND (theme) · THEME_ALREADY_UNLOCKED · INSUFFICIENT_COINS {have, need}
-- Result: { replayed, theme_id, state: <team snapshot> }
-- ---------------------------------------------------------------------------------------------------------------
create function public.unlock_theme(p_team_id uuid, p_member_id uuid, p_theme_id smallint, p_idem_key uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_team    teams%rowtype;
  v_theme   themes%rowtype;
  v_fp      text := 'theme:' || coalesce(p_theme_id::text, '') || '|member:' || coalesce(p_member_id::text, '');
  v_replay  jsonb;
  v_now     timestamptz;
  v_balance int;
  v_resp    jsonb;
begin
  perform app.assert_member(p_team_id, p_member_id);
  if p_idem_key is null then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array('idempotencyKey')));
  end if;

  v_team := app.lock_team(p_team_id);                                  -- competition (share) -> team (update)
  v_replay := app.idem_lookup(p_team_id, p_idem_key, 'unlock_theme', v_fp);
  if v_replay is not null then
    return v_replay || '{"replayed": true}'::jsonb;
  end if;

  perform app.assert_playable(v_team);
  perform app.settle_questions(p_team_id);

  select * into v_theme from themes where id = p_theme_id;
  if not found then
    perform app.fail('NOT_FOUND');
  end if;
  if exists (select 1 from team_themes where team_id = p_team_id and theme_id = p_theme_id) then
    perform app.fail('THEME_ALREADY_UNLOCKED');                        -- no charge
  end if;
  if v_team.coins < v_theme.unlock_cost then
    perform app.fail('INSUFFICIENT_COINS', jsonb_build_object('have', v_team.coins, 'need', v_theme.unlock_cost));
  end if;

  v_now := app.now();
  update teams set coins = coins - v_theme.unlock_cost, state_version = state_version + 1
   where id = p_team_id returning coins into v_balance;
  if v_theme.unlock_cost > 0 then
    insert into coin_transactions (team_id, type, amount, balance_after, theme_id, member_id, created_at)
    values (p_team_id, 'THEME_UNLOCK', -v_theme.unlock_cost, v_balance, p_theme_id, p_member_id, v_now);
  end if;
  insert into team_themes (team_id, theme_id, unlocked_by, unlocked_at, cost_paid)
  values (p_team_id, p_theme_id, p_member_id, v_now, v_theme.unlock_cost);
  insert into team_questions (team_id, question_id, theme_id, ordinal, state)
  select p_team_id, q.id, q.theme_id, q.ordinal,
         (case when q.ordinal = 1 then 'AVAILABLE' else 'LOCKED' end)::question_state
    from questions q where q.theme_id = p_theme_id;

  insert into audit_events (occurred_at, actor_kind, member_id, team_id, event_type, entity_type, entity_id, payload, request_id)
  values (v_now, 'MEMBER', p_member_id, p_team_id, 'THEME_UNLOCKED', 'THEME', p_theme_id::text,
          jsonb_build_object('theme_id', p_theme_id, 'code', v_theme.code, 'cost', v_theme.unlock_cost,
                             'balance_before', v_team.coins, 'balance_after', v_balance),
          p_idem_key);

  v_resp := jsonb_build_object('replayed', false, 'theme_id', p_theme_id,
                               'state', app.team_state_json(p_team_id, p_member_id));
  perform app.idem_store(p_team_id, p_idem_key, 'unlock_theme', v_fp, v_resp);
  return v_resp;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- start_question(team_id, member_id, question_id, idempotency_key)        participant: ENTERING a question
-- There is no Start button: the question page calls this when it opens. AVAILABLE -> ACTIVE exactly once
-- (activated_at = app.now(), timer_deadline = now + time_limit_seconds); a second member, a retry or a refresh finds
-- it ACTIVE and gets the same deadline back (never restarted, never extended). PENDING_APPROVAL / APPROVED are
-- returned as they are. LOCKED and TIMED_OUT are refused (QUESTION_NOT_AVAILABLE). Touches no other question's timer
-- and not the team's ends_at.
-- Result: { replayed, started_now, question: <app.question_json> }
-- ---------------------------------------------------------------------------------------------------------------
create function public.start_question(p_team_id uuid, p_member_id uuid, p_question_id smallint, p_idem_key uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_team    teams%rowtype;
  v_q       questions%rowtype;
  v_tq      team_questions%rowtype;
  v_fp      text := 'question:' || coalesce(p_question_id::text, '') || '|member:' || coalesce(p_member_id::text, '');
  v_replay  jsonb;
  v_now     timestamptz;
  v_started boolean := false;
  v_resp    jsonb;
begin
  perform app.assert_member(p_team_id, p_member_id);
  if p_idem_key is null then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array('idempotencyKey')));
  end if;

  v_team := app.lock_team(p_team_id);
  v_replay := app.idem_lookup(p_team_id, p_idem_key, 'start_question', v_fp);
  if v_replay is not null then
    return v_replay || '{"replayed": true}'::jsonb;
  end if;

  perform app.assert_playable(v_team);
  perform app.settle_questions(p_team_id);

  select * into v_q from questions where id = p_question_id;
  if not found then
    perform app.fail('NOT_FOUND');
  end if;
  select * into v_tq from team_questions where team_id = p_team_id and question_id = p_question_id for update;
  if not found then
    perform app.fail('THEME_LOCKED');
  end if;

  if v_tq.state = 'AVAILABLE' then
    v_now := app.now();
    update team_questions
       set state = 'ACTIVE', activated_at = v_now,
           timer_deadline = v_now + make_interval(secs => v_q.time_limit_seconds)
     where team_id = p_team_id and question_id = p_question_id;
    update teams set state_version = state_version + 1 where id = p_team_id;
    insert into audit_events (occurred_at, actor_kind, member_id, team_id, event_type, entity_type, entity_id, payload, request_id)
    values (v_now, 'MEMBER', p_member_id, p_team_id, 'QUESTION_STARTED', 'QUESTION', p_question_id::text,
            jsonb_build_object('question_id', p_question_id, 'activated_at', app.epoch_ms(v_now),
                               'deadline', app.epoch_ms(v_now + make_interval(secs => v_q.time_limit_seconds)),
                               'time_limit_seconds', v_q.time_limit_seconds),
            p_idem_key);
    v_started := true;
  elsif v_tq.state not in ('ACTIVE', 'PENDING_APPROVAL', 'APPROVED') then
    perform app.fail('QUESTION_NOT_AVAILABLE');                        -- LOCKED, or TIMED_OUT
  end if;

  v_resp := jsonb_build_object('replayed', false, 'started_now', v_started,
                               'question', app.question_json(p_team_id, p_question_id));
  perform app.idem_store(p_team_id, p_idem_key, 'start_question', v_fp, v_resp);
  return v_resp;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- get_question_for_team(team_id, member_id, question_id)         participant: a read, no lock, no write
-- ---------------------------------------------------------------------------------------------------------------
create function public.get_question_for_team(p_team_id uuid, p_member_id uuid, p_question_id smallint) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  t teams%rowtype;
begin
  perform app.assert_member(p_team_id, p_member_id);
  select * into t from teams where id = p_team_id;
  return jsonb_build_object('server_now', app.epoch_ms(app.now()), 'state_version', t.state_version,
                            'question', app.question_json(p_team_id, p_question_id));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- save_draft(team_id, member_id, question_id, answer, expected_version, explanation)       participant: autosave
-- ONE shared draft per team + question (answer_drafts). A write must name the version it was based on: a teammate who
-- saved in between makes it STALE_DRAFT (nothing is written, so one member's text can never silently replace another's).
-- Retrying a save that already succeeded (same text) returns the current version instead of an error. Allowed only
-- while the question is ACTIVE. It takes the team lock (so it cannot interleave with a submit or a timeout), but writes
-- no state_version bump and no audit row (too chatty; the snapshot does not contain drafts).
-- Result: { version, updated_by_slot, updated_at }
-- ---------------------------------------------------------------------------------------------------------------
create function public.save_draft(p_team_id uuid, p_member_id uuid, p_question_id smallint, p_answer text,
                                  p_expected_version int, p_explanation text default '') returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_team teams%rowtype;
  v_tq   team_questions%rowtype;
  v_now  timestamptz;
  d      answer_drafts%rowtype;
  v_fields text[] := '{}';
  v_slot smallint;
begin
  perform app.assert_member(p_team_id, p_member_id);
  if p_answer is null or length(p_answer) > 10000 then v_fields := array_append(v_fields, 'answer'::text); end if;
  if p_explanation is null or length(p_explanation) > 10000 then v_fields := array_append(v_fields, 'explanation'::text); end if;
  if p_expected_version is null or p_expected_version < 0 then v_fields := array_append(v_fields, 'expectedVersion'::text); end if;
  if array_length(v_fields, 1) > 0 then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', to_jsonb(v_fields)));
  end if;

  v_team := app.lock_team(p_team_id);
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

  v_now := app.now();
  select * into d from answer_drafts where team_id = p_team_id and question_id = p_question_id for update;
  if not found then
    if p_expected_version <> 0 then
      perform app.fail('STALE_DRAFT', jsonb_build_object('version', 0));
    end if;
    insert into answer_drafts (team_id, question_id, answer, explanation, version, updated_by, updated_at)
    values (p_team_id, p_question_id, p_answer, p_explanation, 1, p_member_id, v_now)
    returning * into d;
  elsif d.version <> p_expected_version then
    if d.answer = p_answer and d.explanation = p_explanation then
      null;                                                            -- an earlier identical save already won
    else
      perform app.fail('STALE_DRAFT', jsonb_build_object('version', d.version));
    end if;
  else
    update answer_drafts
       set answer = p_answer, explanation = p_explanation, version = version + 1,
           updated_by = p_member_id, updated_at = v_now
     where team_id = p_team_id and question_id = p_question_id
    returning * into d;
  end if;

  select slot into v_slot from team_members where id = d.updated_by;
  return jsonb_build_object('version', d.version, 'updated_by_slot', v_slot, 'updated_at', app.epoch_ms(d.updated_at));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- submit_answer(team_id, member_id, question_id, answer, explanation, idempotency_key)      participant
-- ACTIVE and before the deadline -> a PENDING submission by THIS member, the question timer FROZEN
-- (timer_remaining_seconds = floor(deadline - now), timer_deadline = NULL, PENDING_APPROVAL). The team timer keeps
-- running (teams.ends_at is untouched). The shared draft becomes the submitted text (STATE_MACHINE §5.6) and is kept.
-- Whichever of submit and timeout takes the team lock first wins: after the deadline the question is TIMED_OUT and the
-- submit is QUESTION_TIMED_OUT. One pending submission per team + question (partial unique index = backstop).
--   Rejections: FORBIDDEN · gates (as unlock_theme) · VALIDATION_FAILED {fields} · NOT_FOUND · THEME_LOCKED ·
--               QUESTION_NOT_ACTIVE · QUESTION_TIMED_OUT · SUBMISSION_PENDING
-- Result: { replayed, question: <app.question_json> }
-- ---------------------------------------------------------------------------------------------------------------
create function public.submit_answer(p_team_id uuid, p_member_id uuid, p_question_id smallint, p_answer text,
                                     p_explanation text, p_idem_key uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_team   teams%rowtype;
  v_tq     team_questions%rowtype;
  v_fp     text := 'question:' || coalesce(p_question_id::text, '') || '|member:' || coalesce(p_member_id::text, '')
                   || '|text:' || md5(coalesce(p_answer, '') || chr(1) || coalesce(p_explanation, ''));
  v_replay jsonb;
  v_now    timestamptz;
  v_fields text[] := '{}';
  v_sub    uuid;
  v_rem    int;
  v_resp   jsonb;
begin
  perform app.assert_member(p_team_id, p_member_id);
  if p_idem_key is null then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array('idempotencyKey')));
  end if;
  if p_answer is null or length(btrim(p_answer)) = 0 or length(p_answer) > 10000 then
    v_fields := array_append(v_fields, 'answer'::text);
  end if;
  if p_explanation is null or length(p_explanation) > 10000 then
    v_fields := array_append(v_fields, 'explanation'::text);
  end if;
  if array_length(v_fields, 1) > 0 then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', to_jsonb(v_fields)));
  end if;

  v_team := app.lock_team(p_team_id);
  v_replay := app.idem_lookup(p_team_id, p_idem_key, 'submit_answer', v_fp);
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
  if v_tq.state = 'PENDING_APPROVAL' then
    perform app.fail('SUBMISSION_PENDING');
  elsif v_tq.state = 'TIMED_OUT' then
    perform app.fail('QUESTION_TIMED_OUT');
  elsif v_tq.state <> 'ACTIVE' then
    perform app.fail('QUESTION_NOT_ACTIVE');                           -- LOCKED, AVAILABLE, APPROVED
  end if;

  v_now := app.now();
  insert into submissions (team_id, question_id, member_id, answer, explanation, status, submitted_at)
  values (p_team_id, p_question_id, p_member_id, p_answer, p_explanation, 'PENDING', v_now)
  returning id into v_sub;

  v_rem := greatest(0, floor(extract(epoch from (v_tq.timer_deadline - v_now))))::int;
  update team_questions
     set state = 'PENDING_APPROVAL', timer_remaining_seconds = v_rem, timer_deadline = null
   where team_id = p_team_id and question_id = p_question_id;

  insert into answer_drafts (team_id, question_id, answer, explanation, version, updated_by, updated_at)
  values (p_team_id, p_question_id, p_answer, p_explanation, 1, p_member_id, v_now)
  on conflict (team_id, question_id) do update
     set answer = excluded.answer, explanation = excluded.explanation,
         version = answer_drafts.version + 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at;

  update teams set state_version = state_version + 1 where id = p_team_id;
  insert into audit_events (occurred_at, actor_kind, member_id, team_id, event_type, entity_type, entity_id, payload, request_id)
  values (v_now, 'MEMBER', p_member_id, p_team_id, 'ANSWER_SUBMITTED', 'SUBMISSION', v_sub::text,
          jsonb_build_object('question_id', p_question_id, 'submission_id', v_sub, 'frozen_remaining_seconds', v_rem),
          p_idem_key);

  v_resp := jsonb_build_object('replayed', false, 'question', app.question_json(p_team_id, p_question_id));
  perform app.idem_store(p_team_id, p_idem_key, 'submit_answer', v_fp, v_resp);
  return v_resp;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- approve_submission(staff_id, submission_id, idempotency_key)        the minimum controlled review path (B13)
-- Caller: an active Admin who owns the team, or an active Super Admin (an Admin of another team gets NOT_FOUND).
-- The TEAM is locked first (found through the submission), then the submission is re-read: if it is no longer PENDING
-- the answer is SUBMISSION_NOT_PENDING (two reviewers, a retry with a new key). Effects, all in this transaction:
--   submission APPROVED (reward_awarded = questions.reward_coins: fixed, never chosen) · question APPROVED ·
--   coins += reward with ONE QUESTION_REWARD ledger row (unique index ctx_reward is the backstop) ·
--   the NEXT question of the theme LOCKED -> ACTIVE with its own deadline = now + its time_limit_seconds
--   (only if the team is still running; after the team's end the next question stays LOCKED).
-- Requires the competition to be RUNNING. The full review product (queue, UI, UFM) is a later milestone.
-- ---------------------------------------------------------------------------------------------------------------
create function public.approve_submission(p_staff_id uuid, p_submission_id uuid, p_idem_key uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_team_id  uuid;
  v_team     teams%rowtype;
  v_sub      submissions%rowtype;
  v_tq       team_questions%rowtype;
  v_q        questions%rowtype;
  v_fp       text := 'submission:' || coalesce(p_submission_id::text, '');
  v_replay   jsonb;
  v_comp     competition%rowtype;
  v_now      timestamptz;
  v_live     boolean;
  v_balance  int;
  v_next     smallint;
  v_resp     jsonb;
begin
  if p_staff_id is null or not exists (select 1 from staff_users where id = p_staff_id and is_active) then
    perform app.fail('FORBIDDEN');
  end if;
  if p_idem_key is null then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array('idempotencyKey')));
  end if;
  select team_id into v_team_id from submissions where id = p_submission_id;
  if not found then
    perform app.fail('NOT_FOUND');
  end if;
  perform app.require_reviewer(p_staff_id, v_team_id);

  v_team := app.lock_team(v_team_id);                                  -- team first, then re-read the submission
  v_replay := app.idem_lookup(p_staff_id, p_idem_key, 'approve_submission', v_fp);
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
  v_live := v_team.status = 'RUNNING' and v_now < v_team.ends_at;
  if v_live then
    perform app.settle_questions(v_team_id);
  end if;

  select * into v_tq from team_questions where team_id = v_team_id and question_id = v_sub.question_id for update;
  if not found or v_tq.state <> 'PENDING_APPROVAL' then
    perform app.fail('SUBMISSION_NOT_PENDING');                        -- invariant: a PENDING submission <=> PENDING_APPROVAL
  end if;
  select * into v_q from questions where id = v_sub.question_id;

  update submissions
     set status = 'APPROVED', reviewed_by = p_staff_id, reviewed_at = v_now, reward_awarded = v_q.reward_coins
   where id = p_submission_id;
  update team_questions
     set state = 'APPROVED', approved_at = v_now, timer_remaining_seconds = null
   where team_id = v_team_id and question_id = v_sub.question_id;

  update teams set coins = coins + v_q.reward_coins, state_version = state_version + 1
   where id = v_team_id returning coins into v_balance;
  if v_q.reward_coins > 0 then
    insert into coin_transactions (team_id, type, amount, balance_after, question_id, submission_id, member_id, staff_id, created_at)
    values (v_team_id, 'QUESTION_REWARD', v_q.reward_coins, v_balance, v_sub.question_id, p_submission_id, v_sub.member_id, p_staff_id, v_now);
  end if;

  if v_q.ordinal < 5 and v_live then
    update team_questions tq
       set state = 'ACTIVE', activated_at = v_now,
           timer_deadline = v_now + make_interval(secs => nq.time_limit_seconds)
      from questions nq
     where tq.team_id = v_team_id and tq.theme_id = v_q.theme_id and tq.ordinal = v_q.ordinal + 1
       and tq.state = 'LOCKED' and nq.id = tq.question_id
    returning tq.question_id into v_next;
  end if;

  insert into audit_events (occurred_at, actor_kind, staff_id, team_id, event_type, entity_type, entity_id, payload, request_id)
  values (v_now, 'STAFF', p_staff_id, v_team_id, 'SUBMISSION_APPROVED', 'SUBMISSION', p_submission_id::text,
          jsonb_build_object('question_id', v_sub.question_id, 'reward', v_q.reward_coins,
                             'balance_after', v_balance, 'next_question_id', v_next),
          p_idem_key);

  v_resp := jsonb_build_object('replayed', false,
                               'submission', jsonb_build_object('id', p_submission_id, 'status', 'APPROVED'),
                               'reward_awarded', v_q.reward_coins,
                               'next_question_activated', v_next is not null);
  perform app.idem_store(p_staff_id, p_idem_key, 'approve_submission', v_fp, v_resp);
  return v_resp;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- disapprove_submission(staff_id, submission_id, note, idempotency_key)
-- Same authority, lock order and gates as approve. The submission becomes REJECTED (the row is kept), the question goes
-- back to ACTIVE with deadline = now + the frozen remaining seconds, and the shared draft is left untouched so the team
-- can study its mistake and resubmit (locked UI-2.1 rule). No coins move.
-- ---------------------------------------------------------------------------------------------------------------
create function public.disapprove_submission(p_staff_id uuid, p_submission_id uuid, p_note text, p_idem_key uuid) returns jsonb
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
     set state = 'ACTIVE', timer_deadline = v_now + make_interval(secs => v_tq.timer_remaining_seconds),
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
-- list_pending_submissions(staff_id)                          reviewer: the thin B13 review queue (read only)
-- PENDING submissions of the caller's teams (an Admin: the teams they own; a Super Admin: every team), oldest first,
-- at most 100. For manual testing of the approval path only; the full Admin review product is a later milestone.
-- The question body is included so the reviewer sees what was asked; question_keys are NOT (a later patch).
-- ---------------------------------------------------------------------------------------------------------------
create function public.list_pending_submissions(p_staff_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  s     staff_users%rowtype;
  v_out jsonb;
begin
  select * into s from staff_users where id = p_staff_id;
  if p_staff_id is null or not found or not s.is_active then
    perform app.fail('FORBIDDEN');
  end if;
  select coalesce(jsonb_agg(x.j order by x.at, x.id), '[]'::jsonb) into v_out
    from (
      select sub.submitted_at as at, sub.id,
             jsonb_build_object(
               'id', sub.id,
               'team_code', t.team_code,
               'team_name', t.name,
               'theme_code', th.code,
               'ordinal', q.ordinal,
               'question_id', q.id,
               'body_md', q.body_md,
               'answer', sub.answer,
               'explanation', sub.explanation,
               'submitted_by_slot', m.slot,
               'submitted_at', app.epoch_ms(sub.submitted_at)) as j
        from submissions sub
        join teams t on t.id = sub.team_id
        join questions q on q.id = sub.question_id
        join themes th on th.id = q.theme_id
        left join team_members m on m.id = sub.member_id
       where sub.status = 'PENDING'
         and (s.role = 'SUPER_ADMIN' or t.admin_id = p_staff_id)
       order by sub.submitted_at, sub.id
       limit 100
    ) x;
  return jsonb_build_object('server_now', app.epoch_ms(app.now()), 'submissions', v_out);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- B10 correction 2: set_competition_status, identical to migration 12 except for the one marked statement in `resume`.
-- (CREATE OR REPLACE keeps the function's existing privileges; they are restated below anyway.)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.set_competition_status(p_staff_id uuid, p_action text, p_idem_key uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_now     timestamptz := app.now();
  v_comp    competition%rowtype;
  v_from    competition_status;
  v_to      competition_status;
  v_fp      text := 'action:' || coalesce(p_action, '');
  v_replay  jsonb;
  v_delta   interval := interval '0';
  v_shifted int := 0;
  v_ended   int := 0;
  v_ended_at timestamptz;
  v_team    teams%rowtype;
  v_teams   int;
  v_resp    jsonb;
begin
  if p_action is null or p_action not in ('open', 'pause', 'resume', 'end') then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array('action')));
  end if;
  perform app.require_super_admin(p_staff_id);

  select * into v_comp from competition where id = 1 for update;     -- lock order: competition first
  if not found then
    perform app.fail('NOT_FOUND');
  end if;

  v_replay := app.idem_lookup(p_staff_id, p_idem_key, 'set_competition_status', v_fp);
  if v_replay is not null then
    return v_replay || '{"replayed": true}'::jsonb;
  end if;

  v_from := v_comp.status;
  v_to := case p_action when 'pause' then 'PAUSED' when 'end' then 'ENDED' else 'RUNNING' end::competition_status;

  if v_from = v_to then
    -- already there: idempotent no-op
    v_resp := jsonb_build_object('replayed', false, 'changed', false, 'action', p_action, 'from', v_from, 'to', v_to,
                                 'competition', app.competition_json());
    perform app.idem_store(p_staff_id, p_idem_key, 'set_competition_status', v_fp, v_resp);
    return v_resp;
  end if;

  if not ((p_action = 'open' and v_from = 'SETUP')
       or (p_action = 'pause' and v_from = 'RUNNING')
       or (p_action = 'resume' and v_from = 'PAUSED')
       or (p_action = 'end' and v_from in ('RUNNING', 'PAUSED'))) then
    perform app.fail('INVALID_COMPETITION_TRANSITION', jsonb_build_object('from', v_from, 'action', p_action));
  end if;

  if p_action = 'open' then
    -- the 10 × 5 shape is proved per theme, not only by the totals (10 themes and 50 questions in total could still be 4 + 6)
    if (select count(*) from teams) < 1
       or (select count(*) from themes) <> 10
       or (select count(*) from questions) <> 50
       or exists (select 1 from themes t where (select count(*) from questions q where q.theme_id = t.id) <> 5) then
      perform app.fail('COMPETITION_NOT_READY', jsonb_build_object(
        'teams', (select count(*) from teams), 'themes', (select count(*) from themes),
        'questions', (select count(*) from questions),
        'themes_not_five', (select count(*) from themes t where (select count(*) from questions q where q.theme_id = t.id) <> 5)));
    end if;
    update competition set status = 'RUNNING', opened_at = v_now where id = 1;

  elsif p_action = 'pause' then
    update competition set status = 'PAUSED', paused_at = v_now where id = 1;

  else
    perform 1 from teams order by id for update;                      -- then every team, in id order

    if p_action = 'resume' then
      v_delta := greatest(v_now - v_comp.paused_at, interval '0');
      -- A team whose scheduled end was already behind it when the pause began must not be revived by the shift.
      for v_team in select * from teams where status = 'RUNNING' and ends_at <= v_comp.paused_at order by id loop
        perform app.expire_team(v_team.id, 'TIMER', v_team.ends_at, p_staff_id);
        v_ended := v_ended + 1;
      end loop;
      -- B13: an ACTIVE question already past its deadline when the pause began is TIMED_OUT at that deadline; the shift
      -- below must not revive it (questions can be ACTIVE from B13 on; reads already report it as TIMED_OUT).
      update team_questions q
         set state = 'TIMED_OUT', timed_out_at = q.timer_deadline, timer_deadline = null
        from teams t
       where q.team_id = t.id and t.status = 'RUNNING' and q.state = 'ACTIVE' and q.timer_deadline <= v_comp.paused_at;
      update team_questions q
         set timer_deadline = q.timer_deadline + v_delta
        from teams t
       where q.team_id = t.id and t.status = 'RUNNING' and q.state = 'ACTIVE';
      with s as (update teams set ends_at = ends_at + v_delta where status = 'RUNNING' returning 1)
        select count(*) into v_shifted from s;
      update competition set status = 'RUNNING', paused_at = null where id = 1;

    else  -- end
      v_ended_at := case when v_from = 'PAUSED' then v_comp.paused_at else v_now end;
      for v_team in select * from teams where status = 'RUNNING' order by id loop
        perform app.expire_team(v_team.id, 'COMPETITION_ENDED', v_ended_at, p_staff_id);
        v_ended := v_ended + 1;
      end loop;
      update competition set status = 'ENDED', ended_at = v_now, paused_at = null where id = 1;
    end if;
  end if;

  update competition set state_version = state_version + 1 where id = 1;
  update teams set state_version = state_version + 1;
  select count(*) into v_teams from teams;

  insert into audit_events (occurred_at, actor_kind, staff_id, event_type, entity_type, entity_id, payload, request_id)
  values (v_now, 'STAFF', p_staff_id, 'COMPETITION_STATUS_CHANGED', 'COMPETITION', '1',
          jsonb_build_object('from', v_from, 'to', v_to, 'action', p_action,
                             'paused_seconds', case when p_action = 'resume' then floor(extract(epoch from v_delta)) end,
                             'teams_shifted', case when p_action = 'resume' then v_shifted end,
                             'teams_ended', case when p_action in ('resume', 'end') then v_ended end),
          p_idem_key);

  v_resp := jsonb_build_object(
    'replayed', false, 'changed', true, 'action', p_action, 'from', v_from, 'to', v_to,
    'paused_seconds', case when p_action = 'resume' then floor(extract(epoch from v_delta)) end,
    'teams_shifted', v_shifted, 'teams_ended', v_ended, 'teams_total', v_teams,
    'competition', app.competition_json());
  perform app.idem_store(p_staff_id, p_idem_key, 'set_competition_status', v_fp, v_resp);
  return v_resp;
end $$;


-- ---------------------------------------------------------------------------------------------------------------
-- Privileges. Explicit for every function above: no PUBLIC, no anon, no authenticated; service_role only.
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function app.assert_member(uuid, uuid)                                       from public, anon, authenticated;
revoke all on function app.assert_playable(teams)                                          from public, anon, authenticated;
revoke all on function app.team_clock(teams)                                               from public, anon, authenticated;
revoke all on function app.question_clock(teams)                                           from public, anon, authenticated;
revoke all on function app.settle_questions(uuid)                                          from public, anon, authenticated;
revoke all on function app.require_reviewer(uuid, uuid)                                    from public, anon, authenticated;
revoke all on function app.team_state_json(uuid, uuid)                                     from public, anon, authenticated;
revoke all on function app.question_json(uuid, smallint)                                   from public, anon, authenticated;
revoke all on function public.set_competition_status(uuid, text, uuid)                     from public, anon, authenticated;
revoke all on function public.unlock_theme(uuid, uuid, smallint, uuid)                     from public, anon, authenticated;
revoke all on function public.start_question(uuid, uuid, smallint, uuid)                   from public, anon, authenticated;
revoke all on function public.get_question_for_team(uuid, uuid, smallint)                  from public, anon, authenticated;
revoke all on function public.save_draft(uuid, uuid, smallint, text, int, text)            from public, anon, authenticated;
revoke all on function public.submit_answer(uuid, uuid, smallint, text, text, uuid)        from public, anon, authenticated;
revoke all on function public.approve_submission(uuid, uuid, uuid)                         from public, anon, authenticated;
revoke all on function public.disapprove_submission(uuid, uuid, text, uuid)                from public, anon, authenticated;
revoke all on function public.list_pending_submissions(uuid)                               from public, anon, authenticated;

grant execute on function app.assert_member(uuid, uuid)                                       to service_role;
grant execute on function app.assert_playable(teams)                                          to service_role;
grant execute on function app.team_clock(teams)                                               to service_role;
grant execute on function app.question_clock(teams)                                           to service_role;
grant execute on function app.settle_questions(uuid)                                          to service_role;
grant execute on function app.require_reviewer(uuid, uuid)                                    to service_role;
grant execute on function app.team_state_json(uuid, uuid)                                     to service_role;
grant execute on function app.question_json(uuid, smallint)                                   to service_role;
grant execute on function public.set_competition_status(uuid, text, uuid)                     to service_role;
grant execute on function public.unlock_theme(uuid, uuid, smallint, uuid)                     to service_role;
grant execute on function public.start_question(uuid, uuid, smallint, uuid)                   to service_role;
grant execute on function public.get_question_for_team(uuid, uuid, smallint)                  to service_role;
grant execute on function public.save_draft(uuid, uuid, smallint, text, int, text)            to service_role;
grant execute on function public.submit_answer(uuid, uuid, smallint, text, text, uuid)        to service_role;
grant execute on function public.approve_submission(uuid, uuid, uuid)                         to service_role;
grant execute on function public.disapprove_submission(uuid, uuid, text, uuid)                to service_role;
grant execute on function public.list_pending_submissions(uuid)                               to service_role;

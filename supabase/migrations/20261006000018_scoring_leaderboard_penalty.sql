-- Patch B / migration 18 — Phase B16: scoring, live leaderboard and the UFM penalty.
--
-- WHAT THIS DOES
--   1. Score (STATE_MACHINE / SCORING_AND_LEADERBOARD): a DERIVED value, never a stored live column and never written per
--      minute:
--          score = completed_themes × 500 + solved_questions × 100 + remaining_coins − minutes_taken × 5
--          minutes_taken = round((timer_seconds − remaining_seconds) / 60)       (elapsed time of THIS team's allowance;
--                          for a 4 h team it is exactly round(240 − remaining minutes); a 2 h legacy team is not charged
--                          for the hours it never had). It may be negative.
--      While a team is playing (or has not started) every read derives the score from the live tables (app.team_scores).
--   2. Freeze: when a team becomes terminal — Final Submit (public.final_submit) OR the timer / competition end
--      (app.expire_team, which finalize_team_if_due, expire_due_teams and set_competition_status all use) — the score is
--      written ONCE into the existing teams.final_* columns (app.freeze_final_score). From then on the frozen values
--      are authoritative: a late approval still pays coins (B14) but can never change the score. Both paths use the same
--      function, so manual and automatic finalization share one basis, and nothing drifts afterwards.
--   3. Leaderboard: app.leaderboard_rows is one SQL statement over one MVCC snapshot (so rank, score and "me" are always
--      coherent). Order: started teams before NOT_STARTED ones, then score desc, minutes_taken asc, Team ID asc (C
--      collation, code-point). Served by get_leaderboard (staff) and get_team_leaderboard (participants).
--   4. UFM penalty: penalize_team (owner ADMIN only). The official score becomes 0 and the team is frozen (a RUNNING team
--      is ended through app.expire_team; a team that is already terminal is only marked). Gameplay history (answers,
--      submissions, ledger, final_* gameplay snapshot) is NOT touched: the penalty is an override. Atomic, idempotent,
--      audited (UFM_PENALIZED). This replaces the never-built "UFM Reset" design (score_reset_* columns stay, unused);
--      Disqualify (score_override = -1201) stays unbuilt and wins over everything if it is ever used.
--   5. Re-declared with ONE additive change each (nothing else changed): app.expire_team and public.final_submit (freeze),
--      public.approve_submission (an approval that finds an expired, not yet persisted team ends it at its end first, so
--      the freeze happens before the late reward) and public.admin_matrix (+ `ufm_penalized`, for the My Teams grid).
--   6. Existing FINAL_SUBMITTED / ENDED teams get their score frozen from the current data (backfill).

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Penalty columns
-- ---------------------------------------------------------------------------------------------------------------
alter table teams
  add column ufm_penalized_at timestamptz,
  add column ufm_penalized_by uuid references staff_users(id) on delete restrict;

alter table teams add constraint teams_ufm_penalty_paired
  check ((ufm_penalized_at is null) = (ufm_penalized_by is null));
-- a penalty only exists on a team that has started and can no longer play
alter table teams add constraint teams_ufm_penalty_terminal
  check (ufm_penalized_at is null or status in ('FINAL_SUBMITTED', 'ENDED', 'DISQUALIFIED'));
-- the four cached gameplay values are written together
alter table teams add constraint teams_final_cache_paired
  check ((final_score is null) = (final_completed_themes is null)
     and (final_score is null) = (final_solved_questions is null)
     and (final_score is null) = (final_minutes_taken is null));

comment on column teams.ufm_penalized_at is 'B16: set once by penalize_team; the official score is then 0. Never cleared.';
comment on column teams.final_score is
  'B16: the GAMEPLAY score frozen at the terminal moment (app.freeze_final_score). The official score also honours ufm_penalized_at / score_override.';

create function app.teams_ufm_penalty_immutable() returns trigger
language plpgsql
set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  if old.ufm_penalized_at is not null
     and (new.ufm_penalized_at is distinct from old.ufm_penalized_at or new.ufm_penalized_by is distinct from old.ufm_penalized_by) then
    raise exception 'UFM_PENALTY_IMMUTABLE' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger teams_ufm_penalty_immutable before update of ufm_penalized_at, ufm_penalized_by on teams
  for each row execute function app.teams_ufm_penalty_immutable();

-- ---------------------------------------------------------------------------------------------------------------
-- 2. The formula, in exactly one place
-- ---------------------------------------------------------------------------------------------------------------
-- No SET clause on purpose: it touches no object, and a function without one is inlined into the calling query (one call per
-- team per board read would otherwise cost a full function setup each).
create function app.compute_score(p_completed int, p_solved int, p_coins int, p_minutes int) returns int
language sql immutable
as $$ select p_completed * 500 + p_solved * 100 + p_coins - p_minutes * 5 $$;

-- ---------------------------------------------------------------------------------------------------------------
-- app.team_scores_all(now) — one row per team, read-only, ONE statement (one snapshot).  (app.team_scores below filters it.)
--   completed / solved   live: APPROVED questions (a theme is completed at 5 of 5); frozen: teams.final_*
--   minutes              live: round((timer_seconds − remaining)/60) with remaining = ends_at − clock, clamped to
--                        [0, timer_seconds]; clock = least(now, ended_at, paused_at while PAUSED), exactly the team clock of
--                        every other read. Frozen: teams.final_minutes_taken. A team that has not started: 0.
--   gameplay_score       the formula above (frozen value once the team is terminal)
--   official_score       0 for a penalised team, score_override for a disqualified one, else gameplay_score
-- A terminal team whose final_* are still NULL (cannot happen after the backfill below) is derived with clock = ended_at.
-- ---------------------------------------------------------------------------------------------------------------
create function app.team_scores_all(p_now timestamptz)
returns table (team_id uuid, team_code text, status team_status, completed int, solved int, coins int, minutes int,
               gameplay_score int, official_score int, penalized boolean)
language sql stable
set search_path = pg_catalog, public, app, pg_temp
as $$
  with paused as (
    select case when c.status = 'PAUSED' then c.paused_at end as at from competition c where c.id = 1
  ), per_theme as (
    select tq.team_id, tq.theme_id, count(*) as n
      from team_questions tq
     where tq.state = 'APPROVED'
     group by tq.team_id, tq.theme_id
  ), prog as (
    select pt.team_id, sum(pt.n)::int as solved, (count(*) filter (where pt.n = 5))::int as completed
      from per_theme pt
     group by pt.team_id
  ), basis as (
    select t.id, t.team_code, t.status, t.coins, t.ufm_penalized_at, t.score_override,
           (t.final_score is not null) as frozen,
           t.final_score, t.final_completed_themes, t.final_solved_questions, t.final_minutes_taken,
           coalesce(pr.completed, 0) as live_completed, coalesce(pr.solved, 0) as live_solved,
           case when t.started_at is null then 0
                else round((t.timer_seconds
                            - greatest(0, least(t.timer_seconds,
                                                extract(epoch from (t.ends_at - least(p_now, coalesce(t.ended_at, 'infinity'::timestamptz),
                                                                                       (select at from paused)))))))
                           / 60.0)::int
           end as live_minutes
      from teams t
      left join prog pr on pr.team_id = t.id
  )
  select b.id, b.team_code, b.status,
         case when b.frozen then b.final_completed_themes else b.live_completed end,
         case when b.frozen then b.final_solved_questions  else b.live_solved end,
         b.coins,
         case when b.frozen then b.final_minutes_taken else b.live_minutes end,
         g.score,
         case when b.ufm_penalized_at is not null then 0 else coalesce(b.score_override, g.score) end,
         (b.ufm_penalized_at is not null)
    from basis b
    cross join lateral (
      select case when b.frozen then b.final_score
                  else app.compute_score(b.live_completed, b.live_solved, b.coins, b.live_minutes) end as score) g
$$;

-- app.team_scores(now, team?) — the same rows for one team (or all). Deliberately a thin filter over team_scores_all: an
-- "optional parameter" predicate (`p_team_id is null or ... = p_team_id`) inside the aggregation makes the planner choose a
-- nested-loop plan that costs ~10x more for the whole board (measured with 100 teams), and the board is the hot path.
create function app.team_scores(p_now timestamptz, p_team_id uuid default null)
returns table (team_id uuid, team_code text, status team_status, completed int, solved int, coins int, minutes int,
               gameplay_score int, official_score int, penalized boolean)
language sql stable
set search_path = pg_catalog, public, app, pg_temp
as $$
  select * from app.team_scores_all(p_now) s where p_team_id is null or s.team_id = p_team_id
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- app.freeze_final_score(team) — writes the gameplay score of a TERMINAL team into teams.final_* exactly once.
-- Idempotent (a team that already has final_score is left alone) and a no-op for a team that is not terminal. The caller
-- has already written status / ended_at in the same transaction and holds the team lock.
-- ---------------------------------------------------------------------------------------------------------------
create function app.freeze_final_score(p_team_id uuid) returns void
language sql
set search_path = pg_catalog, public, app, pg_temp
as $$
  update teams t
     set final_score = s.gameplay_score, final_completed_themes = s.completed,
         final_solved_questions = s.solved, final_minutes_taken = s.minutes
    from app.team_scores(app.now(), p_team_id) s
   where t.id = p_team_id and s.team_id = t.id
     and t.final_score is null
     and t.status in ('FINAL_SUBMITTED', 'ENDED', 'DISQUALIFIED')
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Re-declared with ONE additive line each (see the header): the terminal moment now freezes the score.
-- ---------------------------------------------------------------------------------------------------------------

create or replace function app.expire_team(p_team_id uuid, p_reason text, p_ended_at timestamptz, p_staff_id uuid default null)
returns void
language plpgsql
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  t     teams%rowtype;
  v_end timestamptz;
begin
  select * into t from teams where id = p_team_id;
  if not found or t.status <> 'RUNNING' then
    return;
  end if;
  v_end := least(t.ends_at, p_ended_at);

  update team_questions
     set state = 'TIMED_OUT', timed_out_at = timer_deadline, timer_deadline = null
   where team_id = p_team_id and state = 'ACTIVE' and timer_deadline <= v_end;

  update teams set status = 'ENDED', ended_at = v_end where id = p_team_id;
  perform app.freeze_final_score(p_team_id);                            -- B16: the score is fixed at this instant

  insert into audit_events (occurred_at, actor_kind, staff_id, team_id, event_type, entity_type, entity_id, payload)
  values (app.now(), case when p_staff_id is null then 'SYSTEM' else 'STAFF' end, p_staff_id, p_team_id,
          'TEAM_ENDED', 'TEAM', p_team_id::text,
          jsonb_build_object('reason', p_reason, 'ended_at', app.epoch_ms(v_end), 'ends_at', app.epoch_ms(t.ends_at)));
end $$;


create or replace function public.final_submit(p_team_id uuid, p_member_id uuid, p_confirm boolean, p_idem_key uuid) returns jsonb
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

  perform app.freeze_final_score(p_team_id);                            -- B16: same terminal basis as the timer expiry

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


create or replace function public.admin_matrix(p_staff_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
begin
  if p_staff_id is null or not exists (select 1 from staff_users where id = p_staff_id and role = 'ADMIN' and is_active) then
    perform app.fail('FORBIDDEN');
  end if;
  return jsonb_build_object(
    'server_now', app.epoch_ms(app.now()),
    'presence_timeout_seconds', app.presence_timeout_seconds(),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id,
               'team_code', t.team_code,
               'name', t.name,
               'status', t.status::text,
               'final_submitted', (t.status = 'FINAL_SUBMITTED'),
               'ufm_penalized', (t.ufm_penalized_at is not null),
               'members', (select coalesce(jsonb_agg(jsonb_build_object('slot', p.slot, 'presence', p.presence::text)
                                                      order by p.slot), '[]'::jsonb)
                             from member_presence p where p.team_id = t.id),
               'themes', (select jsonb_agg(jsonb_build_object(
                                    'code', th.code,
                                    'state', case when c.pending > 0 then 'RED'
                                                  when c.approved = 5 then 'GREEN'
                                                  else 'NORMAL' end,
                                    'approved', c.approved,
                                    'pending', c.pending) order by th.id)
                            from themes th
                            cross join lateral (
                              select count(*) filter (where tq.state = 'APPROVED')         as approved,
                                     count(*) filter (where tq.state = 'PENDING_APPROVAL') as pending
                                from team_questions tq
                               where tq.team_id = t.id and tq.theme_id = th.id) c)
             ) order by t.created_at, t.team_code)
        from teams t where t.admin_id = p_staff_id), '[]'::jsonb));
end $$;


-- approve_submission — re-declared with ONE additive block (see the comment inside): an approval that discovers an expired,
-- not yet persisted team ends it at its end first, so a late reward cannot move a score the timer already fixed.
create or replace function public.approve_submission(p_staff_id uuid, p_submission_id uuid, p_idem_key uuid) returns jsonb
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
  if v_team.status = 'RUNNING' and v_now >= v_team.ends_at then
    -- B16: the timer already ran out but nobody has persisted it yet. End the team AT its end (this also freezes its score)
    -- BEFORE this late reward is booked, so the reward pays coins (B14 / DEC-03) but can never move the score.
    perform app.expire_team(v_team_id, 'TIMER', v_team.ends_at);
  end if;
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
-- 4. Leaderboard
-- ---------------------------------------------------------------------------------------------------------------
create function app.leaderboard_rows(p_now timestamptz)
returns table (rank_no int, team_id uuid, team_code text, score int, minutes int)
language sql stable
set search_path = pg_catalog, public, app, pg_temp
as $$
  select (row_number() over (order by (s.status = 'NOT_STARTED'),        -- started teams first, unstarted last
                                      s.official_score desc,
                                      s.minutes asc,
                                      s.team_code collate "C" asc))::int,
         s.team_id, s.team_code, s.official_score, s.minutes
    from app.team_scores_all(p_now) s
$$;

-- get_leaderboard(staff_id) — ADMIN and SUPER_ADMIN (every team, as before). Shape gains `server_now`; rows unchanged.
create or replace function public.get_leaderboard(p_staff_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
begin
  if not exists (select 1 from staff_users where id = p_staff_id and role in ('ADMIN', 'SUPER_ADMIN') and is_active) then
    perform app.fail('FORBIDDEN');
  end if;
  -- a single statement: rank, score and server_now all come from one snapshot
  return (select jsonb_build_object(
                   'server_now', app.epoch_ms(n.v),
                   'rows', coalesce((select jsonb_agg(jsonb_build_object('rank', r.rank_no, 'team_id', r.team_code, 'score', r.score)
                                                      order by r.rank_no)
                                       from app.leaderboard_rows(n.v) r where r.rank_no <= 500), '[]'::jsonb))
            from (select app.now() as v) n);
end $$;

-- get_team_leaderboard(team_id, member_id) — a participant sees every team's rank / Team ID / score plus their own row.
-- `me` is taken from the same ranked set as `rows`, so the two can never disagree.
create function public.get_team_leaderboard(p_team_id uuid, p_member_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
begin
  perform app.assert_member(p_team_id, p_member_id);
  -- the ranking is computed ONCE (materialized) and both `rows` and `me` are read from that one result
  return (with n as (select app.now() as v),
               ranked as materialized (select r.* from app.leaderboard_rows((select v from n)) r)
          select jsonb_build_object(
                   'server_now', app.epoch_ms(n.v),
                   'rows', coalesce((select jsonb_agg(jsonb_build_object('rank', r.rank_no, 'team_id', r.team_code, 'score', r.score)
                                                      order by r.rank_no)
                                       from ranked r where r.rank_no <= 500), '[]'::jsonb),
                   'me', (select jsonb_build_object('rank', r.rank_no, 'team_id', r.team_code, 'score', r.score)
                            from ranked r where r.team_id = p_team_id))
            from n);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. penalize_team(staff_id, team_id, idempotency_key)               owner ADMIN only
--   * FORBIDDEN for anyone who is not an active ADMIN (participants never reach this function; a SUPER_ADMIN is refused);
--     NOT_FOUND for a team another admin owns (does not reveal that it exists).
--   * TEAM_NOT_STARTED: there is nothing to penalise before the team has started.
--   * RUNNING team  → app.expire_team(reason UFM_PENALTY, ended at the team clock, i.e. the pause instant while paused),
--                     which freezes the gameplay score; then the penalty is recorded. Already ENDED / FINAL_SUBMITTED →
--                     only recorded. Answers, submissions, ledger and the gameplay snapshot are never touched.
--   * Penalising an already penalised team (any key) is a no-op: changed:false, no second audit row, no version bump.
--   * One transaction under the team lock (competition share → team update), the global lock order.
--   Result: { replayed, changed, team: { id, team_code, status, official_score: 0, penalized_at } }
-- ---------------------------------------------------------------------------------------------------------------
create function public.penalize_team(p_staff_id uuid, p_team_id uuid, p_idem_key uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_team    teams%rowtype;
  v_fp      text := 'team:' || coalesce(p_team_id::text, '');
  v_replay  jsonb;
  v_now     timestamptz;
  v_changed boolean := false;
  v_prev    team_status;
  v_gameplay int;
  v_resp    jsonb;
begin
  perform app.require_owner_admin(p_staff_id, p_team_id);
  if p_idem_key is null then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array('idempotencyKey')));
  end if;

  v_team := app.lock_team(p_team_id);
  v_replay := app.idem_lookup(p_staff_id, p_idem_key, 'penalize_team', v_fp);
  if v_replay is not null then
    return v_replay || '{"replayed": true}'::jsonb;
  end if;

  if v_team.ufm_penalized_at is null then
    if v_team.status = 'NOT_STARTED' then
      perform app.fail('TEAM_NOT_STARTED');
    end if;
    v_now := app.now();
    v_prev := v_team.status;
    if v_team.status = 'RUNNING' then
      perform app.expire_team(p_team_id, 'UFM_PENALTY', app.team_clock(v_team), p_staff_id);
    end if;
    update teams
       set ufm_penalized_at = v_now, ufm_penalized_by = p_staff_id, state_version = state_version + 1
     where id = p_team_id;
    select s.gameplay_score into v_gameplay from app.team_scores(v_now, p_team_id) s;

    insert into audit_events (occurred_at, actor_kind, staff_id, team_id, event_type, entity_type, entity_id, payload, request_id)
    values (v_now, 'STAFF', p_staff_id, p_team_id, 'UFM_PENALIZED', 'TEAM', p_team_id::text,
            jsonb_build_object('previous_status', v_prev::text, 'official_score', 0, 'gameplay_score', v_gameplay,
                               'penalized_at', app.epoch_ms(v_now)),
            p_idem_key);
    v_changed := true;
  end if;

  select jsonb_build_object('replayed', false, 'changed', v_changed,
                            'team', jsonb_build_object('id', t.id, 'team_code', t.team_code, 'status', t.status::text,
                                                       'official_score', 0, 'penalized_at', app.epoch_ms(t.ufm_penalized_at)))
    into v_resp from teams t where t.id = p_team_id;
  perform app.idem_store(p_staff_id, p_idem_key, 'penalize_team', v_fp, v_resp);
  return v_resp;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Privileges: no PUBLIC, no anon, no authenticated; service_role only.
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function app.teams_ufm_penalty_immutable()                       from public, anon, authenticated;
revoke all on function app.compute_score(int, int, int, int)                   from public, anon, authenticated;
revoke all on function app.team_scores_all(timestamptz)                        from public, anon, authenticated;
revoke all on function app.team_scores(timestamptz, uuid)                      from public, anon, authenticated;
revoke all on function app.freeze_final_score(uuid)                            from public, anon, authenticated;
revoke all on function app.leaderboard_rows(timestamptz)                       from public, anon, authenticated;
revoke all on function app.expire_team(uuid, text, timestamptz, uuid)          from public, anon, authenticated;
revoke all on function public.final_submit(uuid, uuid, boolean, uuid)          from public, anon, authenticated;
revoke all on function public.approve_submission(uuid, uuid, uuid)             from public, anon, authenticated;
revoke all on function public.admin_matrix(uuid)                               from public, anon, authenticated;
revoke all on function public.get_leaderboard(uuid)                            from public, anon, authenticated;
revoke all on function public.get_team_leaderboard(uuid, uuid)                 from public, anon, authenticated;
revoke all on function public.penalize_team(uuid, uuid, uuid)                  from public, anon, authenticated;

grant execute on function app.teams_ufm_penalty_immutable()                    to service_role;
grant execute on function app.compute_score(int, int, int, int)                to service_role;
grant execute on function app.team_scores_all(timestamptz)                     to service_role;
grant execute on function app.team_scores(timestamptz, uuid)                   to service_role;
grant execute on function app.freeze_final_score(uuid)                         to service_role;
grant execute on function app.leaderboard_rows(timestamptz)                    to service_role;
grant execute on function app.expire_team(uuid, text, timestamptz, uuid)       to service_role;
grant execute on function public.final_submit(uuid, uuid, boolean, uuid)       to service_role;
grant execute on function public.approve_submission(uuid, uuid, uuid)          to service_role;
grant execute on function public.admin_matrix(uuid)                            to service_role;
grant execute on function public.get_leaderboard(uuid)                         to service_role;
grant execute on function public.get_team_leaderboard(uuid, uuid)              to service_role;
grant execute on function public.penalize_team(uuid, uuid, uuid)               to service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 7. Backfill: teams that were already terminal before B16 get their score frozen from the data as it stands now (the
-- minutes are exact: the clock is the team's own ended_at). One SYSTEM audit row records how many.
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare
  v_n int;
begin
  select count(*) into v_n from teams
   where status in ('FINAL_SUBMITTED', 'ENDED', 'DISQUALIFIED') and final_score is null;
  perform app.freeze_final_score(id) from teams
   where status in ('FINAL_SUBMITTED', 'ENDED', 'DISQUALIFIED') and final_score is null;
  if v_n > 0 and exists (select 1 from competition where id = 1) then
    insert into audit_events (occurred_at, actor_kind, event_type, entity_type, entity_id, payload)
    values (app.now(), 'SYSTEM', 'SCORES_BACKFILLED', 'COMPETITION', '1', jsonb_build_object('teams', v_n));
  end if;
end $$;

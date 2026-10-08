-- Patch B15 / migration 16 — the 4-hour Ultimate Team Timer, a per-team allowance snapshot, and persisted
-- auto-finalization at zero.
--
-- Why it is safe for teams that are already playing: the competition-wide value (`competition.ultimate_seconds`) is only
-- READ when a team STARTS (start_team_competition). A team that has already started keeps the absolute `started_at` /
-- `ends_at` it was given, so changing the value changes nothing for it. This migration never writes `started_at`,
-- `ends_at`, `ended_at`, `coins` or `status` of any team. The only column it fills on a started team is the new
-- `teams.timer_seconds` (= 7200, the allowance that team actually received); `updated_at` follows via the existing
-- touch trigger. Teams that have not started yet get 14400 s when they first enter. No team is ever extended.
--
-- Contents
--   1. competition.ultimate_seconds: 7200 -> 14400 (default, the row, the locking CHECK).
--   2. teams.timer_seconds: the allowance a team was given when it started (NULL until it starts).
--   3. teams.final_minutes_taken: the 0..120 upper bound belonged to the 2 h timer; scoring (B16) owns the rounding.
--   4. start_team_competition (re-declared): also stores timer_seconds.
--   5. app.team_state_json (re-declared): per-team duration_seconds and the `frozen` flag.
--   6. finalize_team_if_due / expire_due_teams: the persisted RUNNING -> ENDED transition at zero. No pg_cron needed.
--   7. State versions of NOT_STARTED teams (their snapshot duration changed) and one SYSTEM audit row.
--
-- Everything else (lock order, idempotency, error codes, privileges) follows the B10/B13 conventions.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. The competition-wide allowance for teams that start from now on
-- ---------------------------------------------------------------------------------------------------------------
alter table competition drop constraint competition_ultimate_locked_7200;
alter table competition alter column ultimate_seconds set default 14400;
update competition set ultimate_seconds = 14400 where id = 1;          -- ultimate_minutes (generated) becomes 240
alter table competition add constraint competition_ultimate_locked_14400 check (ultimate_seconds = 14400);

-- ---------------------------------------------------------------------------------------------------------------
-- 2. The per-team snapshot. Teams that started under the 2 h rule keep exactly that allowance.
-- ---------------------------------------------------------------------------------------------------------------
alter table teams add column timer_seconds int;
update teams set timer_seconds = 7200 where started_at is not null;     -- the allowance every pre-B15 team was given
alter table teams add constraint teams_timer_seconds_iff_started
  check ((timer_seconds is not null) = (started_at is not null) and (timer_seconds is null or timer_seconds > 0));
comment on column teams.timer_seconds is
  'Ultimate Team Timer allowance in seconds, copied from competition.ultimate_seconds when the team started '
  '(7200 for teams that started before B15, 14400 afterwards). NULL until the team starts. Never edited afterwards.';

-- ---------------------------------------------------------------------------------------------------------------
-- 3. final_minutes_taken: a 4 h team can legitimately exceed 120. Scoring (B16) computes and rounds it.
-- ---------------------------------------------------------------------------------------------------------------
alter table teams drop constraint teams_final_minutes_taken_check;
alter table teams add constraint teams_final_minutes_taken_nonneg
  check (final_minutes_taken is null or final_minutes_taken >= 0);

-- ---------------------------------------------------------------------------------------------------------------
-- 4. start_team_competition — unchanged apart from storing the allowance in teams.timer_seconds.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.start_team_competition(p_team_id uuid, p_member_id uuid, p_idem_key uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_now     timestamptz;
  v_team    teams%rowtype;
  v_comp    competition%rowtype;
  v_fp      text := 'member:' || coalesce(p_member_id::text, '');
  v_replay  jsonb;
  v_started boolean := false;
  v_resp    jsonb;
begin
  if p_team_id is null or p_member_id is null
     or not exists (select 1 from team_members where id = p_member_id and team_id = p_team_id) then
    perform app.fail('FORBIDDEN');                                     -- a member can only act for their own team
  end if;
  if p_idem_key is null then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array('idempotencyKey')));
  end if;

  v_team := app.lock_team(p_team_id);                                  -- competition (share) → team (update)

  v_replay := app.idem_lookup(p_team_id, p_idem_key, 'start_team_competition', v_fp);
  if v_replay is not null then
    return v_replay || '{"replayed": true}'::jsonb;
  end if;

  select * into v_comp from competition where id = 1;

  if v_team.status <> 'RUNNING' then
    if v_comp.id is null or v_comp.status in ('SETUP', 'ENDED') then
      perform app.fail('COMPETITION_NOT_RUNNING');
    elsif v_comp.status = 'PAUSED' then
      perform app.fail('COMPETITION_PAUSED');
    end if;
    if v_team.status = 'FINAL_SUBMITTED' then
      perform app.fail('ALREADY_SUBMITTED');
    elsif v_team.status <> 'NOT_STARTED' then
      perform app.fail('TEAM_ENDED');                                  -- ENDED or DISQUALIFIED
    end if;

    v_now := app.now();
    update teams
       set status = 'RUNNING',
           started_at = v_now,
           ends_at = v_now + make_interval(secs => v_comp.ultimate_seconds),
           timer_seconds = v_comp.ultimate_seconds,                    -- B15: the allowance this team was given
           state_version = state_version + 1
     where id = p_team_id;

    insert into audit_events (occurred_at, actor_kind, member_id, team_id, event_type, entity_type, entity_id, payload, request_id)
    values (v_now, 'MEMBER', p_member_id, p_team_id, 'TEAM_STARTED', 'TEAM', p_team_id::text,
            jsonb_build_object('started_at', app.epoch_ms(v_now),
                               'ends_at', app.epoch_ms(v_now + make_interval(secs => v_comp.ultimate_seconds)),
                               'ultimate_seconds', v_comp.ultimate_seconds),
            p_idem_key);
    v_started := true;
  end if;

  v_resp := jsonb_build_object('replayed', false, 'started_now', v_started,
                               'state', app.team_state_json(p_team_id, p_member_id));
  perform app.idem_store(p_team_id, p_idem_key, 'start_team_competition', v_fp, v_resp);
  return v_resp;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. app.team_state_json — B13 body, with two changes only:
--      * team.duration_seconds is the TEAM's own allowance (teams.timer_seconds, falling back to the competition value
--        for a team that has not started), so a team that started under the 2 h rule keeps reporting 7200;
--      * team.frozen: true once the team can no longer play (FINAL_SUBMITTED / ENDED / DISQUALIFIED, or the timer ran out
--        and the ENDED row has not been written yet). A pause is NOT "frozen" (it is a competition status).
-- Still a pure read.
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
  v_expired boolean;
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
  v_expired := (t.status = 'RUNNING' and v_ref >= t.ends_at);

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
      'duration_seconds', coalesce(t.timer_seconds, c.ultimate_seconds),
      'remaining_seconds', v_rem,
      'expired', v_expired,
      'frozen', (t.status in ('FINAL_SUBMITTED', 'ENDED', 'DISQUALIFIED') or v_expired)),
    'themes', v_themes);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Persisted auto-finalization at zero (RUNNING -> ENDED). The rule "nothing succeeds at or after ends_at" is already
-- enforced on every request by app.assert_playable; these functions only WRITE the transition, so the stored status
-- catches up with what every read already reports. They do not depend on pg_cron: the API calls
-- finalize_team_if_due whenever anyone on a team loads its state, and expire_due_teams is a safety net that a scheduler
-- (a Vercel Cron route today) may call.
--
--   * ended_at = the team's own ends_at (NOT the moment the function happens to run), so the result is the same whenever
--     and however it is processed. Already-overdue ACTIVE questions become TIMED_OUT (app.expire_team); a question whose
--     own deadline is still later stays ACTIVE and is shown frozen. Coins, ledger and submissions are not touched.
--   * Only while the competition is RUNNING. During a pause nothing is due; `resume` / `end` already end such teams.
--   * Idempotent and non-raising: a team that is not due (or already terminal) returns finalized:false and changes nothing.
--   * Lock order is the global one: competition (share) -> team (update). expire_due_teams uses SKIP LOCKED, so it never
--     queues behind a live participant request.
-- ---------------------------------------------------------------------------------------------------------------
create function public.finalize_team_if_due(p_team_id uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_team teams%rowtype;
  v_comp competition%rowtype;
begin
  v_team := app.lock_team(p_team_id);                                  -- NOT_FOUND for an unknown team
  select * into v_comp from competition where id = 1;
  if v_comp.status = 'RUNNING' and v_team.status = 'RUNNING' and app.now() >= v_team.ends_at then
    perform app.expire_team(p_team_id, 'TIMER', v_team.ends_at);
    update teams set state_version = state_version + 1 where id = p_team_id;
    return jsonb_build_object('finalized', true, 'status', 'ENDED');
  end if;
  return jsonb_build_object('finalized', false, 'status', v_team.status);
end $$;

create function public.expire_due_teams(p_limit int default 200) returns int
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_comp competition%rowtype;
  v_n    int := 0;
  r      record;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array('limit')));
  end if;
  select * into v_comp from competition where id = 1 for share;        -- competition first, then teams
  if not found or v_comp.status <> 'RUNNING' then
    return 0;
  end if;
  for r in
    select id, ends_at from teams
     where status = 'RUNNING' and ends_at <= app.now()
     order by ends_at, id
     limit p_limit
       for update skip locked
  loop
    perform app.expire_team(r.id, 'TIMER', r.ends_at);
    update teams set state_version = state_version + 1 where id = r.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- explicit for the two re-declared functions as well (CREATE OR REPLACE keeps their old privileges; stating them again
-- makes this file self-describing and idempotent)
revoke all on function public.start_team_competition(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function app.team_state_json(uuid, uuid)                 from public, anon, authenticated;
revoke all on function public.finalize_team_if_due(uuid)               from public, anon, authenticated;
revoke all on function public.expire_due_teams(int)                    from public, anon, authenticated;
grant execute on function public.start_team_competition(uuid, uuid, uuid) to service_role;
grant execute on function app.team_state_json(uuid, uuid)                 to service_role;
grant execute on function public.finalize_team_if_due(uuid)               to service_role;
grant execute on function public.expire_due_teams(int)                    to service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 7. Teams that have not started: their snapshot's duration_seconds just changed (7200 -> 14400), so clients holding an
-- older snapshot should adopt the new one. Started teams are NOT written (their snapshot content is unchanged).
-- One SYSTEM audit row records the change and what it did NOT touch.
-- ---------------------------------------------------------------------------------------------------------------
update teams set state_version = state_version + 1 where status = 'NOT_STARTED';

insert into audit_events (occurred_at, actor_kind, event_type, entity_type, entity_id, payload)
select app.now(), 'SYSTEM', 'TIMER_CONFIG_CHANGED', 'COMPETITION', '1',
       jsonb_build_object('from_seconds', 7200, 'to_seconds', 14400,
                          'started_teams_kept_at_7200', (select count(*) from teams where timer_seconds = 7200),
                          'not_started_teams', (select count(*) from teams where status = 'NOT_STARTED'))
 where exists (select 1 from competition where id = 1);          -- a fresh database has no competition row yet

-- Patch B10 / migration 12 — competition runtime engine: the single team lock, request idempotency, the controlled
-- competition status operation, start_team_competition and the authoritative team snapshot.
--
-- Scope (B10 only): SETUP→RUNNING, RUNNING↔PAUSED, RUNNING/PAUSED→ENDED; team NOT_STARTED→RUNNING. No theme, question,
-- coin, submission, final-submit, UFM or realtime operation, and no scoring (`compute_team_score` does not exist yet).
--
-- Conventions (docs/STATE_MACHINE.md §1, docs/API_SPEC.md §1–2):
--   * Rejections are RAISED as `P0001` with the stable error code as the message (and optional JSON `detail`), so the
--     whole transaction rolls back. The API maps the code; no raw PostgreSQL error ever reaches a client.
--   * Every timestamp comes from app.now(); the clock is never a parameter. Times in JSON are epoch milliseconds.
--   * Principals are resolved by the server (B9 resolve_session) and passed as ids; every function re-checks them
--     (member ∈ team, staff active and SUPER_ADMIN), so authorisation is enforced twice (SECURITY.md §4).
--   * Locks are always taken in this order: competition row → teams (by id) → their children. Deadlock-free.
--   * Privileges: every function below gets an explicit REVOKE ALL … FROM PUBLIC, anon, authenticated and a
--     GRANT EXECUTE … TO service_role. Nothing relies on PostgreSQL's default function privileges.

-- ---------------------------------------------------------------------------------------------------------------
-- request_log: one row per (scope, key). `team_id` holds the team id for participant operations and the staff id for
-- staff operations (unchanged from migration 7). The new fingerprint binds a key to one operation and one actor
-- (and its parameters), so reusing a key for something else is an error instead of a silent replay.
-- ---------------------------------------------------------------------------------------------------------------
alter table request_log add column request_fingerprint text not null default '';

-- ---------------------------------------------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------------------------------------------
create function app.fail(p_code text, p_details jsonb default null) returns void
language plpgsql
as $$
begin
  if p_details is null then
    raise exception '%', p_code using errcode = 'P0001';
  else
    raise exception '%', p_code using errcode = 'P0001', detail = p_details::text;
  end if;
end $$;

create function app.epoch_ms(p_ts timestamptz) returns bigint
language sql immutable strict
as $$ select floor(extract(epoch from p_ts) * 1000)::bigint $$;

-- Staff authority for competition-level operations: an active SUPER_ADMIN (STATE_MACHINE §2: "Super Admin only").
create function app.require_super_admin(p_staff_id uuid) returns void
language plpgsql stable
set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  if p_staff_id is null
     or not exists (select 1 from staff_users where id = p_staff_id and role = 'SUPER_ADMIN' and is_active) then
    perform app.fail('FORBIDDEN');
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- app.lock_team — the ONE locking primitive for every future operation that touches a team.
--   1. competition row FOR SHARE: while an operation runs, the competition status cannot change under it (a start can
--      never slip through a concurrent pause), yet any number of participants proceed in parallel.
--   2. team row FOR UPDATE: all writers of one team are serialised.
-- Competition → team is the global lock order; set_competition_status takes competition FOR UPDATE and then the teams in
-- id order, so no cycle is possible. Raises NOT_FOUND for an unknown team. Callers read competition.status afterwards:
-- the share lock guarantees that the value they read stays valid until commit.
-- ---------------------------------------------------------------------------------------------------------------
create function app.lock_team(p_team_id uuid) returns teams
language plpgsql
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_team teams%rowtype;
begin
  perform 1 from competition where id = 1 for share;
  select * into v_team from teams where id = p_team_id for update;
  if not found then
    perform app.fail('NOT_FOUND');
  end if;
  return v_team;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Idempotency (STATE_MACHINE §1.1 step 1). Callers invoke these while holding the lock that serialises the scope
-- (the team lock, or the competition lock for staff operations), so two requests with one key cannot interleave.
--   idem_lookup: NULL if the key is new; the stored response if it was seen; IDEMPOTENCY_KEY_REUSED if the key was used
--   for another operation, actor or parameter. A missing key is VALIDATION_FAILED.
--   Only successes are stored: a rejected request rolled back and may be retried with the same key.
-- ---------------------------------------------------------------------------------------------------------------
create function app.idem_lookup(p_scope uuid, p_key uuid, p_operation text, p_fingerprint text) returns jsonb
language plpgsql stable
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  r request_log%rowtype;
begin
  if p_key is null then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array('idempotencyKey')));
  end if;
  select * into r from request_log where team_id = p_scope and idem_key = p_key;
  if not found then
    return null;
  end if;
  if r.operation <> p_operation or r.request_fingerprint <> p_fingerprint then
    perform app.fail('IDEMPOTENCY_KEY_REUSED');
  end if;
  return r.response;
end $$;

create function app.idem_store(p_scope uuid, p_key uuid, p_operation text, p_fingerprint text, p_response jsonb)
returns void
language sql
set search_path = pg_catalog, public, app, pg_temp
as $$
  insert into request_log (team_id, idem_key, operation, response, request_fingerprint, created_at)
  values (p_scope, p_key, p_operation, p_response, p_fingerprint, app.now())
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- The authoritative snapshot. Used by get_team_state AND returned by start_team_competition, so the two can never
-- disagree. A pure read: it never changes anything, not even for an expired team (it reports remaining_seconds = 0 and
-- expired = true; the transition to ENDED belongs to competition end / the later sweeper).
--
--   ref_time          = least(app.now(), team.ended_at, competition.paused_at while PAUSED)       (STATE_MACHINE §1.3)
--   remaining_seconds = greatest(0, floor(extract(epoch from ends_at - ref_time)))
-- While the competition is RUNNING and the team is not terminal this is exactly floor(ends_at - now()). A team that has
-- not started reports the full ultimate_seconds. Nothing here is stored; nothing here is client-supplied.
--
-- Never included: password hashes, session token hashes, admission numbers, question bodies, hints or reviewer keys.
-- The shape is a strict subset of docs/API_SPEC.md §7 (no score, teammates or purchasable options yet).
-- ---------------------------------------------------------------------------------------------------------------
create function app.team_state_json(p_team_id uuid, p_member_id uuid) returns jsonb
language plpgsql stable
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_now   timestamptz := app.now();
  t       teams%rowtype;
  c       competition%rowtype;
  m       team_members%rowtype;
  v_ref   timestamptz;
  v_rem   int;
  v_themes jsonb;
begin
  select * into t from teams where id = p_team_id;
  select * into c from competition where id = 1;
  select * into m from team_members where id = p_member_id and team_id = p_team_id;
  if t.id is null or m.id is null or c.id is null then
    perform app.fail('NOT_FOUND');
  end if;

  v_ref := least(v_now, coalesce(t.ended_at, 'infinity'::timestamptz),
                 case when c.status = 'PAUSED' then c.paused_at end);
  v_rem := case when t.ends_at is null then c.ultimate_seconds
                else greatest(0, floor(extract(epoch from (t.ends_at - v_ref))))::int end;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', th.id,
             'code', th.code,
             'status', case when tt.theme_id is null then 'LOCKED'
                            when coalesce(p.has_timed_out, false) then 'FAILED'
                            when coalesce(p.completed, false) then 'COMPLETED'
                            else 'IN_PROGRESS' end,
             'questions', coalesce(qs.arr, '[]'::jsonb))
           order by th.display_order), '[]'::jsonb)
    into v_themes
    from themes th
    left join team_themes tt on tt.team_id = p_team_id and tt.theme_id = th.id
    left join team_theme_progress p on p.team_id = p_team_id and p.theme_id = th.id
    left join lateral (
      select jsonb_agg(
               jsonb_build_object('id', q.question_id, 'ordinal', q.ordinal, 'state', q.state)
               || case when q.state = 'ACTIVE' then jsonb_build_object('deadline', app.epoch_ms(q.timer_deadline))
                       else '{}'::jsonb end
               order by q.ordinal) as arr
        from team_questions q
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

create function app.competition_json() returns jsonb
language sql stable
set search_path = pg_catalog, public, app, pg_temp
as $$
  select jsonb_build_object('status', status, 'opened_at', app.epoch_ms(opened_at), 'paused_at', app.epoch_ms(paused_at),
                            'ended_at', app.epoch_ms(ended_at), 'state_version', state_version)
    from competition where id = 1
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- app.expire_team — the minimal, idempotent RUNNING → ENDED transition (STATE_MACHINE §5.4), used only by the
-- competition operations below in B10 (the sweeper and lazy expiry arrive with the game operations).
--   * The caller holds the team lock and bumps state_version (STATE_MACHINE §1.2).
--   * ended_at = least(ends_at, p_ended_at): a team never ends later than its scheduled end.
--   * ACTIVE questions whose deadline is not after that instant become TIMED_OUT (none exist before B12).
--   * NOT done yet: caching final_* (compute_team_score does not exist). They stay NULL until the scoring patch.
-- ---------------------------------------------------------------------------------------------------------------
create function app.expire_team(p_team_id uuid, p_reason text, p_ended_at timestamptz, p_staff_id uuid default null)
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

  insert into audit_events (occurred_at, actor_kind, staff_id, team_id, event_type, entity_type, entity_id, payload)
  values (app.now(), case when p_staff_id is null then 'SYSTEM' else 'STAFF' end, p_staff_id, p_team_id,
          'TEAM_ENDED', 'TEAM', p_team_id::text,
          jsonb_build_object('reason', p_reason, 'ended_at', app.epoch_ms(v_end), 'ends_at', app.epoch_ms(t.ends_at)));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- set_competition_status(staff_id, action, idempotency_key)        SUPER_ADMIN only
--   open   SETUP            → RUNNING   guard: ≥ 1 team, exactly 10 themes, 50 questions and exactly 5 questions in every theme
--   pause  RUNNING          → PAUSED
--   resume PAUSED           → RUNNING   every RUNNING team's ends_at and every ACTIVE question deadline shifts by the
--                                        paused duration; a team already past its end at the instant of the pause is
--                                        ended (ended_at = its scheduled end) instead of being revived by the shift
--   end    RUNNING/PAUSED   → ENDED     every RUNNING team is ended (reason COMPETITION_ENDED)
-- Asking for the state the competition is already in (open/resume when RUNNING, pause when PAUSED, end when ENDED) is an
-- idempotent no-op: same response shape, `changed: false`, no audit row, no version bump. Anything else is
-- INVALID_COMPETITION_TRANSITION. Every real change bumps competition.state_version and the state_version of every team
-- (the competition status is part of every team snapshot) and writes COMPETITION_STATUS_CHANGED.
-- ---------------------------------------------------------------------------------------------------------------
create function public.set_competition_status(p_staff_id uuid, p_action text, p_idem_key uuid) returns jsonb
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
-- start_team_competition(team_id, member_id, idempotency_key)      participant: "Enter competition"
-- Sets status = RUNNING, started_at = app.now(), ends_at = started_at + ultimate_seconds (7200, locked by a check
-- constraint) in ONE statement under the team lock, so concurrent members observe one pair of timestamps. Login never
-- calls it. A team that is already RUNNING returns its existing state untouched (no reset, no audit, no version bump),
-- whatever the competition status; the gate below applies only to an actual start.
--   Rejections: FORBIDDEN (member not in team) · COMPETITION_NOT_RUNNING (SETUP/ENDED) · COMPETITION_PAUSED ·
--               ALREADY_SUBMITTED (FINAL_SUBMITTED) · TEAM_ENDED (ENDED/DISQUALIFIED).
-- Result: { replayed, started_now, state: <team snapshot> }.
-- ---------------------------------------------------------------------------------------------------------------
create function public.start_team_competition(p_team_id uuid, p_member_id uuid, p_idem_key uuid) returns jsonb
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
-- get_team_state(team_id, member_id)      participant: the authoritative snapshot (a read; takes no lock)
-- ---------------------------------------------------------------------------------------------------------------
create function public.get_team_state(p_team_id uuid, p_member_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
begin
  if p_team_id is null or p_member_id is null
     or not exists (select 1 from team_members where id = p_member_id and team_id = p_team_id) then
    perform app.fail('FORBIDDEN');
  end if;
  return app.team_state_json(p_team_id, p_member_id);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges. Explicit for every function above: no PUBLIC, no anon, no authenticated; service_role only.
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function app.fail(text, jsonb)                                         from public, anon, authenticated;
revoke all on function app.epoch_ms(timestamptz)                                     from public, anon, authenticated;
revoke all on function app.require_super_admin(uuid)                                 from public, anon, authenticated;
revoke all on function app.lock_team(uuid)                                           from public, anon, authenticated;
revoke all on function app.idem_lookup(uuid, uuid, text, text)                       from public, anon, authenticated;
revoke all on function app.idem_store(uuid, uuid, text, text, jsonb)                 from public, anon, authenticated;
revoke all on function app.team_state_json(uuid, uuid)                               from public, anon, authenticated;
revoke all on function app.competition_json()                                        from public, anon, authenticated;
revoke all on function app.expire_team(uuid, text, timestamptz, uuid)                from public, anon, authenticated;
revoke all on function public.set_competition_status(uuid, text, uuid)               from public, anon, authenticated;
revoke all on function public.start_team_competition(uuid, uuid, uuid)               from public, anon, authenticated;
revoke all on function public.get_team_state(uuid, uuid)                             from public, anon, authenticated;

grant execute on function app.fail(text, jsonb)                                         to service_role;
grant execute on function app.epoch_ms(timestamptz)                                     to service_role;
grant execute on function app.require_super_admin(uuid)                                 to service_role;
grant execute on function app.lock_team(uuid)                                           to service_role;
grant execute on function app.idem_lookup(uuid, uuid, text, text)                       to service_role;
grant execute on function app.idem_store(uuid, uuid, text, text, jsonb)                 to service_role;
grant execute on function app.team_state_json(uuid, uuid)                               to service_role;
grant execute on function app.competition_json()                                        to service_role;
grant execute on function app.expire_team(uuid, text, timestamptz, uuid)                to service_role;
grant execute on function public.set_competition_status(uuid, text, uuid)               to service_role;
grant execute on function public.start_team_competition(uuid, uuid, uuid)               to service_role;
grant execute on function public.get_team_state(uuid, uuid)                             to service_role;

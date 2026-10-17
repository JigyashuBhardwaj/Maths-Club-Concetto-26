-- Migration 22 — set_competition_status under pg-safeupdate.
--
-- Production defect: POST /api/super/competition/status answered 503 SERVICE_UNAVAILABLE for every transition that changes the
-- status. The function ended with `update teams set state_version = state_version + 1;` (migrations 12 and 14), an UPDATE with no
-- WHERE clause. Supabase loads and enables the `safeupdate` extension for the roles behind its Data API (anon, authenticator,
-- authenticated); every function here is called through that API, so the statement is refused with
--     ERROR:  UPDATE requires a WHERE clause        (SQLSTATE 21000)
-- and the whole call rolls back. A plain PostgreSQL (the superuser scratch database of `npm run db:verify`) accepts the
-- statement, which is why the SQL tests never saw it. No status was ever changed through the API in production.
--
-- This migration replaces ONE function and changes ONE statement: `where true` states what was always meant ("every team's
-- state_version moves with the competition's"). Everything else — checks, order of locks, transitions, idempotency, audit,
-- result shape, security definer, pinned search_path, privileges — is byte-for-byte migration 14's definition.
-- No table, column, constraint, index, trigger or policy changes, and no data is touched.
-- Guards: tests/unit/function-dml-safeupdate.test.ts (every function's final definition) and
-- supabase/tests/210_competition_status_safeupdate.test.sql (the real extension, when it is installed).

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
  update teams set state_version = state_version + 1 where true;     -- migration 22: safeupdate needs a WHERE clause
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

-- CREATE OR REPLACE keeps the function's privileges; they are restated: service_role only.
revoke all on function public.set_competition_status(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.set_competition_status(uuid, text, uuid) to service_role;

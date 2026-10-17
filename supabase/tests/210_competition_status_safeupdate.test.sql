-- set_competition_status under pg-safeupdate (migration 22).
--
-- Supabase loads and enables the `safeupdate` extension for the roles behind its Data API, so a function whose body runs an
-- UPDATE or DELETE without a WHERE clause fails there with `UPDATE requires a WHERE clause` (SQLSTATE 21000) and the API
-- answers 503. The other tests run as a superuser on a plain PostgreSQL and cannot see that. This file LOADs the real
-- extension into the session and drives every lifecycle transition through it.
--
-- The extension is a separate library (https://github.com/eradman/pg-safeupdate; Supabase has it built in). When it is not
-- installed on the scratch server the test says so and SKIPS: tests/unit/function-dml-safeupdate.test.ts is the static guard
-- that runs everywhere. To run this file for real: build pg-safeupdate for the server's major version and copy safeupdate.so into
-- `pg_config --pkglibdir`.
begin;
\ir include/helpers.sql
\ir include/fixture.sql

set app.allow_test_clock = 'on';
set app.test_now = '2026-12-01 12:00:00+00';

create function pg_temp.key(n int) returns uuid language sql as
  $$ select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.status(act text, n int) returns jsonb language sql as
  $$ select public.set_competition_status('00000000-0000-0000-0000-0000000000a1', act, pg_temp.key(n)) $$;
create function pg_temp.at(ts text) returns void language plpgsql as $$
begin perform set_config('app.test_now', ts, false); end $$;

-- Is the extension available? (LOAD needs the library file; a superuser may load any library.)
create temp table safeupdate_state(active boolean not null);
do $$
declare v_active boolean := false;
begin
  begin
    execute 'load ''safeupdate''';
    v_active := true;
  exception when others then
    raise notice 'SKIPPED: pg-safeupdate is not installed on this server (%): only the static guard ran', sqlerrm;
  end;
  insert into safeupdate_state values (v_active);
end $$;

-- The extension really is active in this session: a bare UPDATE is refused with 21000, WHERE true is accepted.
do $$
begin
  if not (select active from safeupdate_state) then return; end if;
  begin
    execute 'update teams set state_version = state_version + 1';
    raise exception 'safeupdate did not refuse a bare UPDATE: the test would prove nothing';
  exception when sqlstate '21000' then
    null;
  end;
  execute 'update teams set state_version = state_version where true';
end $$;

-- Every transition that changes the status, through safeupdate: open -> pause -> resume -> end.
do $$
declare j jsonb; tv_before bigint; cv_before bigint;
begin
  if not (select active from safeupdate_state) then return; end if;

  select state_version into cv_before from competition where id = 1;
  select min(state_version) into tv_before from teams;
  perform pg_temp.at('2026-12-01 12:00:00+00');
  j := pg_temp.status('open', 1);
  assert (j->>'changed')::boolean and j->>'from' = 'SETUP' and j->>'to' = 'RUNNING', 'OPEN succeeds under safeupdate';
  assert (select status = 'RUNNING' from competition), 'the competition is RUNNING';
  assert (select state_version = cv_before + 1 from competition), 'competition.state_version moved by one';
  assert (select min(state_version) = tv_before + 1 and max(state_version) = tv_before + 1 from teams),
         'EVERY team''s state_version moved by one (the statement that carries the WHERE true)';

  perform pg_temp.at('2026-12-01 12:10:00+00');
  j := pg_temp.status('pause', 2);
  assert j->>'from' = 'RUNNING' and j->>'to' = 'PAUSED', 'PAUSE succeeds under safeupdate';

  perform pg_temp.at('2026-12-01 12:20:00+00');
  j := pg_temp.status('resume', 3);
  assert j->>'from' = 'PAUSED' and j->>'to' = 'RUNNING', 'RESUME succeeds under safeupdate';

  j := pg_temp.status('end', 4);
  assert j->>'from' = 'RUNNING' and j->>'to' = 'ENDED', 'END succeeds under safeupdate';
  assert (select status = 'ENDED' from competition);
  assert (select count(*) from audit_events where event_type = 'COMPETITION_STATUS_CHANGED') = 4, 'one audit event per transition';

  -- replay and illegal transitions keep their meaning
  assert (pg_temp.status('open', 1)->>'replayed')::boolean, 'the same key replays the stored answer';
  perform pg_temp.rejects($s$select pg_temp.status('open', 5)$s$, 'INVALID_COMPETITION_TRANSITION');   -- ENDED is terminal
end $$;

rollback;

-- B15 / migration 16: the 4 h Ultimate Team Timer, the per-team allowance snapshot (teams.timer_seconds), the persisted
-- RUNNING -> ENDED transition at zero (finalize_team_if_due / expire_due_teams) and the no-extension guarantees.
-- How migration 16 treats a database that already contains started teams is proved separately, against real pre-B15
-- data, by supabase/tests/upgrade/b15_upgrade.upgrade.mjs.
begin;
\ir include/helpers.sql
\ir include/fixture.sql

set app.allow_test_clock = 'on';
set app.test_now = '2026-12-01 12:00:00+00';

create function pg_temp.at(ts text) returns void language plpgsql as $$
begin perform set_config('app.test_now', ts, false); end $$;
create function pg_temp.key(n int) returns uuid language sql as
  $$ select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.team_id(t int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-0000000000b' || t)::uuid $$;
create function pg_temp.member_id(t int, s int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-00000000c' || t || '0' || s)::uuid $$;
create function pg_temp.staff(n int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-0000000000a' || n)::uuid $$;
create function pg_temp.status(act text, n int) returns jsonb language sql as
  $$ select public.set_competition_status(pg_temp.staff(1), act, pg_temp.key(n)) $$;
create function pg_temp.start(t int, s int, n int) returns jsonb language sql as
  $$ select public.start_team_competition(pg_temp.team_id(t), pg_temp.member_id(t, s), pg_temp.key(n)) $$;
create function pg_temp.unlock(t int, s int, theme int, n int) returns jsonb language sql as
  $$ select public.unlock_theme(pg_temp.team_id(t), pg_temp.member_id(t, s), theme::smallint, pg_temp.key(n)) $$;
create function pg_temp.enter(t int, s int, q int, n int) returns jsonb language sql as
  $$ select public.start_question(pg_temp.team_id(t), pg_temp.member_id(t, s), q::smallint, pg_temp.key(n)) $$;
create function pg_temp.state(t int, s int) returns jsonb language sql as
  $$ select public.get_team_state(pg_temp.team_id(t), pg_temp.member_id(t, s)) $$;
create function pg_temp.tq(t int, q int) returns team_questions language sql as
  $$ select * from team_questions where team_id = pg_temp.team_id(t) and question_id = q $$;
create function pg_temp.fin(t int) returns jsonb language sql as $$ select public.finalize_team_if_due(pg_temp.team_id(t)) $$;
create function pg_temp.tv(t int) returns bigint language sql as $$ select state_version from teams where id = pg_temp.team_id(t) $$;

-- ===== 1. the competition-wide allowance ===========================================================================
do $$ begin
  assert (select ultimate_seconds = 14400 and ultimate_minutes = 240 from competition), 'competition allowance is 4 h';
  assert (select initial_coins = 500 from competition);
end $$;

-- ===== 2. a team that starts now gets 4 h, stored per team and reported per team ===================================
select pg_temp.status('open', 1);
select pg_temp.at('2026-12-01 12:00:00+00');
select pg_temp.start(1, 1, 2);
do $$
declare t teams%rowtype; s jsonb := pg_temp.state(1, 1);
begin
  select * into t from teams where id = pg_temp.team_id(1);
  assert t.ends_at - t.started_at = interval '14400 seconds' and t.timer_seconds = 14400, '4 h, snapshotted on the team';
  assert (s->'team'->>'duration_seconds')::int = 14400 and (s->'team'->>'remaining_seconds')::int = 14400;
  assert not (s->'team'->>'frozen')::boolean and not (s->'team'->>'expired')::boolean;
  assert (select (payload->>'ultimate_seconds')::int = 14400 from audit_events where event_type = 'TEAM_STARTED' and team_id = pg_temp.team_id(1));
end $$;
-- a team that has not started reports the competition value and a null snapshot
do $$ begin
  assert (pg_temp.state(2, 1)->'team'->>'duration_seconds')::int = 14400 and (select timer_seconds is null from teams where id = pg_temp.team_id(2));
end $$;

-- ===== 3. mixed allowances: a team that started under the 2 h rule keeps exactly 7200 s ============================
-- (set up directly, the way an existing pre-B15 team looks after migration 16: timer_seconds = 7200, ends_at untouched)
update teams set status = 'RUNNING', started_at = timestamptz '2026-12-01 10:00:00+00', timer_seconds = 7200,
                 ends_at = timestamptz '2026-12-01 12:00:00+00'
 where id = pg_temp.team_id(2);
do $$
declare s jsonb := pg_temp.state(2, 1);
begin
  assert (s->'team'->>'duration_seconds')::int = 7200, 'a legacy team still reports its own 2 h allowance';
  assert (s->'team'->>'remaining_seconds')::int = 0 and (s->'team'->>'expired')::boolean and (s->'team'->>'frozen')::boolean,
         'its own end has passed: expired and frozen, status still RUNNING until finalized';
  assert s->'team'->>'status' = 'RUNNING', 'a read never changes the stored status';
  assert (pg_temp.state(1, 1)->'team'->>'duration_seconds')::int = 14400, 'the other team is unaffected';
end $$;

-- ===== 4. finalize_team_if_due ======================================================================================
-- not due: no write at all
do $$
declare v bigint := pg_temp.tv(1); r jsonb;
begin
  r := pg_temp.fin(1);
  assert not (r->>'finalized')::boolean and r->>'status' = 'RUNNING';
  assert pg_temp.tv(1) = v and (select status = 'RUNNING' and ended_at is null from teams where id = pg_temp.team_id(1));
end $$;
select pg_temp.rejects($s$select public.finalize_team_if_due(gen_random_uuid())$s$, 'NOT_FOUND');
select pg_temp.rejects($s$select public.finalize_team_if_due(null)$s$, 'NOT_FOUND');

-- the legacy team is due (its 2 h are over): ended_at = its own ends_at, NOT the moment the function runs; coins untouched
select pg_temp.at('2026-12-01 13:30:00+00');
do $$
declare v bigint := pg_temp.tv(2); r jsonb; t teams%rowtype;
begin
  r := pg_temp.fin(2);
  assert (r->>'finalized')::boolean and r->>'status' = 'ENDED';
  select * into t from teams where id = pg_temp.team_id(2);
  assert t.status = 'ENDED' and t.ended_at = timestamptz '2026-12-01 12:00:00+00', 'ended_at = ends_at, not 13:30';
  assert t.ends_at = timestamptz '2026-12-01 12:00:00+00' and t.started_at = timestamptz '2026-12-01 10:00:00+00', 'nothing extended';
  assert t.timer_seconds = 7200 and t.coins = 500, 'still 2 h, coins untouched';
  assert pg_temp.tv(2) = v + 1, 'one version bump';
  assert (select count(*) from audit_events where event_type = 'TEAM_ENDED' and team_id = pg_temp.team_id(2)
                 and actor_kind = 'SYSTEM' and payload->>'reason' = 'TIMER') = 1;
  -- idempotent
  r := pg_temp.fin(2);
  assert not (r->>'finalized')::boolean and r->>'status' = 'ENDED' and pg_temp.tv(2) = v + 1, 'a second call changes nothing';
  assert (select count(*) from audit_events where event_type = 'TEAM_ENDED' and team_id = pg_temp.team_id(2)) = 1;
  -- the frozen snapshot is constant
  assert (pg_temp.state(2, 1)->'team'->>'remaining_seconds')::int = 0 and (pg_temp.state(2, 1)->'team'->>'frozen')::boolean;
end $$;

-- ===== 5. questions at the moment of the freeze =====================================================================
-- team 1 (ends 16:00): Q1 entered 15:52:30 (deadline 15:56:30: overdue at the end), Q6 entered 15:56:10 (deadline 16:00:10: still ahead).
-- No mutation happens after Q6 is entered, so nothing has materialised Q1 as TIMED_OUT yet.
select pg_temp.at('2026-12-01 15:49:00+00');
select pg_temp.unlock(1, 1, 1, 10);
select pg_temp.unlock(1, 2, 2, 11);
select pg_temp.at('2026-12-01 15:52:30+00');
select pg_temp.enter(1, 1, 1, 12);
select pg_temp.at('2026-12-01 15:56:10+00');
select pg_temp.enter(1, 1, 6, 13);
do $$ begin
  assert (pg_temp.tq(1, 1)).state = 'ACTIVE' and (pg_temp.tq(1, 1)).timer_deadline = timestamptz '2026-12-01 15:56:30+00';
  assert (pg_temp.tq(1, 6)).timer_deadline = timestamptz '2026-12-01 16:00:10+00';
end $$;
-- at the end a mutation is refused and leaves nothing behind
select pg_temp.at('2026-12-01 16:00:00+00');
do $$
declare v bigint := pg_temp.tv(1); c int := (select coins from teams where id = pg_temp.team_id(1)); n int := (select count(*) from request_log);
begin
  begin perform pg_temp.unlock(1, 3, 3, 15); raise exception 'unlock succeeded at ends_at';
  exception when others then assert sqlerrm = 'TEAM_ENDED', sqlerrm; end;
  begin perform pg_temp.enter(1, 1, 6, 16); raise exception 'enter succeeded at ends_at';
  exception when others then assert sqlerrm = 'TEAM_ENDED', sqlerrm; end;
  assert pg_temp.tv(1) = v and (select coins from teams where id = pg_temp.team_id(1)) = c and (select count(*) from request_log) = n,
         'a rejected request writes nothing';
  assert (select status = 'RUNNING' from teams where id = pg_temp.team_id(1)), 'the rejection did not persist the end (it rolls back)';
end $$;
-- ... which is exactly why the lazy path exists: it persists the end in its own transaction
do $$
declare v bigint := pg_temp.tv(1); r jsonb; t teams%rowtype;
begin
  r := pg_temp.fin(1);
  select * into t from teams where id = pg_temp.team_id(1);
  assert (r->>'finalized')::boolean and t.status = 'ENDED' and t.ended_at = t.ends_at and t.ends_at = timestamptz '2026-12-01 16:00:00+00';
  assert t.timer_seconds = 14400;
  assert (pg_temp.tq(1, 1)).state = 'TIMED_OUT' and (pg_temp.tq(1, 1)).timed_out_at = timestamptz '2026-12-01 15:56:30+00', 'overdue question timed out at its own deadline';
  assert (pg_temp.tq(1, 6)).state = 'ACTIVE' and (pg_temp.tq(1, 6)).timer_deadline = timestamptz '2026-12-01 16:00:10+00',
         'a question whose own deadline is still ahead stays ACTIVE (shown frozen)';
  assert pg_temp.tv(1) = v + 1;
end $$;
-- the frozen question never gains time: it reports the seconds it had at the end, however late we look
select pg_temp.at('2026-12-01 20:00:00+00');
do $$
declare q jsonb;
begin
  q := public.get_question_for_team(pg_temp.team_id(1), pg_temp.member_id(1, 1), 6::smallint)->'question';
  assert q->>'state' = 'ACTIVE' and (q->>'remaining_seconds')::int = 10, 'frozen at the 10 s it had at the end';
  assert (pg_temp.state(1, 1)->'team'->>'remaining_seconds')::int = 0 and (pg_temp.state(1, 1)->'team'->>'frozen')::boolean;
end $$;
select pg_temp.rejects($s$select pg_temp.enter(1, 1, 6, 17)$s$, 'TEAM_ENDED');

-- ===== 6. the sweeper ===============================================================================================
-- fresh clock; three more teams in this scenario are created directly (started rows need timer_seconds)
reset app.test_now;
rollback;

begin;
\ir include/helpers.sql
\ir include/fixture.sql
set app.allow_test_clock = 'on';
set app.test_now = '2026-12-01 12:00:00+00';
create function pg_temp.at(ts text) returns void language plpgsql as $$
begin perform set_config('app.test_now', ts, false); end $$;
create function pg_temp.key(n int) returns uuid language sql as
  $$ select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.team_id(t int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-0000000000b' || t)::uuid $$;
create function pg_temp.staff(n int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-0000000000a' || n)::uuid $$;
create function pg_temp.status(act text, n int) returns jsonb language sql as
  $$ select public.set_competition_status(pg_temp.staff(1), act, pg_temp.key(n)) $$;
create function pg_temp.start(t int, s int, n int) returns jsonb language sql as
  $$ select public.start_team_competition(pg_temp.team_id(t), ('00000000-0000-0000-0000-00000000c' || t || '0' || s)::uuid, pg_temp.key(n)) $$;
create function pg_temp.tv(t int) returns bigint language sql as $$ select state_version from teams where id = pg_temp.team_id(t) $$;

select pg_temp.status('open', 1);
-- competition not RUNNING: nothing is due, whatever the clock says
do $$ begin assert public.expire_due_teams() = 0; end $$;
select pg_temp.start(1, 1, 2);                                   -- 12:00 -> 16:00
update teams set status = 'RUNNING', started_at = timestamptz '2026-12-01 09:00:00+00', timer_seconds = 7200,
                 ends_at = timestamptz '2026-12-01 11:00:00+00'
 where id = pg_temp.team_id(2);                                  -- a legacy 2 h team, long over
do $$
declare v1 bigint := pg_temp.tv(1); v2 bigint := pg_temp.tv(2); n int;
begin
  n := public.expire_due_teams();
  assert n = 1, 'only the due team is finalized';
  assert (select status = 'ENDED' and ended_at = timestamptz '2026-12-01 11:00:00+00' from teams where id = pg_temp.team_id(2));
  assert (select status = 'RUNNING' from teams where id = pg_temp.team_id(1)) and pg_temp.tv(1) = v1, 'the running team is untouched';
  assert pg_temp.tv(2) = v2 + 1;
  assert public.expire_due_teams() = 0, 'idempotent';
  assert (select count(*) from audit_events where event_type = 'TEAM_ENDED' and team_id = pg_temp.team_id(2)) = 1;
end $$;
select pg_temp.rejects($s$select public.expire_due_teams(0)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.expire_due_teams(5000)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.expire_due_teams(null)$s$, 'VALIDATION_FAILED');
-- the limit is honoured
update teams set status = 'NOT_STARTED', started_at = null, timer_seconds = null, ends_at = null, ended_at = null where id = pg_temp.team_id(2);
update teams set ends_at = timestamptz '2026-12-01 11:30:00+00', started_at = timestamptz '2026-12-01 09:30:00+00', timer_seconds = 7200 where id = pg_temp.team_id(1);
update teams set status = 'RUNNING', started_at = timestamptz '2026-12-01 09:00:00+00', timer_seconds = 7200, ends_at = timestamptz '2026-12-01 11:00:00+00'
 where id = pg_temp.team_id(2);
do $$ begin
  assert public.expire_due_teams(1) = 1, 'limit 1';
  assert (select status from teams where id = pg_temp.team_id(2)) = 'ENDED' and (select status from teams where id = pg_temp.team_id(1)) = 'RUNNING', 'earliest end first';
  assert public.expire_due_teams(10) = 1;
  assert (select count(*) from teams where status = 'RUNNING') = 0;
end $$;

-- ===== 7. a paused competition has nothing due; resume ends the team at its own end =================================
rollback;

begin;
\ir include/helpers.sql
\ir include/fixture.sql
set app.allow_test_clock = 'on';
set app.test_now = '2026-12-01 12:00:00+00';
create function pg_temp.at(ts text) returns void language plpgsql as $$
begin perform set_config('app.test_now', ts, false); end $$;
create function pg_temp.key(n int) returns uuid language sql as
  $$ select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.team_id(t int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-0000000000b' || t)::uuid $$;
create function pg_temp.staff(n int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-0000000000a' || n)::uuid $$;
create function pg_temp.status(act text, n int) returns jsonb language sql as
  $$ select public.set_competition_status(pg_temp.staff(1), act, pg_temp.key(n)) $$;
create function pg_temp.start(t int, s int, n int) returns jsonb language sql as
  $$ select public.start_team_competition(pg_temp.team_id(t), ('00000000-0000-0000-0000-00000000c' || t || '0' || s)::uuid, pg_temp.key(n)) $$;

select pg_temp.status('open', 1);
select pg_temp.start(1, 1, 2);                                   -- 12:00 -> 16:00
-- one millisecond before the end a mutation still works; at the end it is refused
select pg_temp.at('2026-12-01 15:59:59.999+00');
select public.unlock_theme(pg_temp.team_id(1), ('00000000-0000-0000-0000-00000000c101')::uuid, 1::smallint, pg_temp.key(5));
do $$ begin assert (select coins = 400 from teams where id = pg_temp.team_id(1)), '1 ms before ends_at the unlock still succeeds'; end $$;
select pg_temp.at('2026-12-01 16:00:00+00');
select pg_temp.rejects($s$select public.unlock_theme(pg_temp.team_id(1), '00000000-0000-0000-0000-00000000c101'::uuid, 2::smallint, pg_temp.key(6))$s$, 'TEAM_ENDED');
select pg_temp.at('2026-12-01 16:30:00+00');
select pg_temp.status('pause', 3);                               -- paused half an hour after the team's end, never finalized
select pg_temp.at('2026-12-01 17:00:00+00');
do $$ begin
  assert not (public.finalize_team_if_due(pg_temp.team_id(1))->>'finalized')::boolean, 'nothing is due while paused';
  assert public.expire_due_teams() = 0;
  assert (select status = 'RUNNING' from teams where id = pg_temp.team_id(1));
  assert (select ends_at = timestamptz '2026-12-01 16:00:00+00' from teams where id = pg_temp.team_id(1)), 'not shifted yet';
end $$;
select pg_temp.status('resume', 4);
do $$ begin
  assert (select status = 'ENDED' and ended_at = timestamptz '2026-12-01 16:00:00+00' and ends_at = timestamptz '2026-12-01 16:00:00+00' from teams where id = pg_temp.team_id(1)),
         'resume ends it at its own end; it is never revived by the shift';
end $$;
-- privileges: service_role only
do $$ begin
  assert not has_function_privilege('anon', 'public.finalize_team_if_due(uuid)', 'execute');
  assert not has_function_privilege('authenticated', 'public.finalize_team_if_due(uuid)', 'execute');
  assert not has_function_privilege('anon', 'public.expire_due_teams(int)', 'execute');
  assert not has_function_privilege('authenticated', 'public.expire_due_teams(int)', 'execute');
  assert has_function_privilege('service_role', 'public.finalize_team_if_due(uuid)', 'execute');
  assert has_function_privilege('service_role', 'public.expire_due_teams(int)', 'execute');
end $$;
rollback;

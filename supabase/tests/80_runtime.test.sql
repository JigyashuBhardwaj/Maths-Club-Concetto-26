-- Competition runtime engine (migration 12): status transitions, start_team_competition, the authoritative team
-- snapshot, idempotency, audit, state_version, privileges. The multi-connection race is tested by
-- supabase/tests/concurrency/start_team.concurrency.mjs (it needs real parallel sessions).
begin;
\ir include/helpers.sql
\ir include/fixture.sql

set app.allow_test_clock = 'on';
set app.test_now = '2026-12-01 12:00:00+00';

create function pg_temp.at(ts text) returns void language plpgsql as $$
begin perform set_config('app.test_now', ts, false); end $$;
create function pg_temp.key(n int) returns uuid language sql as
  $$ select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
-- staff a1 = SUPER_ADMIN, a2/a3 = ADMIN (fixture)
create function pg_temp.status(act text, n int) returns jsonb language sql as
  $$ select public.set_competition_status('00000000-0000-0000-0000-0000000000a1', act, pg_temp.key(n)) $$;
-- team t (1|2), member slot s, key n
create function pg_temp.team_id(t int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-0000000000b' || t)::uuid $$;
create function pg_temp.member_id(t int, s int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-00000000c' || t || '0' || s)::uuid $$;
create function pg_temp.start(t int, s int, n int) returns jsonb language sql as
  $$ select public.start_team_competition(pg_temp.team_id(t), pg_temp.member_id(t, s), pg_temp.key(n)) $$;
create function pg_temp.state(t int, s int) returns jsonb language sql as
  $$ select public.get_team_state(pg_temp.team_id(t), pg_temp.member_id(t, s)) $$;
create function pg_temp.remaining(t int) returns int language sql as
  $$ select (pg_temp.state(t, 1)->'team'->>'remaining_seconds')::int $$;
create function pg_temp.tv(t int) returns bigint language sql as $$ select state_version from teams where id = pg_temp.team_id(t) $$;
create function pg_temp.cv() returns bigint language sql as $$ select state_version from competition where id = 1 $$;
create function pg_temp.keys_of(j jsonb) returns text[] language sql as $$
  select coalesce(array(select distinct jsonb_array_elements_text(jsonb_path_query_array(j, '$.** ? (@.type() == "object").keyvalue().key'))), '{}') $$;

-- ===== 1. a fresh competition is in SETUP ===========================================================================
do $$ begin
  assert (select count(*) from competition) = 1, 'exactly one competition row';
  assert (select status from competition) = 'SETUP', 'the competition starts in SETUP';
  assert (select opened_at is null and paused_at is null and ended_at is null and state_version = 0 from competition);
  assert (select count(*) from teams where status <> 'NOT_STARTED') = 0;
end $$;

-- ===== 5. a participant cannot start the team while SETUP ===========================================================
select pg_temp.rejects($s$select pg_temp.start(1, 1, 1)$s$, 'COMPETITION_NOT_RUNNING');
do $$ begin
  assert (select status from teams where id = pg_temp.team_id(1)) = 'NOT_STARTED' and (select started_at is null from teams where id = pg_temp.team_id(1));
  assert not exists (select 1 from request_log), 'a rejected request is not stored (it may be retried with the same key)';
end $$;

-- ===== 3/17. illegal transitions and unauthorised callers are rejected ==============================================
select pg_temp.rejects($s$select pg_temp.status('pause', 2)$s$, 'INVALID_COMPETITION_TRANSITION');
select pg_temp.rejects($s$select pg_temp.status('resume', 2)$s$, 'INVALID_COMPETITION_TRANSITION');
select pg_temp.rejects($s$select pg_temp.status('end', 2)$s$, 'INVALID_COMPETITION_TRANSITION');
select pg_temp.rejects($s$select pg_temp.status('reopen', 2)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.set_competition_status('00000000-0000-0000-0000-0000000000a1', 'open', null)$s$, 'VALIDATION_FAILED');
-- 17. only an active SUPER_ADMIN may change the status
select pg_temp.rejects($s$select public.set_competition_status('00000000-0000-0000-0000-0000000000a2', 'open', pg_temp.key(3))$s$, 'FORBIDDEN');   -- ADMIN
select pg_temp.rejects($s$select public.set_competition_status('00000000-0000-0000-0000-0000000000a3', 'open', pg_temp.key(3))$s$, 'FORBIDDEN');   -- ADMIN
select pg_temp.rejects($s$select public.set_competition_status(gen_random_uuid(), 'open', pg_temp.key(3))$s$, 'FORBIDDEN');                          -- unknown staff
select pg_temp.rejects($s$select public.set_competition_status(null, 'open', pg_temp.key(3))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.set_competition_status(pg_temp.member_id(1, 1), 'open', pg_temp.key(3))$s$, 'FORBIDDEN');                  -- a member id is not staff
update staff_users set is_active = false where id = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.rejects($s$select pg_temp.status('open', 3)$s$, 'FORBIDDEN');                                                                         -- disabled super admin
update staff_users set is_active = true where id = '00000000-0000-0000-0000-0000000000a1';
do $$ begin
  assert (select status from competition) = 'SETUP' and pg_temp.cv() = 0, 'nothing changed by any rejection';
  assert not exists (select 1 from audit_events where event_type = 'COMPETITION_STATUS_CHANGED');
end $$;

-- ===== 2/4. legal transitions, audited, with state_version ==========================================================
create temp table v0 as select pg_temp.cv() as cv, pg_temp.tv(1) as t1, pg_temp.tv(2) as t2;
select pg_temp.at('2026-12-01 12:00:00+00');
create temp table s_open as select pg_temp.status('open', 10) as j;
do $$
declare j jsonb := (select j from s_open);
begin
  assert (j->>'changed')::boolean and j->>'from' = 'SETUP' and j->>'to' = 'RUNNING' and not (j->>'replayed')::boolean;
  assert (select status from competition) = 'RUNNING';
  assert (select opened_at = timestamptz '2026-12-01 12:00:00+00' and paused_at is null and ended_at is null from competition);
  -- 18. versions: competition +1, every team +1
  assert pg_temp.cv() = (select cv from v0) + 1;
  assert pg_temp.tv(1) = (select t1 from v0) + 1 and pg_temp.tv(2) = (select t2 from v0) + 1, 'every team snapshot changed (competition status is part of it)';
  -- 4. audit
  assert (select count(*) from audit_events where event_type = 'COMPETITION_STATUS_CHANGED') = 1;
  assert (select actor_kind = 'STAFF' and staff_id = '00000000-0000-0000-0000-0000000000a1' and entity_type = 'COMPETITION'
                 and payload->>'from' = 'SETUP' and payload->>'to' = 'RUNNING' and payload->>'action' = 'open' and request_id = pg_temp.key(10)
            from audit_events where event_type = 'COMPETITION_STATUS_CHANGED');
  assert j->'competition'->>'status' = 'RUNNING' and (j->'competition'->>'state_version')::int = 1;
end $$;

-- idempotent: the same action when already there is a no-op (new key) and a replay (same key)
do $$
declare noop jsonb; rep jsonb; cv0 bigint := pg_temp.cv(); t10 bigint := pg_temp.tv(1);
begin
  noop := pg_temp.status('open', 11);
  assert not (noop->>'changed')::boolean and noop->>'from' = 'RUNNING' and noop->>'to' = 'RUNNING', 'open when RUNNING is a no-op';
  noop := pg_temp.status('resume', 12);
  assert not (noop->>'changed')::boolean, 'resume when RUNNING is a no-op';
  rep := pg_temp.status('open', 10);
  assert (rep->>'replayed')::boolean and (rep->>'changed')::boolean, 'same key replays the stored response';
  assert pg_temp.cv() = cv0 and pg_temp.tv(1) = t10, 'no-ops and replays change no version';
  assert (select count(*) from audit_events where event_type = 'COMPETITION_STATUS_CHANGED') = 1, 'and write no audit row';
end $$;
-- a key belongs to one operation + parameter
select pg_temp.rejects($s$select pg_temp.status('pause', 10)$s$, 'IDEMPOTENCY_KEY_REUSED');

-- ===== 6/8/16. start while RUNNING: exactly 14400 s (B15: 4 h), audited =========================================================
select pg_temp.at('2026-12-01 12:10:00+00');
create temp table b_start as select pg_temp.tv(1) as tv, pg_temp.tv(2) as tv2;
create temp table st1 as select pg_temp.start(1, 2, 20) as j;
do $$
declare j jsonb := (select j from st1); t teams%rowtype;
begin
  select * into t from teams where id = pg_temp.team_id(1);
  assert (j->>'started_now')::boolean and not (j->>'replayed')::boolean;
  assert t.status = 'RUNNING' and t.started_at = timestamptz '2026-12-01 12:10:00+00', 'started at the authoritative now';
  assert t.ends_at - t.started_at = interval '14400 seconds', 'exactly 14400 s';
  assert t.ends_at = timestamptz '2026-12-01 16:10:00+00';
  assert t.timer_seconds = 14400, 'the allowance this team was given is stored (B15)';
  assert (j->'state'->'team'->>'started_at')::bigint = 1796127000000 and (j->'state'->'team'->>'ends_at')::bigint = 1796141400000, 'epoch ms in the response';
  assert (j->'state'->'team'->>'remaining_seconds')::int = 14400 and (j->'state'->'team'->>'duration_seconds')::int = 14400;
  assert j->'state'->'team'->>'status' = 'RUNNING' and j->'state'->'competition'->>'status' = 'RUNNING';
  assert (j->'state'->'team'->>'coins')::int = 500 and not (j->'state'->'team'->>'expired')::boolean;
  -- 18. version +1 for the started team only
  assert pg_temp.tv(1) = (select tv from b_start) + 1 and pg_temp.tv(2) = (select tv2 from b_start), 'only the started team changes';
  assert (j->'state'->>'state_version')::bigint = pg_temp.tv(1), 'the response carries the new version';
  -- 16. audit
  assert (select count(*) from audit_events where event_type = 'TEAM_STARTED' and team_id = pg_temp.team_id(1)) = 1;
  assert (select actor_kind = 'MEMBER' and member_id = pg_temp.member_id(1, 2) and request_id = pg_temp.key(20)
                 and (payload->>'started_at')::bigint = 1796127000000 and (payload->>'ultimate_seconds')::int = 14400
            from audit_events where event_type = 'TEAM_STARTED' and team_id = pg_temp.team_id(1));
  assert (select count(*) from coin_transactions where team_id = pg_temp.team_id(1)) = 1, 'starting touches no coins';
end $$;

-- ===== 9/19. repeated start is idempotent: same key, new key, other member, later time ============================
select pg_temp.at('2026-12-01 12:20:00+00');
do $$
declare a jsonb; b jsonb; c jsonb; t0 teams%rowtype; tv0 bigint := pg_temp.tv(1);
begin
  select * into t0 from teams where id = pg_temp.team_id(1);
  a := pg_temp.start(1, 2, 20);                         -- same member, same key: replay
  assert (a->>'replayed')::boolean and (a->>'started_now')::boolean, 'a replay returns the stored response';
  assert a->'state'->'team'->>'started_at' = '1796127000000' and a->'state'->'team'->>'ends_at' = '1796141400000';
  b := pg_temp.start(1, 2, 21);                         -- same member, new key (a re-entry)
  assert not (b->>'replayed')::boolean and not (b->>'started_now')::boolean, 'a second start does not start again';
  c := pg_temp.start(1, 3, 22);                         -- another member of the team, later
  assert not (c->>'started_now')::boolean;
  assert b->'state'->'team'->>'started_at' = '1796127000000' and c->'state'->'team'->>'started_at' = '1796127000000', 'same authoritative start';
  assert b->'state'->'team'->>'ends_at' = '1796141400000' and c->'state'->'team'->>'ends_at' = '1796141400000', 'same authoritative end';
  assert (c->'state'->'team'->>'remaining_seconds')::int = 13800, 'the later member sees the already reduced timer (CE-02)';
  assert (select (started_at, ends_at) is not distinct from (t0.started_at, t0.ends_at) from teams where id = pg_temp.team_id(1)), 'the timer is never reset';
  assert pg_temp.tv(1) = tv0, 'no version bump for no-ops';
  assert (select count(*) from audit_events where event_type = 'TEAM_STARTED' and team_id = pg_temp.team_id(1)) = 1, 'one audit row';
  assert (select count(*) from request_log where team_id = pg_temp.team_id(1)) = 3;
end $$;
-- a key bound to one member cannot be replayed by another
select pg_temp.rejects($s$select pg_temp.start(1, 4, 20)$s$, 'IDEMPOTENCY_KEY_REUSED');
select pg_temp.rejects($s$select public.start_team_competition(pg_temp.team_id(1), pg_temp.member_id(1, 2), null)$s$, 'VALIDATION_FAILED');

-- ===== 11. a non-member cannot start or read another team's timer ===================================================
select pg_temp.rejects($s$select public.start_team_competition(pg_temp.team_id(2), pg_temp.member_id(1, 1), pg_temp.key(30))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.get_team_state(pg_temp.team_id(2), pg_temp.member_id(1, 1))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.start_team_competition(pg_temp.team_id(2), null, pg_temp.key(30))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.start_team_competition(null, pg_temp.member_id(2, 1), pg_temp.key(30))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.start_team_competition(gen_random_uuid(), pg_temp.member_id(2, 1), pg_temp.key(30))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.get_team_state(pg_temp.team_id(2), gen_random_uuid())$s$, 'FORBIDDEN');
do $$ begin
  assert (select status = 'NOT_STARTED' and started_at is null from teams where id = pg_temp.team_id(2)), 'team 2 untouched';
end $$;

-- ===== 12/13. authoritative remaining seconds; clamp to zero; never extended ========================================
select pg_temp.at('2026-12-01 12:10:00+00');   do $$ begin assert pg_temp.remaining(1) = 14400; end $$;
select pg_temp.at('2026-12-01 12:10:00.4+00'); do $$ begin assert pg_temp.remaining(1) = 14399, 'floor: 14399.6 -> 14399'; end $$;
select pg_temp.at('2026-12-01 12:10:01+00');   do $$ begin assert pg_temp.remaining(1) = 14399; end $$;
select pg_temp.at('2026-12-01 15:10:00+00');   do $$ begin assert pg_temp.remaining(1) = 3600; end $$;
select pg_temp.at('2026-12-01 16:09:59+00');   do $$ begin assert pg_temp.remaining(1) = 1 and not (pg_temp.state(1, 1)->'team'->>'expired')::boolean; end $$;
select pg_temp.at('2026-12-01 16:09:59.5+00'); do $$ begin assert pg_temp.remaining(1) = 0, '0.5 s left floors to 0'; assert not (pg_temp.state(1, 1)->'team'->>'expired')::boolean, 'not yet expired'; end $$;
select pg_temp.at('2026-12-01 16:10:00+00');   do $$ begin assert pg_temp.remaining(1) = 0 and (pg_temp.state(1, 1)->'team'->>'expired')::boolean, 'exactly at ends_at: 0 and expired'; end $$;
select pg_temp.at('2026-12-01 20:00:00+00');
do $$
declare s jsonb; t0 teams%rowtype; r jsonb; tv0 bigint := pg_temp.tv(1);
begin
  s := pg_temp.state(1, 1);
  assert (s->'team'->>'remaining_seconds')::int = 0, 'clamped to zero long after expiry (never negative)';
  assert (s->'team'->>'expired')::boolean and s->'team'->>'status' = 'RUNNING', 'an expired team is reported, not silently changed';
  assert (select started_at = timestamptz '2026-12-01 12:10:00+00' and ends_at = timestamptz '2026-12-01 16:10:00+00' and status = 'RUNNING'
            from teams where id = pg_temp.team_id(1)), 'the timer is neither reset nor extended by reading it';
  r := pg_temp.start(1, 1, 40);                          -- entering again after expiry returns the same times
  assert not (r->>'started_now')::boolean and r->'state'->'team'->>'started_at' = '1796127000000' and r->'state'->'team'->>'ends_at' = '1796141400000';
  assert pg_temp.tv(1) = tv0, 'reading and re-entering never bump the version';
  assert (select count(*) from audit_events where event_type = 'TEAM_STARTED' and team_id = pg_temp.team_id(1)) = 1;
end $$;
-- a NOT_STARTED team reports the full duration and no timestamps
do $$
declare s jsonb := pg_temp.state(2, 1);
begin
  assert s->'team'->>'status' = 'NOT_STARTED' and (s->'team'->>'remaining_seconds')::int = 14400 and (s->'team'->>'duration_seconds')::int = 14400;
  assert s->'team'->'started_at' = 'null'::jsonb and s->'team'->'ends_at' = 'null'::jsonb and s->'team'->'ended_at' = 'null'::jsonb;
  assert jsonb_array_length(s->'themes') = 10 and (select bool_and(t->>'status' = 'LOCKED' and t->'questions' = '[]'::jsonb) from jsonb_array_elements(s->'themes') t),
         'all 10 themes LOCKED with no question data';
  assert (s->'me'->>'slot')::int = 1 and s->'me'->>'team_code' = 'T02' and s->'me'->>'team_name' = 'Test Team 2';
end $$;

-- ===== 14. no hash, token, password or admission number is ever returned ===========================================
do $$
declare s jsonb := pg_temp.state(1, 1); r jsonb := pg_temp.start(1, 1, 40); c jsonb := pg_temp.status('open', 11);
begin
  assert not (pg_temp.keys_of(s) || pg_temp.keys_of(r) || pg_temp.keys_of(c)) && array['password_hash', 'token_hash', 'password', 'admission_no', 'secret', 'login_id'], 'no sensitive key';
  assert s::text !~* '(hash|password|secret|\$2[abxy]\$|TEST-NOT-A-HASH|TEST1[1-4]|TEST2[1-4]|test_team_0)', 'no sensitive value in the snapshot';
  assert r::text !~* '(hash|password|secret|\$2[abxy]\$|TEST-NOT-A-HASH|TEST1[1-4]|test_team_0)';
  assert (select count(*) from audit_events where payload::text ~* '(hash|password|secret|\$2[abxy]\$|TEST-NOT-A-HASH)') = 0, 'nor in the audit trail';
  assert (select count(*) from request_log where response::text ~* '(hash|password|secret|\$2[abxy]\$|TEST-NOT-A-HASH)') = 0, 'nor in the stored responses';
end $$;

-- ===== 15. terminal teams cannot be started again ==================================================================
do $$
declare t uuid;
begin
  -- FINAL_SUBMITTED / ENDED / DISQUALIFIED are set directly by test setup (their operations arrive in later patches)
  update teams set status = 'FINAL_SUBMITTED', started_at = '2026-12-01 12:30:00+00', ends_at = '2026-12-01 14:30:00+00', timer_seconds = 7200,
                   ended_at = '2026-12-01 13:00:00+00', final_submitted_at = '2026-12-01 13:00:00+00'
   where id = pg_temp.team_id(2);
  begin perform pg_temp.start(2, 1, 50); raise exception 'FINAL_SUBMITTED team was started';
  exception when others then if sqlerrm <> 'ALREADY_SUBMITTED' then raise; end if; end;
  update teams set status = 'ENDED', final_submitted_at = null where id = pg_temp.team_id(2);
  begin perform pg_temp.start(2, 1, 51); raise exception 'ENDED team was started';
  exception when others then if sqlerrm <> 'TEAM_ENDED' then raise; end if; end;
  update teams set status = 'DISQUALIFIED', score_override = -1201 where id = pg_temp.team_id(2);
  begin perform pg_temp.start(2, 1, 52); raise exception 'DISQUALIFIED team was started';
  exception when others then if sqlerrm <> 'TEAM_ENDED' then raise; end if; end;
  assert (select status = 'DISQUALIFIED' and started_at = '2026-12-01 12:30:00+00' from teams where id = pg_temp.team_id(2)), 'timer untouched';
  assert (select count(*) from request_log where idem_key in (pg_temp.key(50), pg_temp.key(51), pg_temp.key(52))) = 0, 'rejections are not stored';
  update teams set status = 'NOT_STARTED', started_at = null, timer_seconds = null, ends_at = null, ended_at = null, score_override = null where id = pg_temp.team_id(2);
end $$;

-- ===== 7. PAUSED: no start (A); freeze; resume shifts exactly the paused duration ==================================
select pg_temp.at('2026-12-01 13:00:00+00');
-- a team that is mid-run (team 1: 12:10 -> 14:10), plus an ACTIVE question to shift
insert into team_themes (team_id, theme_id, unlocked_by, unlocked_at, cost_paid)
values (pg_temp.team_id(1), 1, pg_temp.member_id(1, 1), '2026-12-01 12:15:00+00', 0);
insert into team_questions (team_id, question_id, theme_id, ordinal, state, timer_deadline, activated_at)
values (pg_temp.team_id(1), 1, 1, 1, 'ACTIVE', '2026-12-01 13:30:00+00', '2026-12-01 12:20:00+00');
create temp table b_pause as select pg_temp.cv() as cv, pg_temp.tv(1) as t1, pg_temp.tv(2) as t2;
create temp table s_pause as select pg_temp.status('pause', 60) as j;
do $$
declare j jsonb := (select j from s_pause);
begin
  assert (j->>'changed')::boolean and j->'competition'->>'status' = 'PAUSED';
  assert (select paused_at = timestamptz '2026-12-01 13:00:00+00' from competition);
  assert pg_temp.cv() = (select cv from b_pause) + 1 and pg_temp.tv(1) = (select t1 from b_pause) + 1 and pg_temp.tv(2) = (select t2 from b_pause) + 1;
  assert (select payload->>'from' = 'RUNNING' and payload->>'to' = 'PAUSED' from audit_events where request_id = pg_temp.key(60));
  -- 7. the team that has not started cannot start while PAUSED; the running one just reads its state
  assert (select status from competition) = 'PAUSED';
end $$;
select pg_temp.rejects($s$select pg_temp.start(2, 1, 61)$s$, 'COMPETITION_PAUSED');
do $$
declare r jsonb; rem0 int;
begin
  assert (select status = 'NOT_STARTED' and started_at is null from teams where id = pg_temp.team_id(2)), 'no timer started during a pause';
  perform pg_temp.at('2026-12-01 13:00:00+00');
  rem0 := pg_temp.remaining(1);
  assert rem0 = 11400, 'team 1: 16:10 - 13:00 = 11400 s';
  -- every clock reads the instant of the pause
  perform pg_temp.at('2026-12-01 13:25:00+00');
  assert pg_temp.remaining(1) = 11400, 'the team clock is frozen while PAUSED';
  assert pg_temp.state(1, 1)->'competition'->>'status' = 'PAUSED';
  r := pg_temp.start(1, 1, 62);                        -- an already-running team may re-enter: existing state, no mutation
  assert not (r->>'started_now')::boolean and (r->'state'->'team'->>'remaining_seconds')::int = 11400;
end $$;
do $$ begin assert not (pg_temp.status('pause', 64)->>'changed')::boolean, 'pause when PAUSED is a no-op'; end $$;
select pg_temp.rejects($s$select pg_temp.status('open', 65)$s$, 'INVALID_COMPETITION_TRANSITION');   -- open only from SETUP

select pg_temp.at('2026-12-01 13:30:00+00');          -- paused for 30 minutes
create temp table b_resume as select pg_temp.cv() as cv, pg_temp.tv(1) as t1, pg_temp.tv(2) as t2;
create temp table s_resume as select pg_temp.status('resume', 66) as j;
do $$
declare j jsonb := (select j from s_resume);
begin
  assert (j->>'changed')::boolean and (j->>'paused_seconds')::int = 1800 and (j->>'teams_shifted')::int = 1 and (j->>'teams_ended')::int = 0;
  assert (select status = 'RUNNING' and paused_at is null from competition);
  assert (select ends_at = timestamptz '2026-12-01 16:40:00+00' and started_at = timestamptz '2026-12-01 12:10:00+00' from teams where id = pg_temp.team_id(1)),
         'ends_at moved by exactly the paused duration';
  assert (select ends_at - started_at = interval '16200 seconds' from teams where id = pg_temp.team_id(1)), 'wall span is 14400 + pause';
  assert (select timer_deadline = timestamptz '2026-12-01 14:00:00+00' from team_questions where team_id = pg_temp.team_id(1) and question_id = 1), 'ACTIVE question deadline shifted equally';
  assert (select status = 'NOT_STARTED' and ends_at is null from teams where id = pg_temp.team_id(2)), 'a NOT_STARTED team is not shifted';
  assert pg_temp.remaining(1) = 11400, 'remaining time after resume equals remaining time at pause';
  assert pg_temp.cv() = (select cv from b_resume) + 1 and pg_temp.tv(1) = (select t1 from b_resume) + 1 and pg_temp.tv(2) = (select t2 from b_resume) + 1;
  assert (select (payload->>'paused_seconds')::int = 1800 from audit_events where request_id = pg_temp.key(66)), 'audited with the delta';
  assert (select count(*) from audit_events where event_type = 'COMPETITION_STATUS_CHANGED') = 3, 'open, pause, resume';
  assert (pg_temp.status('resume', 66)->>'replayed')::boolean, 'a resume retry does not shift twice';
  assert (select ends_at = timestamptz '2026-12-01 16:40:00+00' from teams where id = pg_temp.team_id(1)), 'still shifted once';
end $$;
-- team 2 can start now that the competition runs again
do $$
declare r jsonb;
begin
  perform pg_temp.at('2026-12-01 13:31:00+00');
  r := pg_temp.start(2, 4, 67);
  assert (r->>'started_now')::boolean and (r->'state'->'team'->>'remaining_seconds')::int = 14400;
  assert (select ends_at - started_at = interval '14400 seconds' from teams where id = pg_temp.team_id(2));
end $$;

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
create function pg_temp.status(act text, n int) returns jsonb language sql as
  $$ select public.set_competition_status('00000000-0000-0000-0000-0000000000a1', act, pg_temp.key(n)) $$;
create function pg_temp.team_id(t int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-0000000000b' || t)::uuid $$;
create function pg_temp.member_id(t int, s int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-00000000c' || t || '0' || s)::uuid $$;
create function pg_temp.start(t int, s int, n int) returns jsonb language sql as
  $$ select public.start_team_competition(pg_temp.team_id(t), pg_temp.member_id(t, s), pg_temp.key(n)) $$;
create function pg_temp.state(t int, s int) returns jsonb language sql as
  $$ select public.get_team_state(pg_temp.team_id(t), pg_temp.member_id(t, s)) $$;

select pg_temp.status('open', 1);
select pg_temp.at('2026-12-01 12:00:00+00');
select pg_temp.start(1, 1, 2);                                  -- team 1: 12:00 -> 16:00 (4 h)

-- expired before the pause: must be ENDED by resume (ended_at = its scheduled end), never shifted back to life
select pg_temp.at('2026-12-01 16:30:00+00');
select pg_temp.start(2, 1, 3);                                  -- team 2: 16:30 -> 20:30
select pg_temp.at('2026-12-01 16:45:00+00');
select pg_temp.status('pause', 4);                              -- paused at 16:45: team 1 already expired at 16:00
select pg_temp.at('2026-12-01 17:15:00+00');
do $$
declare r jsonb;
begin
  assert (pg_temp.state(1, 1)->'team'->>'remaining_seconds')::int = 0 and (pg_temp.state(1, 1)->'team'->>'expired')::boolean, 'reported as expired while paused';
  assert (select status = 'RUNNING' from teams where id = pg_temp.team_id(1)), 'reading does not end it';
  r := pg_temp.status('resume', 5);                             -- 30 min pause
  assert (r->>'paused_seconds')::int = 1800 and (r->>'teams_ended')::int = 1 and (r->>'teams_shifted')::int = 1, 'one ended, one shifted';
  assert (select status = 'ENDED' and ended_at = timestamptz '2026-12-01 16:00:00+00' and ends_at = timestamptz '2026-12-01 16:00:00+00'
            from teams where id = pg_temp.team_id(1)), 'ended at its scheduled end, not extended';
  assert (select ends_at = timestamptz '2026-12-01 21:00:00+00' from teams where id = pg_temp.team_id(2)), 'the live team was shifted by 30 min';
  assert (select count(*) from audit_events where event_type = 'TEAM_ENDED' and team_id = pg_temp.team_id(1) and payload->>'reason' = 'TIMER' and actor_kind = 'STAFF') = 1;
  assert (pg_temp.state(1, 1)->'team'->>'status') = 'ENDED' and (pg_temp.state(1, 1)->'team'->>'remaining_seconds')::int = 0;
end $$;

-- end while PAUSED: the competition and every RUNNING team end at the instant of the pause
select pg_temp.at('2026-12-01 17:30:00+00');
select pg_temp.status('pause', 6);                              -- team 2: ends 21:00, 210 min left at the pause
select pg_temp.at('2026-12-01 18:30:00+00');
create temp table b_end as select (select state_version from competition) as cv, (select state_version from teams where id = pg_temp.team_id(2)) as t2;
do $$
declare r jsonb;
begin
  r := pg_temp.status('end', 7);
  assert (r->>'changed')::boolean and r->>'to' = 'ENDED' and (r->>'teams_ended')::int = 1;
  assert (select status = 'ENDED' and ended_at = timestamptz '2026-12-01 18:30:00+00' and paused_at is null from competition);
  assert (select status = 'ENDED' and ended_at = timestamptz '2026-12-01 17:30:00+00' from teams where id = pg_temp.team_id(2)), 'ended at the pause instant (clocks were frozen)';
  assert (select count(*) from teams where status = 'RUNNING') = 0;
  assert (select count(*) from audit_events where event_type = 'TEAM_ENDED' and payload->>'reason' = 'COMPETITION_ENDED') = 1;
  assert (select count(*) from audit_events where event_type = 'COMPETITION_STATUS_CHANGED' and payload->>'to' = 'ENDED') = 1;
  assert (select state_version from competition) = (select cv from b_end) + 1 and (select state_version from teams where id = pg_temp.team_id(2)) = (select t2 from b_end) + 1;
  -- 210 min were left at the pause and stay frozen at ended_at
  assert (pg_temp.state(2, 1)->'team'->>'remaining_seconds')::int = 12600 and pg_temp.state(2, 1)->'team'->>'status' = 'ENDED';
  assert (pg_temp.state(2, 1)->'competition'->>'status') = 'ENDED';
  assert not (pg_temp.status('end', 8)->>'changed')::boolean, 'end when ENDED is a no-op';
end $$;
select pg_temp.rejects($s$select pg_temp.status('open', 9)$s$, 'INVALID_COMPETITION_TRANSITION');
select pg_temp.rejects($s$select pg_temp.status('pause', 10)$s$, 'INVALID_COMPETITION_TRANSITION');
select pg_temp.rejects($s$select pg_temp.status('resume', 11)$s$, 'INVALID_COMPETITION_TRANSITION');
select pg_temp.rejects($s$select pg_temp.start(1, 1, 12)$s$, 'COMPETITION_NOT_RUNNING');
rollback;

-- ===== privileges: explicit, service_role only; browser roles are locked out =======================================
begin;
\ir include/helpers.sql
\ir include/fixture.sql
do $$
declare r record; n int := 0;
begin
  for r in select p.oid, p.proacl, p.oid::regprocedure::text as sig
             from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname in ('public', 'app')
              and p.prokind = 'f'
              and p.proname in ('set_competition_status', 'start_team_competition', 'get_team_state', 'fail', 'epoch_ms',
                                'require_super_admin', 'lock_team', 'idem_lookup', 'idem_store', 'team_state_json',
                                'competition_json', 'expire_team')
  loop
    n := n + 1;
    assert r.proacl is not null, r.sig || ': ACL must be explicit (a NULL ACL means EXECUTE for PUBLIC)';
    assert not exists (select 1 from aclexplode(r.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'), r.sig || ': EXECUTE granted to PUBLIC';
    assert not has_function_privilege('anon', r.oid, 'execute'), r.sig || ': anon can execute';
    assert not has_function_privilege('authenticated', r.oid, 'execute'), r.sig || ': authenticated can execute';
    assert has_function_privilege('service_role', r.oid, 'execute'), r.sig || ': service_role cannot execute';
    assert not exists (select 1 from aclexplode(r.proacl) a
                        where a.privilege_type = 'EXECUTE' and a.grantee not in ((select proowner from pg_proc where oid = r.oid), (select oid from pg_roles where rolname = 'service_role'))),
           r.sig || ': unexpected grantee';
  end loop;
  assert n = 12, 'the catalog check saw every B10 function (' || n || ')';
  -- the three RPCs are SECURITY DEFINER with a pinned search_path
  assert (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
           where ns.nspname = 'public' and p.proname in ('set_competition_status', 'start_team_competition', 'get_team_state')
             and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) = 3;
  -- no SECURITY DEFINER function anywhere in public/app may be executable by PUBLIC, anon or authenticated
  assert not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                      where ns.nspname in ('public', 'app') and p.prosecdef
                        and (p.proacl is null
                             or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
                             or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
         'a SECURITY DEFINER function is executable by a browser-facing role';
end $$;

do $$
begin
  set local role anon;
  begin perform public.get_team_state(gen_random_uuid(), gen_random_uuid()); raise exception 'anon called get_team_state';
  exception when insufficient_privilege then null; end;
  begin perform public.start_team_competition(gen_random_uuid(), gen_random_uuid(), gen_random_uuid()); raise exception 'anon called start_team_competition';
  exception when insufficient_privilege then null; end;
  begin perform public.set_competition_status(gen_random_uuid(), 'open', gen_random_uuid()); raise exception 'anon called set_competition_status';
  exception when insufficient_privilege then null; end;
  begin perform app.lock_team(gen_random_uuid()); raise exception 'anon called app.lock_team';
  exception when insufficient_privilege then null; end;
  reset role;
  set local role authenticated;
  begin perform public.get_team_state(gen_random_uuid(), gen_random_uuid()); raise exception 'authenticated called get_team_state';
  exception when insufficient_privilege then null; end;
  begin perform public.set_competition_status('00000000-0000-0000-0000-0000000000a1', 'open', gen_random_uuid()); raise exception 'authenticated called set_competition_status';
  exception when insufficient_privilege then null; end;
  begin perform app.expire_team(gen_random_uuid(), 'x', now()); raise exception 'authenticated called app.expire_team';
  exception when insufficient_privilege then null; end;
  begin perform 1 from request_log; raise exception 'authenticated can read request_log';
  exception when insufficient_privilege then null; end;
  reset role;
end $$;

-- service_role can call them (SECURITY DEFINER passes forced RLS), and nothing else about its rights changed
do $$
declare j jsonb;
begin
  set local role service_role;
  j := public.get_team_state('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000c101');
  assert j->'team'->>'status' = 'NOT_STARTED';
  j := public.set_competition_status('00000000-0000-0000-0000-0000000000a1', 'open', gen_random_uuid());
  assert (j->>'changed')::boolean;
  reset role;
end $$;
-- request_log stays closed to the browser roles and keeps forced RLS
do $$ begin
  assert (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.request_log'::regclass);
  assert not has_table_privilege('anon', 'public.request_log', 'select') and not has_table_privilege('authenticated', 'public.request_log', 'select');
end $$;
rollback;

-- ===== the open guard: a competition with no team cannot open ======================================================
begin;
\ir include/helpers.sql
insert into staff_users (id, username, display_name, password_hash, role)
values ('00000000-0000-0000-0000-0000000000a1', 'test_super', 'Test Super', 'TEST-NOT-A-HASH', 'SUPER_ADMIN');
do $$
declare d jsonb;
begin
  begin
    perform public.set_competition_status('00000000-0000-0000-0000-0000000000a1', 'open', gen_random_uuid());
    raise exception 'open was allowed with no team';
  exception when others then
    if sqlerrm <> 'COMPETITION_NOT_READY' then raise; end if;
    get stacked diagnostics d = pg_exception_detail;
  end;
  assert (d->>'teams')::int = 0 and (d->>'themes')::int = 10 and (d->>'questions')::int = 50, 'the refusal says what is missing';
  assert (select status = 'SETUP' and state_version = 0 and opened_at is null from competition), 'still SETUP';
  assert not exists (select 1 from audit_events where event_type = 'COMPETITION_STATUS_CHANGED') and not exists (select 1 from request_log);
end $$;
rollback;

-- ===== the open guard proves 10 themes × 5 questions, not only the totals ==========================================
-- The questions table's own constraints already make an uneven 10-theme / 50-question split unrepresentable
-- (unique (theme_id, ordinal), ordinal 1..5, id = (theme_id - 1) * 5 + ordinal), so this test drops exactly those
-- constraints, inside this rolled-back transaction, to build the invalid shape the guard must still refuse
-- (defence in depth), then restores them and the valid content and proves OPEN works again.
begin;
\ir include/helpers.sql
insert into staff_users (id, username, display_name, password_hash, role)
values ('00000000-0000-0000-0000-0000000000a1', 'test_super', 'Test Super', 'TEST-NOT-A-HASH', 'SUPER_ADMIN');
insert into staff_users (id, username, display_name, password_hash, role, created_by)
values ('00000000-0000-0000-0000-0000000000a2', 'test_admin1', 'Test Admin 1', 'TEST-NOT-A-HASH', 'ADMIN', '00000000-0000-0000-0000-0000000000a1');
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
values ('00000000-0000-0000-0000-0000000000b1', 'T01', 'Test Team 1', 'test_team_01', 'TEST-NOT-A-HASH', '00000000-0000-0000-0000-0000000000a2', 500);

create function pg_temp.try_open(n int) returns jsonb language plpgsql as $$
declare d jsonb;
begin
  begin
    perform public.set_competition_status('00000000-0000-0000-0000-0000000000a1', 'open', ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid);
    return null;                                           -- it opened: the caller treats that as a failure
  exception when others then
    if sqlerrm <> 'COMPETITION_NOT_READY' then raise; end if;
    get stacked diagnostics d = pg_exception_detail;
    return d;
  end;
end $$;

-- baseline: the seeded content is a valid 10 × 5 and every theme has exactly five questions
do $$ begin
  assert (select count(*) from themes) = 10 and (select count(*) from questions) = 50;
  assert not exists (select 1 from themes t where (select count(*) from questions q where q.theme_id = t.id) <> 5), 'seed is 5 per theme';
end $$;

alter table questions drop constraint questions_id_matches_position;
alter table questions drop constraint questions_theme_id_ordinal_key;

-- (a) 4 + 6: question 5 moves from theme 1 to theme 2. Totals are still 10 themes and 50 questions.
update questions set theme_id = 2 where id = 5;
do $$
declare d jsonb;
begin
  assert (select count(*) from themes) = 10 and (select count(*) from questions) = 50, 'the totals alone look valid';
  d := pg_temp.try_open(1);
  assert d is not null, 'open was allowed with a 4 + 6 distribution';
  assert (d->>'themes')::int = 10 and (d->>'questions')::int = 50 and (d->>'teams')::int = 1, 'details keep the totals';
  assert (d->>'themes_not_five')::int = 2, 'two themes are not at five questions';
  assert (select status = 'SETUP' and state_version = 0 and opened_at is null from competition), 'still SETUP';
  assert not exists (select 1 from audit_events where event_type = 'COMPETITION_STATUS_CHANGED') and not exists (select 1 from request_log), 'a refusal writes nothing';
end $$;
update questions set theme_id = 1 where id = 5;           -- restore

-- (b) a theme with 0 questions: theme 10's five questions are spread over themes 1..5 (six each)
update questions set theme_id = ((id - 46) % 5) + 1 where theme_id = 10;
do $$
declare d jsonb;
begin
  assert (select count(*) from questions where theme_id = 10) = 0 and (select count(*) from questions) = 50;
  d := pg_temp.try_open(2);
  assert d is not null, 'open was allowed with an empty theme';
  assert (d->>'themes_not_five')::int = 6, 'five themes at six and one at zero';
  assert (select status from competition) = 'SETUP';
end $$;
update questions set theme_id = 10 where id between 46 and 50;     -- restore
update questions set theme_id = (id - 1) / 5 + 1;                   -- every question back at its original theme

-- the shape is valid again; re-adding the dropped constraints re-validates all 50 rows
alter table questions add constraint questions_id_matches_position check (id = (theme_id - 1) * 5 + ordinal);
alter table questions add constraint questions_theme_id_ordinal_key unique (theme_id, ordinal);

do $$
declare j jsonb;
begin
  assert not exists (select 1 from themes t where (select count(*) from questions q where q.theme_id = t.id) <> 5), 'restored: 5 per theme';
  j := public.set_competition_status('00000000-0000-0000-0000-0000000000a1', 'open', ('00000000-0000-4000-8000-' || lpad('3', 12, '0'))::uuid);
  assert (j->>'changed')::boolean and j->>'to' = 'RUNNING', 'OPEN succeeds on the valid fixture';
  assert (select status = 'RUNNING' and state_version = 1 from competition);
end $$;
rollback;

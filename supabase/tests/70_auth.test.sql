-- Authentication + sessions (migration 11): participant/staff login, generic failures, sessions, throttling, audit,
-- competition-status gate, privileges. Passwords below are throw-away test values, hashed by app.hash_password().
begin;
\ir include/helpers.sql
\ir include/fixture.sql

-- the controllable clock (docs/DATABASE_FOUNDATION.md): every function reads app.now()
set app.allow_test_clock = 'on';
set app.test_now = '2026-12-01 12:00:00+00';

create function pg_temp.at(ts text) returns void language plpgsql as $$
begin perform set_config('app.test_now', ts, false); end $$;
create function pg_temp.tok(n int) returns bytea language sql as $$ select sha256(convert_to('test-token-' || n, 'UTF8')) $$;
create function pg_temp.set_status(s text) returns void language sql as $$
  update competition set status = s::competition_status,
         paused_at = case when s = 'PAUSED' then now() end,
         ended_at  = case when s = 'ENDED' then now() end
   where id = 1 $$;
create function pg_temp.reset_throttle() returns void language sql as $$ delete from auth_throttle $$;
create function pg_temp.plogin(login text, pw text, adm text, n int) returns jsonb language sql as
  $$ select public.participant_login(login, pw, adm, pg_temp.tok(n), '203.0.113.7'::inet, 'test-agent') $$;
create function pg_temp.slogin(name text, pw text, n int) returns jsonb language sql as
  $$ select public.staff_login(name, pw, pg_temp.tok(n), '203.0.113.7'::inet, 'test-agent') $$;

update staff_users set password_hash = app.hash_password('super-pass-123') where username = 'test_super';
update staff_users set password_hash = app.hash_password('admin-pass-123') where username = 'test_admin1';
update staff_users set password_hash = app.hash_password('inactive-pass-1'), is_active = false where username = 'test_admin2';
update teams set password_hash = app.hash_password('team-pass-01') where login_id = 'test_team_01';
update teams set password_hash = app.hash_password('team-pass-02') where login_id = 'test_team_02';

select pg_temp.set_status('RUNNING');

-- ===== password helpers ===========================================================================================
do $$ begin
  assert app.hash_password('abc-def-ghi') like '$2a$12$%', 'bcrypt, cost 12';
  assert app.hash_password('abc-def-ghi') <> app.hash_password('abc-def-ghi'), 'salted';
  assert app.verify_password('abc-def-ghi', app.hash_password('abc-def-ghi')), 'verifies';
  assert not app.verify_password('abc-def-ghj', app.hash_password('abc-def-ghi')), 'rejects a wrong password';
  assert not app.verify_password('x', 'TEST-NOT-A-HASH'), 'a malformed stored hash never matches (and does not raise)';
  assert not app.verify_password('x', null), 'no stored hash never matches';
  assert not app.verify_password(repeat('a', 73), app.hash_password(repeat('a', 72))), 'over-72-byte input never matches (no silent truncation)';
end $$;
select pg_temp.rejects($s$select app.hash_password(repeat('a', 73))$s$, '72 bytes');
select pg_temp.rejects($s$select app.hash_password('')$s$, 'must not be empty');

-- ===== 1. participant login success; 21. never starts the timer ===================================================
create temp table before_state as
  select t.status, t.started_at, t.ends_at, t.state_version, t.coins,
         (select state_version from competition where id = 1) as comp_version,
         (select count(*) from coin_transactions where team_id = t.id) as ledger_rows
    from teams t where t.id = '00000000-0000-0000-0000-0000000000b1';
create temp table r1 as select pg_temp.plogin('test_team_01', 'team-pass-01', 'TEST11', 1) as j;
do $$
declare j jsonb := (select j from r1);
begin
  assert (j->>'ok')::boolean, 'participant login succeeds';
  assert j->>'role' = 'PARTICIPANT';
  assert (j->'member'->>'slot')::int = 1 and j->'team'->>'code' = 'T01' and j->'team'->>'name' = 'Test Team 1';
  assert j->'team'->>'status' = 'NOT_STARTED', 'login leaves the team NOT_STARTED';
  assert (j->'session'->>'expires_at')::timestamptz = timestamptz '2026-12-02 00:00:00+00', 'session lasts 12 h (SEC-05)';
  assert (select count(*) from sessions where kind = 'MEMBER' and member_id = '00000000-0000-0000-0000-00000000c101' and revoked_at is null) = 1;
  assert (select token_hash from sessions where id = (j->'session'->>'id')::uuid) = pg_temp.tok(1), 'only the hash is stored';
  -- 21. login never starts the team timer, touches coins or bumps versions
  assert (select (t.status, t.started_at, t.ends_at, t.state_version, t.coins) is not distinct from (b.status, b.started_at, b.ends_at, b.state_version, b.coins)
            from teams t, before_state b where t.id = '00000000-0000-0000-0000-0000000000b1'), 'team row untouched by login';
  assert (select started_at is null and ends_at is null from teams where id = '00000000-0000-0000-0000-0000000000b1'), 'no timer';
  assert (select state_version from competition where id = 1) = (select comp_version from before_state);
  assert (select count(*) from coin_transactions where team_id = '00000000-0000-0000-0000-0000000000b1') = (select ledger_rows from before_state);
end $$;
-- login id is case-insensitive, admission number is normalised (trim + upper-case)
do $$ begin
  assert (pg_temp.plogin('TEST_Team_01 ', 'team-pass-01', ' test12 ', 2)->>'ok')::boolean, 'normalised input';
end $$;

-- ===== 2-6. generic failures ======================================================================================
select pg_temp.reset_throttle();
create temp table fails as
  select 'wrong password' as what, pg_temp.plogin('test_team_01', 'nope-nope-nope', 'TEST11', 3) as j
  union all select 'wrong admission', pg_temp.plogin('test_team_01', 'team-pass-01', 'TEST19', 3)
  union all select 'admission of another team', pg_temp.plogin('test_team_01', 'team-pass-01', 'TEST21', 3)
  union all select 'unknown team', pg_temp.plogin('no_such_team', 'team-pass-01', 'TEST11', 3)
  union all select 'empty input', pg_temp.plogin('', '', '', 3)
  union all select 'staff wrong password', pg_temp.slogin('test_admin1', 'nope-nope-nope', 3)
  union all select 'staff unknown', pg_temp.slogin('no_such_staff', 'admin-pass-123', 3)
  union all select 'staff inactive', pg_temp.slogin('test_admin2', 'inactive-pass-1', 3);
do $$ begin
  assert (select count(*) from fails) = 8;
  assert (select count(distinct j) from fails) = 1, 'every failure returns the same body';
  assert (select j from fails limit 1) = '{"ok": false, "code": "INVALID_CREDENTIALS"}'::jsonb, 'generic failure contract';
  assert not exists (select 1 from sessions where token_hash = pg_temp.tok(3)), 'a failed login creates no session';
end $$;
-- a token hash that is not 32 bytes is a programming error, not a login outcome
select pg_temp.rejects($s$select public.participant_login('test_team_01', 'x', 'TEST11', '\x00'::bytea)$s$, '32 bytes');
select pg_temp.rejects($s$select public.staff_login('test_admin1', 'x', null)$s$, '32 bytes');

-- ===== 23. audit rows for failed logins (reason kept internally, never returned) ==================================
do $$ begin
  assert (select count(*) from audit_events where event_type = 'LOGIN_FAILED' and payload->>'subject' = 'MEMBER') = 5;
  assert (select count(*) from audit_events where event_type = 'LOGIN_FAILED' and payload->>'subject' = 'STAFF') = 3;
  assert (select string_agg(payload->>'reason', ',' order by id) from audit_events where event_type = 'LOGIN_FAILED')
         = 'BAD_PASSWORD,BAD_ADMISSION_NO,BAD_ADMISSION_NO,UNKNOWN_TEAM,UNKNOWN_TEAM,BAD_PASSWORD,UNKNOWN_ACCOUNT,ACCOUNT_INACTIVE';
  assert (select payload->>'account_key' from audit_events where event_type = 'LOGIN_FAILED' order by id limit 1) = 'team:test_team_01';
  assert (select ip from audit_events where event_type = 'LOGIN_FAILED' order by id limit 1) = '203.0.113.7'::inet;
  assert not exists (select 1 from audit_events where event_type = 'LOGIN_FAILED' and payload::text ~ '(\$2[abxy]\$|team-pass|super-pass|admin-pass|nope-nope|wrong-wrong|TEST[0-9]{2})'),
         'no password or hash in the audit payload';
end $$;

-- ===== 7. staff login; 13. principals; 14. last_seen_at; 22. audit for success ==================================
select pg_temp.reset_throttle();
create temp table rs as
  select pg_temp.slogin('test_super', 'super-pass-123', 10) as su, pg_temp.slogin('TEST_ADMIN1', 'admin-pass-123', 11) as ad;
do $$
declare su jsonb := (select su from rs); ad jsonb := (select ad from rs);
begin
  assert (su->>'ok')::boolean and (ad->>'ok')::boolean, 'staff login succeeds';
  assert su->>'role' = 'SUPER_ADMIN' and ad->>'role' = 'ADMIN', 'staff roles';
  assert su->'staff'->>'username' = 'test_super' and ad->'staff'->>'display_name' = 'Test Admin 1';
  assert (select last_login_at from staff_users where username = 'test_admin1') = timestamptz '2026-12-01 12:00:00+00';
  assert (select count(*) from sessions where kind = 'STAFF' and revoked_at is null) = 2;
  -- staff sessions are not unique per account: a second login does not revoke the first
  assert (pg_temp.slogin('test_admin1', 'admin-pass-123', 12)->>'ok')::boolean;
  assert (select count(*) from sessions where kind = 'STAFF' and staff_id = '00000000-0000-0000-0000-0000000000a2' and revoked_at is null) = 2;
end $$;

do $$
declare p jsonb;
begin
  -- 13. session resolution: PARTICIPANT / ADMIN / SUPER_ADMIN
  p := public.resolve_session(pg_temp.tok(1));
  assert (p->>'ok')::boolean and p->>'role' = 'PARTICIPANT' and p->'team'->>'code' = 'T01' and (p->'member'->>'slot')::int = 1;
  assert p->'session'->>'id' is not null and p->'session'->>'expires_at' is not null;
  p := public.resolve_session(pg_temp.tok(11));
  assert (p->>'ok')::boolean and p->>'role' = 'ADMIN' and p->'staff'->>'username' = 'test_admin1';
  p := public.resolve_session(pg_temp.tok(10));
  assert (p->>'ok')::boolean and p->>'role' = 'SUPER_ADMIN';
  -- unknown token / malformed hash
  assert public.resolve_session(pg_temp.tok(999)) = '{"ok": false, "code": "UNAUTHENTICATED"}'::jsonb;
  assert public.resolve_session('\x00'::bytea) = '{"ok": false, "code": "UNAUTHENTICATED"}'::jsonb;
  assert public.resolve_session(null) = '{"ok": false, "code": "UNAUTHENTICATED"}'::jsonb;

  -- 14. resolve_session updates last_seen_at
  perform pg_temp.at('2026-12-01 12:00:30+00');
  perform public.resolve_session(pg_temp.tok(1));
  assert (select last_seen_at from sessions where token_hash = pg_temp.tok(1)) = timestamptz '2026-12-01 12:00:30+00', 'last_seen_at updated';
  assert (select presence from member_presence where member_id = '00000000-0000-0000-0000-00000000c101') = 'ONLINE', 'feeds member_presence';
  perform pg_temp.at('2026-12-01 12:00:00+00');
end $$;

-- ===== 22. audit rows for successful logins ==========================================================================
do $$ begin
  assert (select count(*) from audit_events where event_type = 'MEMBER_LOGIN') = 2;
  assert exists (select 1 from audit_events where event_type = 'MEMBER_LOGIN' and actor_kind = 'MEMBER'
                  and member_id = '00000000-0000-0000-0000-00000000c101' and team_id = '00000000-0000-0000-0000-0000000000b1'
                  and ip = '203.0.113.7'::inet and entity_type = 'SESSION');
  assert (select count(*) from audit_events where event_type = 'STAFF_LOGIN' and actor_kind = 'STAFF') = 3;
  assert (select payload->>'role' from audit_events where event_type = 'STAFF_LOGIN' order by id limit 1) = 'SUPER_ADMIN';
end $$;

-- ===== 9. a second login supersedes the first (per member) =============================================================
do $$
declare j jsonb;
begin
  j := pg_temp.plogin('test_team_01', 'team-pass-01', 'TEST11', 20);
  assert (j->>'ok')::boolean;
  assert not (public.resolve_session(pg_temp.tok(1))->>'ok')::boolean, 'the previous session of that member is dead';
  assert (select revoke_reason from sessions where token_hash = pg_temp.tok(1)) = 'SUPERSEDED';
  assert (public.resolve_session(pg_temp.tok(20))->>'ok')::boolean, 'the new session works';
  assert (select count(*) from sessions where member_id = '00000000-0000-0000-0000-00000000c101' and revoked_at is null) = 1, 'one live session per member';
  assert (select (payload->>'superseded_sessions')::int from audit_events where event_type = 'MEMBER_LOGIN' order by id desc limit 1) = 1;
  -- a different member of the same team keeps theirs
  assert (public.resolve_session(pg_temp.tok(2))->>'ok')::boolean, 'M2 is unaffected by M1 logging in again';
end $$;

-- ===== 10 + 12. logout and revoked sessions ============================================================================
do $$
declare j jsonb;
begin
  j := public.revoke_session(pg_temp.tok(20));
  assert j = '{"ok": true, "revoked": true}'::jsonb, 'logout revokes';
  assert (select revoke_reason from sessions where token_hash = pg_temp.tok(20)) = 'LOGOUT';
  assert not (public.resolve_session(pg_temp.tok(20))->>'ok')::boolean, 'revoked sessions are rejected';
  assert exists (select 1 from audit_events where event_type = 'MEMBER_LOGOUT' and member_id = '00000000-0000-0000-0000-00000000c101');
  -- idempotent, and silent about unknown tokens
  assert public.revoke_session(pg_temp.tok(20)) = '{"ok": true, "revoked": false}'::jsonb, 'second logout is a no-op';
  assert public.revoke_session(pg_temp.tok(999)) = '{"ok": true, "revoked": false}'::jsonb, 'unknown token reveals nothing';
  assert public.revoke_session(null) = '{"ok": true, "revoked": false}'::jsonb;
  assert (select count(*) from audit_events where event_type = 'MEMBER_LOGOUT') = 1, 'only a real logout is audited';
  j := public.revoke_session(pg_temp.tok(11));
  assert (j->>'revoked')::boolean;
  assert exists (select 1 from audit_events where event_type = 'STAFF_LOGOUT' and staff_id = '00000000-0000-0000-0000-0000000000a2');
  assert not (public.resolve_session(pg_temp.tok(11))->>'ok')::boolean;
end $$;

-- a disabled staff account loses its live sessions on the next resolve
do $$ begin
  assert (public.resolve_session(pg_temp.tok(12))->>'ok')::boolean, 'tok 12 is a live ADMIN session';
  update staff_users set is_active = false where username = 'test_admin1';
  assert not (public.resolve_session(pg_temp.tok(12))->>'ok')::boolean, 'disabled staff are rejected';
  assert (select revoke_reason from sessions where token_hash = pg_temp.tok(12)) = 'ADMIN_DISABLED';
  update staff_users set is_active = true where username = 'test_admin1';
end $$;

-- ===== 11. expired sessions =============================================================================================
do $$
declare j jsonb;
begin
  j := pg_temp.plogin('test_team_01', 'team-pass-01', 'TEST13', 30);
  assert (j->>'ok')::boolean;
  perform pg_temp.at('2026-12-01 23:59:59+00');
  assert (public.resolve_session(pg_temp.tok(30))->>'ok')::boolean, 'still valid one second before expiry';
  perform pg_temp.at('2026-12-02 00:00:00+00');   -- exactly 12 h after the login at 12:00
  assert not (public.resolve_session(pg_temp.tok(30))->>'ok')::boolean, 'expired sessions are rejected';
  assert (select revoke_reason from sessions where token_hash = pg_temp.tok(30)) = 'EXPIRED', 'and revoked as EXPIRED';
  -- an expired, never-revoked session does not block the next login of that member
  perform pg_temp.at('2026-12-01 12:00:00+00');
  j := pg_temp.plogin('test_team_01', 'team-pass-01', 'TEST14', 31);
  perform pg_temp.at('2026-12-02 13:00:00+00');
  j := pg_temp.plogin('test_team_01', 'team-pass-01', 'TEST14', 32);
  assert (j->>'ok')::boolean, 'login after an expired session';
  assert (select revoke_reason from sessions where token_hash = pg_temp.tok(31)) = 'EXPIRED', 'the stale row is closed as EXPIRED, not SUPERSEDED';
  perform pg_temp.at('2026-12-01 12:00:00+00');
end $$;

-- ===== 15 + 16. throttling: per account, escalating, cleared by a success ==============================================
select pg_temp.reset_throttle();
do $$
declare j jsonb; i int;
begin
  for i in 1..7 loop
    j := pg_temp.plogin('test_team_01', 'wrong-wrong-1', 'TEST11', 40);
    assert j->>'code' = 'INVALID_CREDENTIALS', 'failures 1..7 are plain failures';
  end loop;
  assert (select attempts from auth_throttle where key = 'team:test_team_01') = 7 and (select locked_until from auth_throttle where key = 'team:test_team_01') is null;
  j := pg_temp.plogin('test_team_01', 'wrong-wrong-1', 'TEST11', 40);
  assert j->>'code' = 'INVALID_CREDENTIALS', 'the 8th failure is still a plain failure, but it locks the account';
  assert (select locked_until from auth_throttle where key = 'team:test_team_01') = timestamptz '2026-12-01 12:00:30+00', '30 s first lock';

  -- locked: even the correct credentials are refused, with the wait
  j := pg_temp.plogin('test_team_01', 'team-pass-01', 'TEST11', 41);
  assert j = '{"ok": false, "code": "RATE_LIMITED", "retry_after_seconds": 30}'::jsonb, 'locked account: RATE_LIMITED';
  assert not exists (select 1 from sessions where token_hash = pg_temp.tok(41)), 'no session while locked';
  assert (select attempts from auth_throttle where key = 'team:test_team_01') = 8, 'refused attempts do not extend the lock';
  assert (select count(*) from audit_events where event_type = 'LOGIN_FAILED' and payload->>'account_key' = 'team:test_team_01'
            and payload->>'reason' = 'BAD_PASSWORD') >= 8;

  -- per account, not per IP/global: another team, staff and an unrelated unknown name are unaffected
  assert (pg_temp.plogin('test_team_02', 'team-pass-02', 'TEST21', 42)->>'ok')::boolean, 'team 02 can log in';
  assert (pg_temp.slogin('test_super', 'super-pass-123', 43)->>'ok')::boolean, 'staff are unaffected';
  assert pg_temp.plogin('another_ghost', 'x', 'x', 44)->>'code' = 'INVALID_CREDENTIALS';

  -- the delay escalates: 30 s, then 60 s
  perform pg_temp.at('2026-12-01 12:00:31+00');
  j := pg_temp.plogin('test_team_01', 'wrong-wrong-1', 'TEST11', 40);
  assert j->>'code' = 'INVALID_CREDENTIALS';
  j := pg_temp.plogin('test_team_01', 'team-pass-01', 'TEST11', 41);
  assert j->>'code' = 'RATE_LIMITED' and (j->>'retry_after_seconds')::int = 60, '9th failure locks for 60 s';

  -- 16. after the wait, a success clears the counter and the lock
  perform pg_temp.at('2026-12-01 12:01:32+00');
  j := pg_temp.plogin('test_team_01', 'team-pass-01', 'TEST11', 45);
  assert (j->>'ok')::boolean, 'login works once the lock has passed';
  assert not exists (select 1 from auth_throttle where key = 'team:test_team_01'), 'success clears the throttle row';
  perform pg_temp.at('2026-12-01 12:00:00+00');
end $$;

-- unknown accounts are throttled exactly like real ones (no enumeration through the lock)
select pg_temp.reset_throttle();
do $$
declare j jsonb; i int;
begin
  for i in 1..8 loop j := pg_temp.plogin('ghost_team', 'x', 'x', 50); end loop;
  assert pg_temp.plogin('ghost_team', 'x', 'x', 50) = '{"ok": false, "code": "RATE_LIMITED", "retry_after_seconds": 30}'::jsonb;
  for i in 1..8 loop j := pg_temp.slogin('ghost_staff', 'x', 51); end loop;
  assert pg_temp.slogin('ghost_staff', 'x', 51)->>'code' = 'RATE_LIMITED';
  -- the counter window is 10 minutes
  perform pg_temp.reset_throttle();
  for i in 1..3 loop j := pg_temp.plogin('test_team_01', 'wrong-wrong-1', 'TEST11', 52); end loop;
  assert (select attempts from auth_throttle where key = 'team:test_team_01') = 3;
  perform pg_temp.at('2026-12-01 12:10:01+00');
  j := pg_temp.plogin('test_team_01', 'wrong-wrong-1', 'TEST11', 52);
  assert (select attempts from auth_throttle where key = 'team:test_team_01') = 1, 'a new 10-minute window starts the count again';
  -- the delay is capped at 300 s
  perform pg_temp.reset_throttle();
  insert into auth_throttle (key, window_start, attempts) values ('team:cap_test', app.now(), 40);
  assert app.auth_throttle_fail('team:cap_test') = 300, 'delay capped at 300 s';
  perform pg_temp.at('2026-12-01 12:00:00+00');
end $$;

-- ===== 17-20. participant login follows the competition status ==========================================================
select pg_temp.reset_throttle();
do $$
declare j jsonb; n_before int;
begin
  perform pg_temp.set_status('SETUP');
  j := pg_temp.plogin('test_team_01', 'team-pass-01', 'TEST11', 60);
  assert j->>'code' = 'COMPETITION_NOT_RUNNING' and j->>'competition_status' = 'SETUP', '17. blocked in SETUP';
  assert not exists (select 1 from sessions where token_hash = pg_temp.tok(60)), 'no session in SETUP';
  assert pg_temp.plogin('test_team_01', 'wrong-wrong-1', 'TEST11', 60) = '{"ok": false, "code": "INVALID_CREDENTIALS"}'::jsonb,
         'wrong credentials stay generic: the competition status is not revealed to someone without valid credentials';
  assert exists (select 1 from audit_events where event_type = 'LOGIN_FAILED' and payload->>'reason' = 'COMPETITION_NOT_OPEN' and actor_kind = 'MEMBER');
  assert (pg_temp.slogin('test_super', 'super-pass-123', 61)->>'ok')::boolean, 'staff may log in before the competition opens';

  perform pg_temp.set_status('ENDED');
  j := pg_temp.plogin('test_team_01', 'team-pass-01', 'TEST11', 62);
  assert j->>'code' = 'COMPETITION_NOT_RUNNING' and j->>'competition_status' = 'ENDED', '18. blocked in ENDED';

  perform pg_temp.set_status('RUNNING');
  assert (pg_temp.plogin('test_team_01', 'team-pass-01', 'TEST11', 63)->>'ok')::boolean, '19. allowed in RUNNING';

  perform pg_temp.set_status('PAUSED');
  assert (pg_temp.plogin('test_team_01', 'team-pass-01', 'TEST12', 64)->>'ok')::boolean, '20. allowed in PAUSED';
  assert (select started_at is null from teams where team_code = 'T01'), 'still no timer after logins in any status';
  perform pg_temp.set_status('RUNNING');
end $$;

-- ===== 24. no password, hash or token ever comes back ===================================================================
do $$
declare r record; bad int := 0;
begin
  for r in
    select pg_temp.plogin('test_team_01', 'team-pass-01', 'TEST11', 70)::text as t
    union all select pg_temp.slogin('test_super', 'super-pass-123', 71)::text
    union all select public.resolve_session(pg_temp.tok(70))::text
    union all select public.resolve_session(pg_temp.tok(71))::text
    union all select public.revoke_session(pg_temp.tok(70))::text
    union all select pg_temp.plogin('test_team_01', 'wrong-wrong-1', 'TEST11', 72)::text
  loop
    if r.t ~* '(\$2[abxy]\$|password|token_hash|hash|admission|team-pass|super-pass|wrong-wrong)' then bad := bad + 1; raise warning 'leak in %', r.t; end if;
  end loop;
  assert bad = 0, 'no secret material in any result';
  assert not exists (select 1 from audit_events where payload::text ~ '(\$2[abxy]\$|team-pass|super-pass|admin-pass|nope-nope|wrong-wrong|TEST[0-9]{2})'), 'nor in the audit trail';
end $$;

-- ===== 25 + 26. privileges: service_role only, never PUBLIC =============================================================
do $$
declare r record; n int := 0;
begin
  for r in select p.oid, p.oid::regprocedure::text as sig, p.proacl
             from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname in ('public', 'app')
              and (p.prosecdef or p.proname in ('hash_password', 'verify_password', 'auth_dummy_hash',
                                                'auth_throttle_retry_after', 'auth_throttle_fail', 'auth_throttle_clear'))
              and p.prokind = 'f'
  loop
    n := n + 1;
    assert r.proacl is not null, r.sig || ': ACL must be explicit (a NULL ACL means EXECUTE for PUBLIC)';
    assert not exists (select 1 from aclexplode(r.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'), r.sig || ': EXECUTE granted to PUBLIC';
    assert not has_function_privilege('anon', r.oid, 'execute'), r.sig || ': anon can execute';
    assert not has_function_privilege('authenticated', r.oid, 'execute'), r.sig || ': authenticated can execute';
    assert has_function_privilege('service_role', r.oid, 'execute'), r.sig || ': service_role cannot execute';
    -- the only grantees are the owner and service_role
    assert not exists (select 1 from aclexplode(r.proacl) a
                        where a.privilege_type = 'EXECUTE' and a.grantee not in ((select proowner from pg_proc where oid = r.oid), (select oid from pg_roles where rolname = 'service_role'))),
           r.sig || ': unexpected grantee';
  end loop;
  assert n >= 11, 'the catalog check saw every auth function (' || n || ')';
  -- the four callable RPCs are SECURITY DEFINER with a pinned search_path
  assert (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
           where ns.nspname = 'public' and p.proname in ('participant_login', 'staff_login', 'resolve_session', 'revoke_session')
             and p.prosecdef and p.proconfig is not null and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) = 4;
end $$;

-- behaviour, not just catalog: browser-facing roles cannot call them; service_role can
do $$
begin
  set local role anon;
  begin perform public.staff_login('test_super', 'x', pg_temp.tok(1)); raise exception 'anon was allowed to call staff_login';
  exception when insufficient_privilege then null; end;
  begin perform public.resolve_session(pg_temp.tok(1)); raise exception 'anon was allowed to call resolve_session';
  exception when insufficient_privilege then null; end;
  begin perform app.hash_password('abc-def-ghi'); raise exception 'anon was allowed to call app.hash_password';
  exception when insufficient_privilege then null; end;
  reset role;
  set local role authenticated;
  begin perform public.participant_login('a', 'b', 'c', pg_temp.tok(1)); raise exception 'authenticated was allowed to call participant_login';
  exception when insufficient_privilege then null; end;
  begin perform public.revoke_session(pg_temp.tok(1)); raise exception 'authenticated was allowed to call revoke_session';
  exception when insufficient_privilege then null; end;
  reset role;
end $$;
do $$
declare j jsonb;
begin
  set local role service_role;
  j := public.resolve_session(pg_temp.tok(71));
  assert (j->>'ok')::boolean and j->>'role' = 'SUPER_ADMIN', 'service_role can call the RPCs (SECURITY DEFINER passes forced RLS)';
  j := public.staff_login('test_super', 'super-pass-123', pg_temp.tok(73));
  assert (j->>'ok')::boolean;
  reset role;
end $$;
-- the tables stay closed to the browser roles
do $$ begin
  set local role anon;
  begin perform 1 from sessions; raise exception 'anon can read sessions'; exception when insufficient_privilege then null; end;
  reset role;
end $$;
rollback;

-- ===== provisioning: exactly one Super Admin, hashed in the database ===================================================
begin;
\ir include/helpers.sql
do $$
declare v_id uuid;
begin
  assert not exists (select 1 from staff_users), 'clean database: no staff yet';
  v_id := app.provision_superadmin('root_user', 'Root User', 'correct-horse-9');
  assert (select count(*) from staff_users where role = 'SUPER_ADMIN') = 1;
  assert (select password_hash like '$2a$12$%' and password_hash <> 'correct-horse-9' and created_by is null and is_active from staff_users where id = v_id);
  assert (public.staff_login('root_user', 'correct-horse-9', sha256('prov-token'::bytea))->>'role') = 'SUPER_ADMIN', 'the provisioned account can log in';
  assert exists (select 1 from audit_events where event_type = 'SUPER_ADMIN_PROVISIONED' and entity_id = v_id::text);
  assert not exists (select 1 from audit_events where payload::text ~* '(correct-horse|\$2a\$)'), 'the audit trail holds no credential';
end $$;
select pg_temp.rejects($s$select app.provision_superadmin('second_root', 'Second', 'another-pass-99')$s$, 'SUPER_ADMIN_EXISTS');
select pg_temp.rejects($s$select app.provision_superadmin('x', 'Bad name', 'another-pass-99')$s$, 'INVALID_USERNAME');
select pg_temp.rejects($s$select app.provision_superadmin('valid_name', 'Bad pw', 'short')$s$, 'INVALID_PASSWORD');
select pg_temp.rejects($s$select app.provision_superadmin('valid_name', 'Bad pw', repeat('a', 73))$s$, 'INVALID_PASSWORD');
select pg_temp.rejects($s$select app.provision_superadmin('valid_name', '  ', 'another-pass-99')$s$, 'INVALID_DISPLAY_NAME');
do $$ begin
  assert (select count(*) from staff_users where role = 'SUPER_ADMIN') = 1, 'still exactly one';
end $$;
rollback;

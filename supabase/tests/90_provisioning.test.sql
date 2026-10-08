-- Provisioning (migration 13): create_admin, create_team, list_admin_teams, get_leaderboard — validation, hashing,
-- atomicity, idempotency, audit, ownership isolation, login of the created identities, privileges.
-- Passwords below are throw-away test values. The fixture's staff a1 = SUPER_ADMIN, a2/a3 = ADMIN.
begin;
\ir include/helpers.sql
\ir include/fixture.sql

set app.allow_test_clock = 'on';
set app.test_now = '2026-12-01 12:00:00+00';

create function pg_temp.key(n int) returns uuid language sql as
  $$ select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.tok(n int) returns bytea language sql as $$ select sha256(convert_to('prov-token-' || n, 'UTF8')) $$;
create function pg_temp.admin(u text, pw text, n int) returns jsonb language sql as
  $$ select public.create_admin('00000000-0000-0000-0000-0000000000a1', u, pw, pg_temp.key(n)) $$;
-- create_team as staff `who` with the four admission numbers a, b, c, d
create function pg_temp.team(who uuid, code text, nm text, login text, pw text, a text, b text, c text, d text, n int)
returns jsonb language sql as
  $$ select public.create_team(who, code, nm, login, pw, array[a, b, c, d], pg_temp.key(n)) $$;
create function pg_temp.a2() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000a2'::uuid $$;
create function pg_temp.a3() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000a3'::uuid $$;
create function pg_temp.keys_of(j jsonb) returns text[] language sql as $$
  select coalesce(array(select distinct k from jsonb_array_elements_text(jsonb_path_query_array(j, '$.** ? (@.type() == "object").keyvalue().key')) k order by k), '{}') $$;

-- ===== 1. create_admin: the happy path ===============================================================================
create temp table r1 as select pg_temp.admin('Alice.Admin', 'a-long-password-1', 1) as j;
do $$
declare j jsonb := (select j from r1); h text; s staff_users%rowtype;
begin
  assert (j->>'replayed')::boolean = false;
  assert j->'admin'->>'username' = 'Alice.Admin' and j->'admin'->>'role' = 'ADMIN' and (j->'admin'->>'is_active')::boolean;
  select * into s from staff_users where id = (j->'admin'->>'id')::uuid;
  assert s.role = 'ADMIN' and s.is_active and s.display_name = 'Alice.Admin', 'ADMIN, active, display name = username';
  assert s.created_by = '00000000-0000-0000-0000-0000000000a1', 'created_by is the caller';
  assert s.password_hash like '$2a$12$%' and s.password_hash <> 'a-long-password-1', 'stored as a bcrypt hash';
  assert position('a-long-password-1' in (select string_agg(t::text, ' ') from staff_users t)) = 0, 'no plaintext password in staff_users';
  assert (select count(*) from staff_users where role = 'SUPER_ADMIN') = 1, 'still exactly one Super Admin';
  assert not (pg_temp.keys_of(j) && array['password', 'password_hash', 'hash', 'token']), 'the response carries no secret: ' || pg_temp.keys_of(j)::text;
  -- audit: who, what, and nothing secret
  assert (select count(*) from audit_events where event_type = 'ADMIN_CREATED' and entity_id = s.id::text) = 1;
  assert (select staff_id from audit_events where event_type = 'ADMIN_CREATED') = '00000000-0000-0000-0000-0000000000a1';
  assert (select request_id from audit_events where event_type = 'ADMIN_CREATED') = pg_temp.key(1);
  assert position('a-long-password' in (select string_agg(payload::text, ' ') from audit_events)) = 0, 'audit has no password';
  -- the idempotency record holds the response and a fingerprint without the password
  assert position('a-long-password' in (select string_agg(request_fingerprint || response::text, ' ') from request_log)) = 0;
end $$;

-- the created admin can log in immediately through the existing staff login (case-insensitive username)
do $$
declare l jsonb := public.staff_login('alice.admin', 'a-long-password-1', pg_temp.tok(1), '203.0.113.7'::inet, 'test-agent');
begin
  assert (l->>'ok')::boolean and l->>'role' = 'ADMIN', 'new admin logs in: ' || l::text;
  assert l->'staff'->>'username' = 'Alice.Admin';
  assert not (public.staff_login('Alice.Admin', 'wrong-password-1', pg_temp.tok(2))->>'ok')::boolean, 'wrong password rejected';
end $$;

-- ===== 2. create_admin: validation, duplicates, authorisation ========================================================
select pg_temp.rejects($s$select pg_temp.admin('alice.admin', 'another-long-pass-1', 2)$s$, 'USERNAME_TAKEN');       -- citext: case-insensitive
select pg_temp.rejects($s$select pg_temp.admin('test_super', 'another-long-pass-1', 3)$s$, 'USERNAME_TAKEN');       -- the Super Admin's name
select pg_temp.rejects($s$select pg_temp.admin('ab', 'another-long-pass-1', 4)$s$, 'VALIDATION_FAILED');            -- too short
select pg_temp.rejects($s$select pg_temp.admin('has space', 'another-long-pass-1', 4)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select pg_temp.admin('bob', 'short', 4)$s$, 'VALIDATION_FAILED');                         -- < 10 characters
select pg_temp.rejects($s$select pg_temp.admin('bob', repeat('x', 73), 4)$s$, 'VALIDATION_FAILED');                 -- > 72 bytes (bcrypt)
select pg_temp.rejects($s$select pg_temp.admin('bob', null, 4)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select pg_temp.admin(null, 'another-long-pass-1', 4)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.create_admin('00000000-0000-0000-0000-0000000000a1', 'bob', 'another-long-pass-1', null)$s$, 'VALIDATION_FAILED');   -- no key
-- only an active SUPER_ADMIN may create an admin
select pg_temp.rejects($s$select public.create_admin(pg_temp.a2(), 'bob', 'another-long-pass-1', pg_temp.key(5))$s$, 'FORBIDDEN');                       -- an ADMIN
select pg_temp.rejects($s$select public.create_admin(gen_random_uuid(), 'bob', 'another-long-pass-1', pg_temp.key(5))$s$, 'FORBIDDEN');                 -- unknown
select pg_temp.rejects($s$select public.create_admin(null, 'bob', 'another-long-pass-1', pg_temp.key(5))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.create_admin('00000000-0000-0000-0000-00000000c101', 'bob', 'another-long-pass-1', pg_temp.key(5))$s$, 'FORBIDDEN'); -- a member id
do $$ begin
  assert (select count(*) from staff_users) = 4, 'a rejected request created nothing (3 fixture + 1)';
  assert (select count(*) from audit_events where event_type = 'ADMIN_CREATED') = 1;
  assert (select count(*) from request_log) = 1, 'only the success is stored';
end $$;

-- ===== 3. create_admin: idempotency ==================================================================================
do $$
declare j jsonb := (select j from r1); again jsonb;
begin
  again := pg_temp.admin('Alice.Admin', 'a-long-password-1', 1);                    -- retry / double click, same key
  assert (again->>'replayed')::boolean and again->'admin' = j->'admin', 'the same key returns the stored response';
  again := pg_temp.admin('Alice.Admin', 'a-long-password-1', 1);
  assert (select count(*) from staff_users where username = 'Alice.Admin') = 1, 'no duplicate admin';
  assert (select count(*) from audit_events where event_type = 'ADMIN_CREATED') = 1, 'no duplicate audit';
end $$;
select pg_temp.rejects($s$select pg_temp.admin('someone.else', 'a-long-password-1', 1)$s$, 'IDEMPOTENCY_KEY_REUSED');   -- key reused for another request
-- a second key for the same username is a duplicate request, not a second admin
select pg_temp.rejects($s$select pg_temp.admin('Alice.Admin', 'a-long-password-1', 6)$s$, 'USERNAME_TAKEN');
-- a disabled Super Admin loses the authority at once
update staff_users set is_active = false where id = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.rejects($s$select pg_temp.admin('bob', 'another-long-pass-1', 7)$s$, 'FORBIDDEN');
update staff_users set is_active = true where id = '00000000-0000-0000-0000-0000000000a1';

-- ===== 4. create_team: the happy path (everything in one transaction) ================================================
create temp table t1 as select pg_temp.team(pg_temp.a2(), ' t10 ', '  The Euclids  ', 'Euclid_Team', 'team-password-1', ' 23je0001 ', '23JE0002', '23je0003', '23JE0004', 10) as j;
do $$
declare j jsonb := (select j from t1); tid uuid := (j->'team'->>'id')::uuid; t teams%rowtype;
begin
  select * into t from teams where id = tid;
  assert (j->>'replayed')::boolean = false;
  assert t.team_code = 'T10' and t.name = 'The Euclids' and t.login_id = 'Euclid_Team', 'normalised: trimmed, code upper-cased';
  assert t.admin_id = pg_temp.a2() and t.created_by = pg_temp.a2(), 'the owner is the caller';
  assert t.status = 'NOT_STARTED' and t.started_at is null and t.state_version = 0;
  assert t.password_hash like '$2a$12$%' and t.password_hash <> 'team-password-1', 'password stored as a bcrypt hash';
  assert position('team-password-1' in (select string_agg(x::text, ' ') from teams x)) = 0, 'no plaintext password in teams';
  assert t.coins = 500 and t.coins = (select initial_coins from competition), 'initial balance 500 from the competition row';
  -- ledger
  assert (select count(*) from coin_transactions where team_id = tid) = 1;
  assert (select type::text || amount || '/' || balance_after from coin_transactions where team_id = tid) = 'INITIAL_GRANT500/500';
  assert not exists (select 1 from app.invariant_coin_balance_mismatch), 'teams.coins equals the ledger';
  -- members M1..M4, normalised, all in this team
  assert (select count(*) from team_members where team_id = tid) = 4;
  assert (select array_agg(slot::int order by slot) from team_members where team_id = tid) = array[1, 2, 3, 4];
  assert (select array_agg(admission_no order by slot) from team_members where team_id = tid) = array['23JE0001', '23JE0002', '23JE0003', '23JE0004'];
  assert not exists (select 1 from app.invariant_team_member_count);
  -- audit
  assert (select count(*) from audit_events where event_type = 'TEAM_CREATED' and team_id = tid) = 1;
  assert (select staff_id from audit_events where event_type = 'TEAM_CREATED' and team_id = tid) = pg_temp.a2();
  assert (select payload->>'initial_coins' from audit_events where event_type = 'TEAM_CREATED' and team_id = tid) = '500';
  assert position('team-password-1' in (select string_agg(payload::text, ' ') from audit_events)) = 0, 'audit has no password';
  assert position('23JE000' in (select string_agg(payload::text, ' ') from audit_events)) = 0, 'audit has no admission numbers';
  assert position('team-password-1' in (select string_agg(request_fingerprint || response::text, ' ') from request_log)) = 0;
  assert not (pg_temp.keys_of(j) && array['password', 'password_hash', 'admission_no', 'admission_nos', 'token']), 'no secret in the response: ' || pg_temp.keys_of(j)::text;
end $$;

-- the new team authenticates through the existing participant login (competition RUNNING), M1..M4 each work
update competition set status = 'RUNNING', opened_at = now() where id = 1;
do $$
declare l jsonb; i int;
begin
  for i in 1..4 loop
    l := public.participant_login('euclid_team', 'team-password-1', '23JE000' || i, pg_temp.tok(10 + i), '203.0.113.7'::inet, 'test-agent');
    assert (l->>'ok')::boolean and l->>'role' = 'PARTICIPANT' and (l->'member'->>'slot')::int = i and l->'team'->>'code' = 'T10',
           'member ' || i || ' logs in: ' || l::text;
  end loop;
  -- wrong admission number, another team's admission number, wrong password: the same generic failure
  assert l is not null;
  assert (public.participant_login('euclid_team', 'team-password-1', '23JE9999', pg_temp.tok(20))->>'code') = 'INVALID_CREDENTIALS';
  assert (public.participant_login('euclid_team', 'team-password-1', 'TEST11', pg_temp.tok(21))->>'code') = 'INVALID_CREDENTIALS';
  assert (public.participant_login('euclid_team', 'wrong-password', '23JE0001', pg_temp.tok(22))->>'code') = 'INVALID_CREDENTIALS';
end $$;
update competition set status = 'SETUP', opened_at = null where id = 1;
delete from auth_throttle;

-- ===== 5. create_team: validation and uniqueness, each rejection rolls EVERYTHING back =================================
create temp table before_counts as
  select (select count(*) from teams) as teams, (select count(*) from team_members) as members,
         (select count(*) from coin_transactions) as ledger, (select count(*) from audit_events) as audit,
         (select count(*) from request_log) as reqs;
create function pg_temp.unchanged() returns boolean language sql as $$
  select (select count(*) from teams) = b.teams and (select count(*) from team_members) = b.members
     and (select count(*) from coin_transactions) = b.ledger and (select count(*) from audit_events) = b.audit
     and (select count(*) from request_log) = b.reqs from before_counts b $$;

select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 't10', 'Dup code', 'dup_code_login', 'team-password-2', 'P1', 'P2', 'P3', 'P4', 11)$s$, 'TEAM_CODE_TAKEN');     -- case-insensitive via normalisation
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'T11', 'Dup login', 'EUCLID_TEAM', 'team-password-2', 'P1', 'P2', 'P3', 'P4', 11)$s$, 'LOGIN_ID_TAKEN');          -- citext
-- the conflict is on slot 4 only, after the team and three members were inserted: all of it must roll back
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'T11', 'Dup adm', 'dup_adm_login', 'team-password-2', 'P1', 'P2', 'P3', '23je0001', 11)$s$, 'ADMISSION_NO_TAKEN');
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'T11', 'Dup adm', 'dup_adm_login', 'team-password-2', 'TEST11', 'P2', 'P3', 'P4', 11)$s$, 'ADMISSION_NO_TAKEN');      -- another team's member
do $$ declare d text; begin
  begin perform pg_temp.team(pg_temp.a2(), 'T11', 'Dup adm', 'dup_adm_login', 'team-password-2', 'P1', 'P2', 'TEST12', 'P4', 11);
  exception when others then get stacked diagnostics d = pg_exception_detail; end;
  assert d::jsonb = '{"slot": 3}'::jsonb, 'the detail names only the slot: ' || coalesce(d, 'null');
end $$;
-- validation
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), '', 'N', 'valid_login', 'team-password-2', 'P1', 'P2', 'P3', 'P4', 12)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'TOO-LONG-CODE-123456', 'N', 'valid_login', 'team-password-2', 'P1', 'P2', 'P3', 'P4', 12)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'T12', '   ', 'valid_login', 'team-password-2', 'P1', 'P2', 'P3', 'P4', 12)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'T12', repeat('n', 101), 'valid_login', 'team-password-2', 'P1', 'P2', 'P3', 'P4', 12)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'T12', 'N', 'no', 'team-password-2', 'P1', 'P2', 'P3', 'P4', 12)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'T12', 'N', 'bad login!', 'team-password-2', 'P1', 'P2', 'P3', 'P4', 12)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'T12', 'N', 'valid_login', 'short', 'P1', 'P2', 'P3', 'P4', 12)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'T12', 'N', 'valid_login', repeat('x', 73), 'P1', 'P2', 'P3', 'P4', 12)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'T12', 'N', 'valid_login', 'VALID_LOGIN', 'P1', 'P2', 'P3', 'P4', 12)$s$, 'VALIDATION_FAILED');   -- password = login id
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'PASSWORD99', 'N', 'valid_login', 'password99', 'P1', 'P2', 'P3', 'P4', 12)$s$, 'VALIDATION_FAILED'); -- password = team id
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'T12', 'N', 'valid_login', null, 'P1', 'P2', 'P3', 'P4', 12)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'T12', 'N', 'valid_login', 'team-password-2', '', 'P2', 'P3', 'P4', 12)$s$, 'VALIDATION_FAILED');      -- M1 required
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'T12', 'N', 'valid_login', 'team-password-2', 'P1', 'P2', 'P3', '   ', 12)$s$, 'VALIDATION_FAILED');   -- M4 required
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'T12', 'N', 'valid_login', 'team-password-2', 'P1', 'p1', 'P3', 'P4', 12)$s$, 'VALIDATION_FAILED');    -- the same number twice
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'T12', 'N', 'valid_login', 'team-password-2', 'P 1', 'P2', 'P3', 'P4', 12)$s$, 'VALIDATION_FAILED');   -- a space inside
select pg_temp.rejects($s$select public.create_team(pg_temp.a2(), 'T12', 'N', 'valid_login', 'team-password-2', array['P1','P2','P3'], pg_temp.key(12))$s$, 'VALIDATION_FAILED');       -- three
select pg_temp.rejects($s$select public.create_team(pg_temp.a2(), 'T12', 'N', 'valid_login', 'team-password-2', array['P1','P2','P3','P4','P5'], pg_temp.key(12))$s$, 'VALIDATION_FAILED'); -- five
select pg_temp.rejects($s$select public.create_team(pg_temp.a2(), 'T12', 'N', 'valid_login', 'team-password-2', null, pg_temp.key(12))$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.create_team(pg_temp.a2(), 'T12', 'N', 'valid_login', 'team-password-2', array['P1', null, 'P3', 'P4'], pg_temp.key(12))$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.create_team(pg_temp.a2(), 'T12', 'N', 'valid_login', 'team-password-2', array['P1','P2','P3','P4'], null)$s$, 'VALIDATION_FAILED');       -- no key
-- only an active ADMIN may create a team (the Super Admin does not: there is no owner to assign)
select pg_temp.rejects($s$select pg_temp.team('00000000-0000-0000-0000-0000000000a1', 'T12', 'N', 'valid_login', 'team-password-2', 'P1', 'P2', 'P3', 'P4', 13)$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select pg_temp.team(gen_random_uuid(), 'T12', 'N', 'valid_login', 'team-password-2', 'P1', 'P2', 'P3', 'P4', 13)$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select pg_temp.team(null, 'T12', 'N', 'valid_login', 'team-password-2', 'P1', 'P2', 'P3', 'P4', 13)$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select pg_temp.team('00000000-0000-0000-0000-00000000c101', 'T12', 'N', 'valid_login', 'team-password-2', 'P1', 'P2', 'P3', 'P4', 13)$s$, 'FORBIDDEN');  -- a participant
do $$ begin
  assert pg_temp.unchanged(), 'no rejected request left a team, member, ledger row, audit row or request_log row';
  assert (select count(*) from teams where team_code in ('T11', 'T12')) = 0;
end $$;
update staff_users set is_active = false where id = '00000000-0000-0000-0000-0000000000a2';
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'T12', 'N', 'valid_login', 'team-password-2', 'P1', 'P2', 'P3', 'P4', 14)$s$, 'FORBIDDEN');   -- a disabled admin
update staff_users set is_active = true where id = '00000000-0000-0000-0000-0000000000a2';

-- ===== 6. create_team: idempotency ====================================================================================
do $$
declare j jsonb := (select j from t1); again jsonb;
begin
  again := pg_temp.team(pg_temp.a2(), ' t10 ', '  The Euclids  ', 'Euclid_Team', 'team-password-1', ' 23je0001 ', '23JE0002', '23je0003', '23JE0004', 10);
  assert (again->>'replayed')::boolean and again->'team' = j->'team', 'the same key returns the stored response';
  assert (select count(*) from teams where team_code = 'T10') = 1, 'no duplicate team';
  assert (select count(*) from team_members where team_id = (j->'team'->>'id')::uuid) = 4, 'no duplicate members';
  assert (select count(*) from coin_transactions where team_id = (j->'team'->>'id')::uuid and type = 'INITIAL_GRANT') = 1, 'no duplicate initial grant';
  assert (select count(*) from audit_events where event_type = 'TEAM_CREATED') = 1;
end $$;
select pg_temp.rejects($s$select pg_temp.team(pg_temp.a2(), 'T13', 'Other', 'other_login', 'team-password-3', 'Q1', 'Q2', 'Q3', 'Q4', 10)$s$, 'IDEMPOTENCY_KEY_REUSED');
-- the same key from a different admin is a different scope: it is simply a new request
do $$ begin
  perform pg_temp.team(pg_temp.a3(), 'T20', 'Admin 3 team', 'admin3_team', 'team-password-4', 'R1', 'R2', 'R3', 'R4', 10);
  assert (select count(*) from teams where team_code = 'T20' and admin_id = pg_temp.a3()) = 1;
end $$;

-- ===== 7. ownership isolation =========================================================================================
-- Admin a2 owns T01 (fixture? no: the fixture assigns T01 to a2, T02 to a3) and the new T10; a3 owns T02 and T20.
do $$
declare m2 jsonb := public.list_admin_teams(pg_temp.a2()); m3 jsonb := public.list_admin_teams(pg_temp.a3());
begin
  assert (select array_agg(x->>'team_code' order by x->>'team_code') from jsonb_array_elements(m2->'teams') x) = array['T01', 'T10'], 'a2 sees only its own: ' || m2::text;
  assert (select array_agg(x->>'team_code' order by x->>'team_code') from jsonb_array_elements(m3->'teams') x) = array['T02', 'T20'], 'a3 sees only its own: ' || m3::text;
  assert not (pg_temp.keys_of(m2) && array['password', 'password_hash', 'admission_no', 'admission_nos', 'token']), 'no secret in My Teams: ' || pg_temp.keys_of(m2)::text;
  assert (select (x->>'member_count')::int from jsonb_array_elements(m2->'teams') x where x->>'team_code' = 'T10') = 4;
  assert (select x->>'login_id' from jsonb_array_elements(m2->'teams') x where x->>'team_code' = 'T10') = 'Euclid_Team';
end $$;
select pg_temp.rejects($s$select public.list_admin_teams('00000000-0000-0000-0000-0000000000a1')$s$, 'FORBIDDEN');      -- the Super Admin has no "My Teams"
select pg_temp.rejects($s$select public.list_admin_teams(gen_random_uuid())$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.list_admin_teams(null)$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.list_admin_teams('00000000-0000-0000-0000-00000000c101')$s$, 'FORBIDDEN');       -- a member id
-- a participant of one team cannot read another team's state (existing B10 guard, re-proved on a created team)
do $$ declare tid uuid := (select (j->'team'->>'id')::uuid from t1);
begin
  begin perform public.get_team_state(tid, '00000000-0000-0000-0000-00000000c201'::uuid);   -- a member of T02
    raise exception 'a participant of T02 read T10';
  exception when others then assert sqlerrm = 'FORBIDDEN', 'wrong error: ' || sqlerrm; end;
  begin perform public.get_team_state('00000000-0000-0000-0000-0000000000b1'::uuid, (select id from team_members where team_id = tid and slot = 1));
    raise exception 'a participant of T10 read T01';
  exception when others then assert sqlerrm = 'FORBIDDEN', 'wrong error: ' || sqlerrm; end;
  assert (public.get_team_state(tid, (select id from team_members where team_id = tid and slot = 1))->'me'->>'team_code') = 'T10', 'its own team is readable';
end $$;

-- ===== 8. leaderboard =================================================================================================
update teams set final_score = 700, final_minutes_taken = 30 where team_code = 'T01';
update teams set final_score = 700, final_minutes_taken = 20 where team_code = 'T02';
update teams set score_override = -1201, status = 'DISQUALIFIED', started_at = now(), timer_seconds = 14400, ended_at = now() where team_code = 'T20';
do $$
declare lb jsonb := public.get_leaderboard('00000000-0000-0000-0000-0000000000a1'); lb2 jsonb := public.get_leaderboard(pg_temp.a2());
begin
  assert lb = lb2, 'the board is the same for every staff member';
  assert (select array_agg(x->>'team_id' order by (x->>'rank')::int) from jsonb_array_elements(lb->'rows') x) = array['T02', 'T01', 'T10', 'T20'],
         'score desc, fewer minutes first, disqualified last: ' || lb::text;
  assert (select array_agg((x->>'rank')::int order by (x->>'rank')::int) from jsonb_array_elements(lb->'rows') x) = array[1, 2, 3, 4], 'ranks 1..N over all teams';
  assert (select array_agg((x->>'score')::int order by (x->>'rank')::int) from jsonb_array_elements(lb->'rows') x) = array[700, 700, 0, -1201];
  assert pg_temp.keys_of(lb) = array['rank', 'rows', 'score', 'team_id'], 'only rank, team code and score: ' || pg_temp.keys_of(lb)::text;
end $$;
select pg_temp.rejects($s$select public.get_leaderboard(gen_random_uuid())$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.get_leaderboard(null)$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.get_leaderboard('00000000-0000-0000-0000-00000000c101')$s$, 'FORBIDDEN');         -- a participant
update staff_users set is_active = false where id = '00000000-0000-0000-0000-0000000000a3';
select pg_temp.rejects($s$select public.get_leaderboard(pg_temp.a3())$s$, 'FORBIDDEN');                                    -- disabled admin
update staff_users set is_active = true where id = '00000000-0000-0000-0000-0000000000a3';

-- ===== 9. privileges ==================================================================================================
do $$
declare r record; n int := 0;
begin
  for r in select p.oid, p.proacl, p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig
             from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname in ('create_admin', 'create_team', 'list_admin_teams', 'get_leaderboard')
  loop
    n := n + 1;
    assert r.prosecdef, r.sig || ': SECURITY DEFINER';
    assert exists (select 1 from unnest(r.proconfig) c where c like 'search_path=%'), r.sig || ': pinned search_path';
    assert r.proacl is not null, r.sig || ': ACL must be explicit';
    assert not exists (select 1 from aclexplode(r.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'), r.sig || ': EXECUTE granted to PUBLIC';
    assert not has_function_privilege('anon', r.oid, 'execute') and not has_function_privilege('authenticated', r.oid, 'execute'), r.sig || ': a browser role can execute';
    assert has_function_privilege('service_role', r.oid, 'execute'), r.sig || ': service_role cannot execute';
  end loop;
  assert n = 4, 'the catalog check saw all four functions (' || n || ')';
end $$;

do $$
begin
  set local role anon;
  begin perform public.create_admin(gen_random_uuid(), 'x', 'y', gen_random_uuid()); raise exception 'anon called create_admin';
  exception when insufficient_privilege then null; end;
  begin perform public.create_team(gen_random_uuid(), 'x', 'y', 'z', 'w', array['a','b','c','d'], gen_random_uuid()); raise exception 'anon called create_team';
  exception when insufficient_privilege then null; end;
  reset role;
  set local role authenticated;
  begin perform public.create_admin(gen_random_uuid(), 'x', 'y', gen_random_uuid()); raise exception 'authenticated called create_admin';
  exception when insufficient_privilege then null; end;
  begin perform public.create_team(gen_random_uuid(), 'x', 'y', 'z', 'w', array['a','b','c','d'], gen_random_uuid()); raise exception 'authenticated called create_team';
  exception when insufficient_privilege then null; end;
  begin perform public.list_admin_teams(gen_random_uuid()); raise exception 'authenticated called list_admin_teams';
  exception when insufficient_privilege then null; end;
  begin perform public.get_leaderboard(gen_random_uuid()); raise exception 'authenticated called get_leaderboard';
  exception when insufficient_privilege then null; end;
  begin perform 1 from teams; raise exception 'authenticated can read teams';
  exception when insufficient_privilege then null; end;
  reset role;
end $$;

rollback;

-- Teams, members (M1–M4), staff roles and sessions.
begin;
\ir include/helpers.sql
\ir include/fixture.sql

-- team / member relationships
do $$
begin
  assert (select count(*) from team_members where team_id = '00000000-0000-0000-0000-0000000000b1') = 4;
  assert (select string_agg(slot::text, ',' order by slot) from team_members where team_id = '00000000-0000-0000-0000-0000000000b1') = '1,2,3,4', 'M1..M4';
  assert not exists (select 1 from app.invariant_team_member_count), 'every team has 1..4 members';
end $$;
-- at most 4 members, slots 1..4, one member per slot
select pg_temp.rejects($s$insert into team_members (team_id, slot, admission_no) values ('00000000-0000-0000-0000-0000000000b1', 5, 'TESTX5')$s$, 'team_members_slot_check');
select pg_temp.rejects($s$insert into team_members (team_id, slot, admission_no) values ('00000000-0000-0000-0000-0000000000b1', 4, 'TESTX4')$s$, '23505');
select pg_temp.rejects($s$insert into team_members (team_id, slot, admission_no) values ('00000000-0000-0000-0000-0000000000b1', 0, 'TESTX0')$s$, 'team_members_slot_check');
-- admission numbers are globally unique (also across teams) and normalised
select pg_temp.rejects($s$update team_members set admission_no = 'TEST11' where team_id = '00000000-0000-0000-0000-0000000000b2' and slot = 1$s$, '23505');
select pg_temp.rejects($s$insert into team_members (team_id, slot, admission_no) values ('00000000-0000-0000-0000-0000000000b2', 5, 'lower case')$s$, '23514');
-- a member must belong to a real team
select pg_temp.rejects($s$insert into team_members (team_id, slot, admission_no) values (gen_random_uuid(), 1, 'NOTEAM1')$s$, '23503');
-- team identity is unique (team id and login id, login case-insensitive)
select pg_temp.rejects($s$insert into teams (team_code, name, login_id, password_hash, admin_id, coins) values ('T01', 'dup', 'other_login', 'x', '00000000-0000-0000-0000-0000000000a2', 500)$s$, '23505');
select pg_temp.rejects($s$insert into teams (team_code, name, login_id, password_hash, admin_id, coins) values ('T99', 'dup', 'TEST_TEAM_01', 'x', '00000000-0000-0000-0000-0000000000a2', 500)$s$, '23505');
-- every team has an assigned admin, which must exist
select pg_temp.rejects($s$insert into teams (team_code, name, login_id, password_hash, admin_id, coins) values ('T98', 'x', 'x98', 'x', gen_random_uuid(), 500)$s$, '23503');
-- the balance can never be negative
select pg_temp.rejects($s$update teams set coins = -1 where team_code = 'T01'$s$, 'teams_coins_check');
-- teams with members cannot be deleted (history is kept)
select pg_temp.rejects($s$delete from teams where team_code = 'T01'$s$, '23503');

-- roles: exactly one Super Admin; admins are created by staff; no PARTICIPANT staff role
select pg_temp.rejects($s$insert into staff_users (username, display_name, password_hash, role) values ('second_super', 'x', 'TEST-NOT-A-HASH', 'SUPER_ADMIN')$s$, 'staff_one_super_admin');
select pg_temp.rejects($s$insert into staff_users (username, display_name, password_hash, role) values ('orphan_admin', 'x', 'TEST-NOT-A-HASH', 'ADMIN')$s$, 'staff_admin_has_creator');
select pg_temp.rejects($s$insert into staff_users (username, display_name, password_hash, role) values ('p', 'x', 'TEST-NOT-A-HASH', 'PARTICIPANT')$s$, '22P02');
select pg_temp.rejects($s$insert into staff_users (username, display_name, password_hash, role, created_by) values ('TEST_ADMIN1', 'x', 'TEST-NOT-A-HASH', 'ADMIN', '00000000-0000-0000-0000-0000000000a1')$s$, '23505');   -- citext: case-insensitive

-- admin ↔ team assignment is dynamic (reassignable) and isolates by admin_id
update teams set admin_id = '00000000-0000-0000-0000-0000000000a3' where team_code = 'T01';
do $$ begin
  assert (select count(*) from teams where admin_id = '00000000-0000-0000-0000-0000000000a3') = 2, 'admin2 now owns both teams';
  assert (select count(*) from teams where admin_id = '00000000-0000-0000-0000-0000000000a2') = 0;
end $$;

-- sessions: member sessions need a member of that same team; staff sessions need a staff user
insert into sessions (token_hash, kind, member_id, team_id, expires_at)
values ('\x01', 'MEMBER', '00000000-0000-0000-0000-00000000c102', '00000000-0000-0000-0000-0000000000b1', now() + interval '12 hours');
insert into sessions (token_hash, kind, staff_id, expires_at) values ('\x02', 'STAFF', '00000000-0000-0000-0000-0000000000a1', now() + interval '12 hours');
select pg_temp.rejects($s$insert into sessions (token_hash, kind, member_id, team_id, expires_at) values ('\x03', 'MEMBER', '00000000-0000-0000-0000-00000000c103', '00000000-0000-0000-0000-0000000000b2', now() + interval '1 hour')$s$, 'sessions_member_belongs_to_team');
select pg_temp.rejects($s$insert into sessions (token_hash, kind, expires_at) values ('\x04', 'STAFF', now() + interval '1 hour')$s$, 'sessions_principal');
select pg_temp.rejects($s$insert into sessions (token_hash, kind, member_id, team_id, staff_id, expires_at) values ('\x05', 'MEMBER', '00000000-0000-0000-0000-00000000c103', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', now() + interval '1 hour')$s$, 'sessions_principal');
-- token hashes are unique; one live session per member; expiry/revocation rules
select pg_temp.rejects($s$insert into sessions (token_hash, kind, staff_id, expires_at) values ('\x01', 'STAFF', '00000000-0000-0000-0000-0000000000a1', now() + interval '1 hour')$s$, '23505');
select pg_temp.rejects($s$insert into sessions (token_hash, kind, member_id, team_id, expires_at) values ('\x06', 'MEMBER', '00000000-0000-0000-0000-00000000c102', '00000000-0000-0000-0000-0000000000b1', now() + interval '1 hour')$s$, 'sessions_one_live_member');
select pg_temp.rejects($s$insert into sessions (token_hash, kind, staff_id, expires_at) values ('\x07', 'STAFF', '00000000-0000-0000-0000-0000000000a1', now() - interval '1 hour')$s$, 'sessions_expiry_after_creation');
select pg_temp.rejects($s$update sessions set revoked_at = now() where token_hash = '\x01'$s$, 'sessions_revoke_pair');
-- after revocation a new live session for the same member is allowed (re-login supersedes)
update sessions set revoked_at = now(), revoke_reason = 'SUPERSEDED' where token_hash = '\x01';
insert into sessions (token_hash, kind, member_id, team_id, expires_at)
values ('\x08', 'MEMBER', '00000000-0000-0000-0000-00000000c102', '00000000-0000-0000-0000-0000000000b1', now() + interval '12 hours');
do $$ begin
  assert (select count(*) from member_sessions where is_live) = 1 and (select member_slot from member_sessions where is_live) = 2, 'member_sessions exposes the M-slot';
  assert (select count(*) from admin_sessions where is_live) = 1 and (select staff_role from admin_sessions where is_live) = 'SUPER_ADMIN';
  assert (select presence from member_presence where member_id = '00000000-0000-0000-0000-00000000c102') = 'ONLINE';
  assert (select presence from member_presence where member_id = '00000000-0000-0000-0000-00000000c103') = 'OFFLINE';
  assert (select count(*) from team_sessions) = 2;
end $$;
rollback;

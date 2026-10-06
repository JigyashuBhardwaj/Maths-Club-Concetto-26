-- Two teams with four members each. Throwaway test rows inside the test's own transaction; never seeded.
-- Hashes are obvious non-credentials.
insert into staff_users (id, username, display_name, password_hash, role)
values ('00000000-0000-0000-0000-0000000000a1', 'test_super', 'Test Super', 'TEST-NOT-A-HASH', 'SUPER_ADMIN');
insert into staff_users (id, username, display_name, password_hash, role, created_by)
values ('00000000-0000-0000-0000-0000000000a2', 'test_admin1', 'Test Admin 1', 'TEST-NOT-A-HASH', 'ADMIN', '00000000-0000-0000-0000-0000000000a1'),
       ('00000000-0000-0000-0000-0000000000a3', 'test_admin2', 'Test Admin 2', 'TEST-NOT-A-HASH', 'ADMIN', '00000000-0000-0000-0000-0000000000a1');
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
values ('00000000-0000-0000-0000-0000000000b1', 'T01', 'Test Team 1', 'test_team_01', 'TEST-NOT-A-HASH', '00000000-0000-0000-0000-0000000000a2', 500),
       ('00000000-0000-0000-0000-0000000000b2', 'T02', 'Test Team 2', 'test_team_02', 'TEST-NOT-A-HASH', '00000000-0000-0000-0000-0000000000a3', 500);
insert into team_members (id, team_id, slot, admission_no)
select ('00000000-0000-0000-0000-00000000c' || t.n || '0' || s)::uuid, ('00000000-0000-0000-0000-0000000000b' || t.n)::uuid, s, 'TEST' || t.n || s
from generate_series(1, 2) t(n) cross join generate_series(1, 4) s;
insert into coin_transactions (team_id, type, amount, balance_after, created_at)
values ('00000000-0000-0000-0000-0000000000b1', 'INITIAL_GRANT', 500, 500, now()),
       ('00000000-0000-0000-0000-0000000000b2', 'INITIAL_GRANT', 500, 500, now());

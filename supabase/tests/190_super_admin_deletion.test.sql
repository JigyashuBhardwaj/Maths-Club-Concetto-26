-- B18 / migration 20 (revised): the Super Admin permanently and COMPLETELY deletes Admins and Teams.
-- Proves: authorisation, strict selections, complete + scoped removal (team data, purchase history, the team's whole coin
-- ledger, request_log records), that unrelated accounts and their money are bit-for-bit unchanged, the narrow ledger
-- exception (and that every other append-only protection - UPDATE, TRUNCATE, audit_events - still holds), atomic rollback
-- (ledger and request_log deletions included), idempotent replay, session invalidation, login-ID / username reuse.
-- Multi-connection races are in concurrency/team_deletion.concurrency.mjs; the upgrade from migration 19 is in
-- upgrade/b18_upgrade.upgrade.mjs.
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
create function pg_temp.tok(n int) returns bytea language sql as $$ select sha256(convert_to('del-token-' || n, 'UTF8')) $$;
create function pg_temp.status(act text, n int) returns jsonb language sql as
  $$ select public.set_competition_status(pg_temp.staff(1), act, pg_temp.key(n)) $$;
create function pg_temp.start(t int, n int) returns jsonb language sql as
  $$ select public.start_team_competition(pg_temp.team_id(t), pg_temp.member_id(t, 1), pg_temp.key(n)) $$;
create function pg_temp.unlock(t int, theme int, n int) returns jsonb language sql as
  $$ select public.unlock_theme(pg_temp.team_id(t), pg_temp.member_id(t, 1), theme::smallint, pg_temp.key(n)) $$;
create function pg_temp.enter(t int, q int, n int) returns jsonb language sql as
  $$ select public.start_question(pg_temp.team_id(t), pg_temp.member_id(t, 1), q::smallint, pg_temp.key(n)) $$;
create function pg_temp.submit(t int, q int, n int) returns jsonb language sql as
  $$ select public.submit_answer(pg_temp.team_id(t), pg_temp.member_id(t, 1), q::smallint, 'ans', 'because', pg_temp.key(n)) $$;
create function pg_temp.sub(t int, q int) returns uuid language sql as
  $$ select id from submissions where team_id = pg_temp.team_id(t) and question_id = q and status = 'PENDING' $$;
create function pg_temp.approve(who int, t int, q int, n int) returns jsonb language sql as
  $$ select public.approve_submission(pg_temp.staff(who), pg_temp.sub(t, q), pg_temp.key(n)) $$;
create function pg_temp.hint(t int, q int, tier int, n int) returns jsonb language sql as
  $$ select public.buy_hint(pg_temp.team_id(t), pg_temp.member_id(t, 1), q::smallint, tier::smallint, pg_temp.key(n)) $$;
create function pg_temp.time(t int, q int, expected int, n int) returns jsonb language sql as
  $$ select public.buy_time(pg_temp.team_id(t), pg_temp.member_id(t, 1), q::smallint, ((q - 1) * 3 + 1)::smallint, expected, pg_temp.key(n)) $$;
create function pg_temp.draft(t int, q int, v int) returns jsonb language sql as
  $$ select public.save_draft(pg_temp.team_id(t), pg_temp.member_id(t, 1), q::smallint, 'draft ' || v, v, 'expl') $$;

-- the Super Admin's calls
create function pg_temp.del_teams(ids uuid[], n int) returns jsonb language sql as
  $$ select public.delete_teams(pg_temp.staff(1), ids, pg_temp.key(n)) $$;
create function pg_temp.del_admins(ids uuid[], n int) returns jsonb language sql as
  $$ select public.delete_admins(pg_temp.staff(1), ids, pg_temp.key(n)) $$;


-- every row a team owns, in every table that references teams (a count)
create function pg_temp.team_rows(t uuid) returns bigint language sql as $$
  select (select count(*) from teams where id = t) + (select count(*) from team_members where team_id = t)
       + (select count(*) from sessions where team_id = t) + (select count(*) from team_themes where team_id = t)
       + (select count(*) from team_questions where team_id = t) + (select count(*) from answer_drafts where team_id = t)
       + (select count(*) from hint_purchases where team_id = t) + (select count(*) from team_time_purchases where team_id = t)
       + (select count(*) from submissions where team_id = t) + (select count(*) from ufm_challenges where team_id = t)
       + (select count(*) from coin_transactions where team_id = t) + (select count(*) from request_log where team_id = t) $$;
-- the purchase history of one team, row by row
create function pg_temp.ttp_fp(t uuid) returns text language sql as
  $$ select coalesce(md5(string_agg(x::text, ',' order by x.question_id, x.seq)), '-') || '/' || count(*) from team_time_purchases x where x.team_id = t $$;
-- a fingerprint of a team's whole operational state (to prove an unselected team did not change)
create function pg_temp.team_fp(t uuid) returns text language sql as $$
  select md5(concat_ws('|',
    (select string_agg(x::text, ',' order by x::text) from teams x where id = t),
    (select string_agg(x::text, ',' order by x::text) from team_members x where team_id = t),
    (select string_agg(x::text, ',' order by x::text) from sessions x where team_id = t),
    (select string_agg(x::text, ',' order by x::text) from team_themes x where team_id = t),
    (select string_agg(x::text, ',' order by x::text) from team_questions x where team_id = t),
    (select string_agg(x::text, ',' order by x::text) from answer_drafts x where team_id = t),
    (select string_agg(x::text, ',' order by x::text) from hint_purchases x where team_id = t),
    (select string_agg(x::text, ',' order by x::text) from team_time_purchases x where team_id = t),
    (select string_agg(x::text, ',' order by x::text) from submissions x where team_id = t),
    (select string_agg(x::text, ',' order by x::text) from coin_transactions x where team_id = t),
    (select string_agg(x::text, ',' order by x::text) from request_log x where team_id = t))) $$;


-- key number of an idempotency key made by pg_temp.key(n)
create function pg_temp.knum(k uuid) returns int language sql as $$ select right(k::text, 12)::int $$;
-- the key numbers of the request_log rows that were in <snap> and are gone now / that are new now
create function pg_temp.log_gone(snap text) returns int[] language plpgsql as $f$
declare r int[];
begin
  execute format($q$select coalesce(array_agg(pg_temp.knum(idem_key) order by pg_temp.knum(idem_key)), '{}') from
                     (select team_id, idem_key from %I except select team_id, idem_key from request_log) d$q$, snap) into r;
  return r;
end $f$;
create function pg_temp.log_new(snap text) returns int[] language plpgsql as $f$
declare r int[];
begin
  execute format($q$select coalesce(array_agg(pg_temp.knum(idem_key) order by pg_temp.knum(idem_key)), '{}') from
                     (select team_id, idem_key from request_log except select team_id, idem_key from %I) d$q$, snap) into r;
  return r;
end $f$;
-- rows that survived must be byte-identical
create function pg_temp.log_changed(snap text) returns bigint language plpgsql as $f$
declare r bigint;
begin
  execute format($q$select count(*) from %I s join request_log l using (team_id, idem_key) where to_jsonb(s) <> to_jsonb(l)$q$, snap) into r;
  return r;
end $f$;
-- the ledger of ONE team, row by row (a deleted team's must be gone; everyone else's must be untouched)
create function pg_temp.ledger_team_fp(t uuid) returns text language sql as
  $$ select coalesce(md5(string_agg(c::text, ',' order by c.id)), '-') || '/' || count(*) from coin_transactions c where c.team_id = t $$;
-- every row that exists in a table now, as one fingerprint (used to prove a rollback restored everything)
create function pg_temp.table_fp(tbl text) returns text language plpgsql as $f$
declare r text;
begin
  execute format($q$select coalesce(md5(string_agg(x::text, ',' order by x::text)), '-') || '/' || count(*) from %I x$q$, tbl) into r;
  return r;
end $f$;
create function pg_temp.world_fp() returns text language sql as $$
  select concat_ws('|', pg_temp.table_fp('teams'), pg_temp.table_fp('team_members'), pg_temp.table_fp('staff_users'), pg_temp.table_fp('sessions'),
    pg_temp.table_fp('team_themes'), pg_temp.table_fp('team_questions'), pg_temp.table_fp('answer_drafts'), pg_temp.table_fp('hint_purchases'),
    pg_temp.table_fp('team_time_purchases'), pg_temp.table_fp('submissions'), pg_temp.table_fp('ufm_challenges'), pg_temp.table_fp('auth_throttle'),
    pg_temp.table_fp('request_log'), pg_temp.table_fp('coin_transactions'), pg_temp.table_fp('audit_events')) $$;


-- ---- data ---------------------------------------------------------------------------------------------------------

-- ---- data ---------------------------------------------------------------------------------------------------------
-- admins: a2 (teams b1, b3), a3 (teams b2, b4); a4 has no team; a5 owns b5; a6 owns b6
insert into staff_users (id, username, display_name, password_hash, role, created_by)
values (pg_temp.staff(4), 'test_admin3', 'Test Admin 3', 'TEST-NOT-A-HASH', 'ADMIN', pg_temp.staff(1)),
       (pg_temp.staff(5), 'test_admin4', 'Test Admin 4', 'TEST-NOT-A-HASH', 'ADMIN', pg_temp.staff(1)),
       (pg_temp.staff(6), 'test_admin5', 'Test Admin 5', 'TEST-NOT-A-HASH', 'ADMIN', pg_temp.staff(1));
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
select pg_temp.team_id(n), 'T0' || n, 'Test Team ' || n, 'test_team_0' || n, 'TEST-NOT-A-HASH',
       pg_temp.staff(case n when 3 then 2 when 4 then 3 when 5 then 5 else 6 end), 500
  from generate_series(3, 6) n;
insert into team_members (id, team_id, slot, admission_no)
select pg_temp.member_id(n, s), pg_temp.team_id(n), s, 'TEST' || n || s from generate_series(3, 6) n cross join generate_series(1, 4) s;
insert into coin_transactions (team_id, type, amount, balance_after, created_at)
select pg_temp.team_id(n), 'INITIAL_GRANT', 500, 500, now() from generate_series(3, 6) n;

-- real gameplay on teams 1 and 2: start, unlock, enter, draft, hint, time, submit, approve (a reward row WITH a submission id)
select pg_temp.status('open', 1);
select pg_temp.start(1, 2), pg_temp.start(2, 3), pg_temp.start(3, 4);
select pg_temp.at('2026-12-01 12:01:00+00');
select pg_temp.unlock(1, 1, 10), pg_temp.unlock(2, 1, 11), pg_temp.unlock(3, 1, 12);
select pg_temp.at('2026-12-01 12:02:00+00');
select pg_temp.enter(1, 1, 13), pg_temp.enter(2, 1, 14), pg_temp.enter(3, 1, 15);
select pg_temp.draft(1, 1, 0), pg_temp.draft(2, 1, 0);
select pg_temp.hint(1, 1, 1, 16), pg_temp.hint(2, 1, 1, 17);
select pg_temp.time(1, 1, 0, 18), pg_temp.time(2, 1, 0, 19), pg_temp.time(3, 1, 0, 24);
select pg_temp.at('2026-12-01 12:03:00+00');
select pg_temp.submit(1, 1, 20), pg_temp.submit(2, 1, 21), pg_temp.submit(3, 1, 22);
select pg_temp.approve(2, 1, 1, 23);                         -- team 1: Q1 approved + reward (ledger row names the submission)
select pg_temp.at('2026-12-01 12:04:00+00');
-- sessions: one MEMBER session per member of teams 1..3, one STAFF session for admins a2, a3 and the Super Admin
insert into sessions (token_hash, kind, team_id, member_id, expires_at)
select pg_temp.tok(t * 10 + s), 'MEMBER', pg_temp.team_id(t), pg_temp.member_id(t, s), app.now() + interval '1 hour'
  from generate_series(1, 3) t cross join generate_series(1, 2) s;
insert into sessions (token_hash, kind, staff_id, expires_at)
select pg_temp.tok(100 + n), 'STAFF', pg_temp.staff(n), app.now() + interval '1 hour' from generate_series(1, 3) n;
-- throttle rows for the logins that are about to disappear, and one that must survive
insert into auth_throttle (key, window_start, attempts) values
  ('team:test_team_01', now(), 3), ('staff:test_admin1', now(), 3), ('team:test_team_02', now(), 3), ('staff:other', now(), 3);
-- a UFM challenge on team 1 (staff a2) and one on team 2 (staff a3)
insert into ufm_challenges (staff_id, team_id, action, expires_at)
values (pg_temp.staff(2), pg_temp.team_id(1), 'RESET_SCORE', now() + interval '5 minutes'),
       (pg_temp.staff(3), pg_temp.team_id(2), 'RESET_SCORE', now() + interval '5 minutes');

-- the data is real: team 1 has progress in every operational table
do $$
declare t uuid := pg_temp.team_id(1);
begin
  assert (select count(*) from team_themes where team_id = t) = 1 and (select count(*) from team_questions where team_id = t) = 5;
  assert (select count(*) from answer_drafts where team_id = t) = 1 and (select count(*) from hint_purchases where team_id = t) = 1;
  assert (select count(*) from team_time_purchases where team_id = t) = 1 and (select count(*) from submissions where team_id = t) = 1;
  assert (select count(*) from sessions where team_id = t) = 2 and (select count(*) from request_log where team_id = t) > 0;
  assert exists (select 1 from coin_transactions where team_id = t and type = 'QUESTION_REWARD' and submission_id is not null),
         'the reward row names the submission it paid for';
  assert (select count(*) from coin_transactions where team_id = t) = 5, 'grant + unlock + hint + time + reward';
end $$;

-- ---- more request_log writers, all real except where noted -----------------------------------------------------------
-- (scope = request_log.team_id: the team id for participant calls, the CALLER's staff id for staff calls)
-- 60/61: create_team replies in the scope of the creating admin (a2, a3)        62/63: create_admin replies in the Super Admin's scope
-- 64: the SUPER ADMIN approves team 2's submission      65: a2 disapproves team 3's      66: a2 penalises team 3
select public.create_team(pg_temp.staff(2), 'N1', 'New Team 1', 'new_team_1', 'new-team-pass-1', array['NA1', 'NA2', 'NA3', 'NA4'], pg_temp.key(60));
select public.create_team(pg_temp.staff(3), 'N2', 'New Team 2', 'new_team_2', 'new-team-pass-2', array['NB1', 'NB2', 'NB3', 'NB4'], pg_temp.key(61));
create temp table made_admins as
  select public.create_admin(pg_temp.staff(1), 'doomed_admin', 'doomed-admin-pw-1', pg_temp.key(62)) as doomed,
         public.create_admin(pg_temp.staff(1), 'kept_admin', 'kept-admin-pw-1', pg_temp.key(63)) as kept;
select pg_temp.approve(1, 2, 1, 64);
select public.disapprove_submission(pg_temp.staff(2), pg_temp.sub(3, 1), 'try again', pg_temp.key(65));
select public.penalize_team(pg_temp.staff(2), pg_temp.team_id(3), pg_temp.key(66));
-- synthetic records written by the REAL writer (app.idem_store) that must never be touched by deleting other accounts:
-- 67: a2's reply about a submission nobody owns (survives deleting TEAMS; belongs to a2's scope, so it goes with a2)
-- 70/74: team 6's own scope    71: a6's create_team reply naming team 6    72: a6 / 73: the Super Admin: reviews of unknown submissions
-- 75: a5 penalising team 6 (another admin's record that merely MENTIONS team 6)
select app.idem_store(pg_temp.staff(2), pg_temp.key(67), 'approve_submission', 'submission:' || gen_random_uuid()::text, '{"x": 67}');
select app.idem_store(pg_temp.team_id(6), pg_temp.key(70), 'unlock_theme', 'theme:x|member:y', '{"x": 70}');
select app.idem_store(pg_temp.staff(6), pg_temp.key(71), 'create_team', 'fp71',
  jsonb_build_object('team', jsonb_build_object('id', pg_temp.team_id(6), 'team_code', 'T06')));
select app.idem_store(pg_temp.staff(6), pg_temp.key(72), 'approve_submission', 'submission:' || gen_random_uuid()::text, '{"x": 72}');
select app.idem_store(pg_temp.staff(1), pg_temp.key(73), 'approve_submission', 'submission:' || gen_random_uuid()::text, '{"x": 73}');
select app.idem_store(pg_temp.team_id(6), pg_temp.key(74), 'buy_hint', 'question:q|tier:1|member:m', '{"x": 74}');
select app.idem_store(pg_temp.staff(5), pg_temp.key(75), 'penalize_team', 'team:' || pg_temp.team_id(6)::text, '{"x": 75}');
select pg_temp.at('2026-12-01 12:05:00+00');


-- ===== 1. what migration 20 changed and did NOT change ===============================================================
do $$
begin
  -- no archival registry exists: the ledger and the purchase history point at the REAL account tables, RESTRICT, original names
  assert not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name like '%\_identities'), 'no registry table';
  assert not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'app')
                      and (p.proname ~ 'identit' or p.proname in ('ledger_no_retired_refs', 'time_purchase_no_retired_refs', 'retire_teams'))), 'no registry function';
  assert (select count(*) from pg_constraint where conrelid = 'coin_transactions'::regclass and contype = 'f'
            and conname in ('coin_transactions_team_id_fkey', 'coin_tx_member_in_team', 'coin_transactions_staff_id_fkey', 'coin_transactions_submission_id_fkey')
            and confrelid in ('teams'::regclass, 'team_members'::regclass, 'staff_users'::regclass, 'submissions'::regclass) and confdeltype = 'r') = 4,
         'the four ledger account FKs are the original ones: live tables, RESTRICT';
  assert (select string_agg(conname || '>' || confrelid::regclass::text || ':' || confdeltype::text, ', ' order by conname) from pg_constraint
           where conrelid = 'team_time_purchases'::regclass and contype = 'f')
       = 'team_time_purchases_team_id_fkey>teams:r, ttp_member_in_team>team_members:r, ttp_option_fk>question_buy_time_options:r, ttp_team_question_fk>team_questions:r',
         'purchase history keeps all four original foreign keys';
  -- nothing references the ledger, the purchase table or request_log (so deleting their rows can block nothing)
  assert not exists (select 1 from pg_constraint where contype = 'f' and confrelid in ('coin_transactions'::regclass, 'team_time_purchases'::regclass, 'request_log'::regclass, 'audit_events'::regclass));
  assert not exists (select 1 from pg_constraint where contype = 'f' and conrelid in ('request_log'::regclass, 'audit_events'::regclass)), 'request_log and audit_events have no foreign keys';
  -- the protections of the immutable tables are all present and enabled
  assert (select count(*) from pg_trigger where tgrelid = 'coin_transactions'::regclass and not tgisinternal and tgenabled = 'O'
            and tgname in ('coin_tx_no_update', 'coin_tx_no_truncate', 'coin_tx_balance_chain')) = 3, 'ledger triggers';
  assert (select count(*) from pg_trigger where tgrelid = 'audit_events'::regclass and not tgisinternal and tgenabled = 'O'
            and tgname in ('audit_no_update', 'audit_no_truncate')) = 2, 'audit triggers';
  assert (select count(*) from pg_trigger where tgrelid = 'coin_transactions'::regclass and not tgisinternal) = 3 and
         (select count(*) from pg_trigger where tgrelid = 'audit_events'::regclass and not tgisinternal) = 2, 'no trigger was added or removed';
  assert (select count(*) from pg_trigger where tgrelid = 'team_time_purchases'::regclass and not tgisinternal and tgenabled = 'O') = 1, 'the purchase guard is untouched';
  -- privileges: unchanged. service_role can read and insert history, never change or delete it
  assert has_table_privilege('service_role', 'public.coin_transactions', 'select') and has_table_privilege('service_role', 'public.coin_transactions', 'insert');
  assert not has_table_privilege('service_role', 'public.coin_transactions', 'update') and not has_table_privilege('service_role', 'public.coin_transactions', 'delete')
     and not has_table_privilege('service_role', 'public.coin_transactions', 'truncate');
  assert has_table_privilege('service_role', 'public.team_time_purchases', 'select') and has_table_privilege('service_role', 'public.team_time_purchases', 'insert');
  assert not has_table_privilege('service_role', 'public.team_time_purchases', 'update') and not has_table_privilege('service_role', 'public.team_time_purchases', 'delete')
     and not has_table_privilege('service_role', 'public.team_time_purchases', 'truncate');
  assert has_table_privilege('service_role', 'public.audit_events', 'select') and has_table_privilege('service_role', 'public.audit_events', 'insert')
     and not has_table_privilege('service_role', 'public.audit_events', 'update') and not has_table_privilege('service_role', 'public.audit_events', 'delete');
  assert not has_table_privilege('anon', 'public.coin_transactions', 'select') and not has_table_privilege('authenticated', 'public.team_time_purchases', 'select');
  assert (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in ('coin_transactions'::regclass, 'team_time_purchases'::regclass, 'audit_events'::regclass));
end $$;

-- ===== 2. the ledger exception is exactly as narrow as documented =====================================================
-- (run as the owner, the only role that holds DELETE on the ledger; every probe is rolled back by the exception handler)
create function pg_temp.probe(stmt text, expected text) returns void language plpgsql as $f$
begin
  begin
    execute stmt;
  exception when others then
    if position(expected in sqlerrm) > 0 then return; end if;
    raise exception 'probe [%] failed with % (wanted %)', stmt, sqlerrm, expected;
  end;
  raise exception 'probe [%] was NOT refused', stmt;
end $f$;
select pg_temp.probe($s$update coin_transactions set amount = amount where team_id = pg_temp.team_id(6)$s$, 'append-only');
select pg_temp.probe($s$delete from coin_transactions where team_id = pg_temp.team_id(6)$s$, 'append-only');          -- no marker
select pg_temp.probe($s$truncate coin_transactions cascade$s$, 'append-only');
select pg_temp.probe($s$update audit_events set payload = '{}' where team_id = pg_temp.team_id(1)$s$, 'append-only');
select pg_temp.probe($s$delete from audit_events where team_id = pg_temp.team_id(1)$s$, 'append-only');
select pg_temp.probe($s$truncate audit_events$s$, 'append-only');
do $$
declare ok boolean := false;
begin
  -- with the marker naming team 6, team 6's row may go, UPDATE is STILL refused, TRUNCATE is STILL refused, another team's row is STILL refused
  perform set_config('app.retiring_team_ids', pg_temp.team_id(6)::text, true);
  begin update coin_transactions set amount = amount where team_id = pg_temp.team_id(6); assert false, 'update must stay refused';
  exception when others then assert sqlerrm like '%append-only%', 'unexpected: ' || sqlerrm; end;
  begin truncate coin_transactions cascade; assert false, 'truncate must stay refused';
  exception when others then assert sqlerrm like '%append-only%', 'unexpected: ' || sqlerrm; end;
  begin delete from coin_transactions where team_id = pg_temp.team_id(5); assert false, 'another team''s row must stay refused';
  exception when others then assert sqlerrm like '%append-only%', 'unexpected: ' || sqlerrm; end;
  begin delete from audit_events where team_id = pg_temp.team_id(1); assert false, 'audit must stay refused';
  exception when others then assert sqlerrm like '%append-only%', 'unexpected: ' || sqlerrm; end;
  -- a marker listing several teams allows exactly those teams
  begin
    perform set_config('app.retiring_team_ids', pg_temp.team_id(5)::text || ',' || pg_temp.team_id(6)::text, true);
    delete from coin_transactions where team_id = pg_temp.team_id(6);
    assert found, 'the named team''s row can go';
    delete from coin_transactions where team_id = pg_temp.team_id(4);   -- not named
    assert false, 'a team that is not named must stay refused';
  exception when others then
    if sqlerrm like '%append-only%' then ok := true; else raise; end if;
  end;
  assert ok;
  -- undo everything this block did (the one allowed delete was already rolled back by its own handler)
  raise exception 'ROLLBACK_PROBE';
exception when others then
  if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
end $$;
do $$
begin
  assert coalesce(current_setting('app.retiring_team_ids', true), '') = '', 'the marker did not leak out of the probe';
  assert (select count(*) from coin_transactions where team_id = pg_temp.team_id(6)) = 1, 'the probe deleted nothing (rolled back)';
end $$;
-- service_role can set the marker (any session can) and still cannot delete: it holds no DELETE privilege on the ledger
do $$
begin
  set local role service_role;
  perform set_config('app.retiring_team_ids', pg_temp.team_id(6)::text, true);
  begin delete from coin_transactions where team_id = pg_temp.team_id(6); assert false, 'service_role must not delete';
  exception when insufficient_privilege then null; end;
  begin update coin_transactions set amount = amount; assert false, 'service_role must not update';
  exception when insufficient_privilege then null; end;
  begin truncate coin_transactions; assert false, 'service_role must not truncate';
  exception when insufficient_privilege then null; end;
  begin delete from team_time_purchases; assert false, 'service_role must not delete purchases';
  exception when insufficient_privilege then null; end;
  begin update team_time_purchases set cost_paid = 0; assert false, 'service_role must not update purchases';
  exception when insufficient_privilege then null; end;
  begin truncate team_time_purchases; assert false, 'service_role must not truncate purchases';
  exception when insufficient_privilege then null; end;
  reset role;
  perform set_config('app.retiring_team_ids', '', true);
end $$;
-- nobody can delete a team row directly while it has ledger rows (RESTRICT is still the first line of defence)
select pg_temp.rejects($s$delete from teams where id = pg_temp.team_id(6)$s$, '23001');

-- ===== 3. every foreign key into the account tables is handled (a future table fails here, not in production) =========
do $$
declare r record; known text[] := array['answer_drafts', 'hint_purchases', 'sessions', 'submissions', 'team_members', 'team_questions', 'team_themes',
                                       'ufm_challenges', 'teams', 'staff_users', 'coin_transactions', 'team_time_purchases'];
begin
  for r in select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent, c.conname
             from pg_constraint c
            where c.contype = 'f' and c.confrelid in ('teams'::regclass, 'team_members'::regclass, 'staff_users'::regclass, 'submissions'::regclass) loop
    assert r.child = any(known), format('%s (%s -> %s) is not handled by delete_teams/delete_admins; extend app.erase_teams and this list', r.child, r.conname, r.parent);
  end loop;
end $$;

-- ===== 4. authorisation ===============================================================================================
select pg_temp.rejects($s$select public.list_deletable_admins(pg_temp.staff(2))$s$, 'FORBIDDEN');        -- an ADMIN
select pg_temp.rejects($s$select public.list_deletable_teams(pg_temp.staff(2))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.list_deletable_admins(pg_temp.member_id(1, 1))$s$, 'FORBIDDEN');  -- a participant's id
select pg_temp.rejects($s$select public.list_deletable_teams(pg_temp.team_id(1))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.list_deletable_admins(gen_random_uuid())$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.list_deletable_admins(null)$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.delete_admins(pg_temp.staff(2), array[pg_temp.staff(3)], pg_temp.key(900))$s$, 'FORBIDDEN');  -- an admin deleting an admin
select pg_temp.rejects($s$select public.delete_admins(pg_temp.staff(2), array[pg_temp.staff(2)], pg_temp.key(900))$s$, 'FORBIDDEN');  -- ... itself
select pg_temp.rejects($s$select public.delete_teams(pg_temp.staff(2), array[pg_temp.team_id(1)], pg_temp.key(900))$s$, 'FORBIDDEN');  -- an admin deleting its OWN team
select pg_temp.rejects($s$select public.delete_teams(pg_temp.staff(3), array[pg_temp.team_id(1)], pg_temp.key(900))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.delete_teams(pg_temp.member_id(1, 1), array[pg_temp.team_id(1)], pg_temp.key(900))$s$, 'FORBIDDEN');   -- a participant
select pg_temp.rejects($s$select public.delete_teams(pg_temp.team_id(1), array[pg_temp.team_id(1)], pg_temp.key(900))$s$, 'FORBIDDEN');       -- a team id as "staff"
select pg_temp.rejects($s$select public.delete_teams(null, array[pg_temp.team_id(1)], pg_temp.key(900))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.delete_teams(gen_random_uuid(), array[pg_temp.team_id(1)], pg_temp.key(900))$s$, 'FORBIDDEN');
-- a deactivated Super Admin is not "active"
update staff_users set is_active = false where id = pg_temp.staff(1);
select pg_temp.rejects($s$select public.list_deletable_teams(pg_temp.staff(1))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select pg_temp.del_teams(array[pg_temp.team_id(4)], 901)$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select pg_temp.del_admins(array[pg_temp.staff(4)], 901)$s$, 'FORBIDDEN');
update staff_users set is_active = true where id = pg_temp.staff(1);
-- the browser roles cannot execute any of it
do $$
declare f text;
begin
  foreach f in array array['public.list_deletable_admins(uuid)', 'public.list_deletable_teams(uuid)', 'public.delete_teams(uuid, uuid[], uuid)',
                           'public.delete_admins(uuid, uuid[], uuid)', 'app.erase_teams(uuid[], uuid, timestamptz, uuid)', 'app.deletion_selection(uuid[], text)'] loop
    assert not has_function_privilege('anon', f, 'execute') and not has_function_privilege('authenticated', f, 'execute'), 'browser role may execute ' || f;
    if f like 'app.erase_teams%' then
      -- no authorisation of its own and it may delete ledger rows: only the owner-run delete_* functions may call it
      assert not has_function_privilege('service_role', f, 'execute'), 'service_role must NOT execute ' || f;
    else
      assert has_function_privilege('service_role', f, 'execute'), 'service_role must execute ' || f;
    end if;
  end loop;
  assert not has_function_privilege('public', 'public.delete_teams(uuid, uuid[], uuid)', 'execute');
end $$;

-- ===== 5. the listings ================================================================================================
do $$
declare a jsonb := public.list_deletable_admins(pg_temp.staff(1)); t jsonb := public.list_deletable_teams(pg_temp.staff(1));
begin
  assert jsonb_array_length(a->'admins') = 7, 'seven ADMINs (a2..a6 + doomed + kept), never the Super Admin: ' || a::text;
  assert not exists (select 1 from jsonb_array_elements(a->'admins') e where e->>'username' = 'test_super');
  assert (select (e->>'team_count')::int from jsonb_array_elements(a->'admins') e where e->>'username' = 'test_admin1') = 3;   -- teams 1, 3, N1
  assert (select (e->>'team_count')::int from jsonb_array_elements(a->'admins') e where e->>'username' = 'test_admin3') = 0;
  assert jsonb_array_length(t->'teams') = 8, 'teams of EVERY admin';
  assert (select e->>'admin_username' from jsonb_array_elements(t->'teams') e where e->>'team_code' = 'T02') = 'test_admin2';
  assert not (a::text ~* 'hash|password|token' or t::text ~* 'hash|password|token'), 'no secret in a listing';
end $$;


-- ===== 6. strict selections: nothing changes ==========================================================================
create temp table before_all as select pg_temp.world_fp() as world;
select pg_temp.rejects($s$select pg_temp.del_teams(null, 902)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select pg_temp.del_teams('{}'::uuid[], 902)$s$, 'VALIDATION_FAILED');                                    -- empty
select pg_temp.rejects($s$select pg_temp.del_teams(array[pg_temp.team_id(4), pg_temp.team_id(4)], 902)$s$, 'VALIDATION_FAILED');  -- duplicate
select pg_temp.rejects($s$select pg_temp.del_teams(array[pg_temp.team_id(4), null]::uuid[], 902)$s$, 'VALIDATION_FAILED');         -- null element
select pg_temp.rejects($s$select pg_temp.del_teams(array(select gen_random_uuid() from generate_series(1, 101)), 902)$s$, 'VALIDATION_FAILED');  -- 101
select pg_temp.rejects($s$select pg_temp.del_admins(null, 902)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select pg_temp.del_admins('{}'::uuid[], 902)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select pg_temp.del_admins(array[pg_temp.staff(4), pg_temp.staff(4)], 902)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.delete_teams(pg_temp.staff(1), array[pg_temp.team_id(4)], null)$s$, 'VALIDATION_FAILED');          -- no key
select pg_temp.rejects($s$select public.delete_admins(pg_temp.staff(1), array[pg_temp.staff(4)], null)$s$, 'VALIDATION_FAILED');
-- unknown ids: NOT_FOUND, and a known id in the same request is NOT deleted
select pg_temp.rejects($s$select pg_temp.del_teams(array[pg_temp.team_id(4), gen_random_uuid()], 903)$s$, 'NOT_FOUND');
select pg_temp.rejects($s$select pg_temp.del_teams(array[pg_temp.staff(4)], 903)$s$, 'NOT_FOUND');                         -- a staff id is not a team
select pg_temp.rejects($s$select pg_temp.del_admins(array[pg_temp.staff(4), gen_random_uuid()], 903)$s$, 'NOT_FOUND');
select pg_temp.rejects($s$select pg_temp.del_admins(array[pg_temp.team_id(4)], 903)$s$, 'NOT_FOUND');                      -- a team id is not an admin
-- the SUPER_ADMIN is protected, alone or with others; nothing else in the request is deleted either
select pg_temp.rejects($s$select pg_temp.del_admins(array[pg_temp.staff(1)], 904)$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select pg_temp.del_admins(array[pg_temp.staff(4), pg_temp.staff(1)], 904)$s$, 'FORBIDDEN');
do $$
begin
  assert (select pg_temp.world_fp()) = (select world from before_all), 'every refused request changed nothing in any table (ledger, request_log, audit included)';
  assert exists (select 1 from staff_users where role = 'SUPER_ADMIN' and id = pg_temp.staff(1));
end $$;

-- ===== 7. delete ONE team with real data: everything of it goes, nothing of anyone else =============================
-- team 1: a started, playing team with a theme, drafts, a hint, bought time, an approved reward, sessions and request_log rows
create temp table log1 as select * from request_log;
create temp table lb0 as select team_code, score, minutes, rank_no from app.leaderboard_rows(app.now());
create temp table pre7 as select
  pg_temp.ledger_team_fp(pg_temp.team_id(1)) as l1, pg_temp.ledger_team_fp(pg_temp.team_id(2)) as l2, pg_temp.ledger_team_fp(pg_temp.team_id(3)) as l3,
  pg_temp.ledger_team_fp(pg_temp.team_id(4)) as l4, pg_temp.ledger_team_fp(pg_temp.team_id(6)) as l6,
  pg_temp.team_fp(pg_temp.team_id(2)) as t2, pg_temp.team_fp(pg_temp.team_id(3)) as t3, pg_temp.team_fp(pg_temp.team_id(4)) as t4, pg_temp.team_fp(pg_temp.team_id(6)) as t6,
  pg_temp.ttp_fp(pg_temp.team_id(2)) as ttp2, pg_temp.ttp_fp(pg_temp.team_id(3)) as ttp3,
  (select coins from teams where id = pg_temp.team_id(2)) as c2, (select coins from teams where id = pg_temp.team_id(3)) as c3,
  (select count(*) from coin_transactions) as ledger_n, (select count(*) from coin_transactions where team_id = pg_temp.team_id(1)) as ledger_1,
  (select count(*) from team_time_purchases) as ttp_n, (select count(*) from team_time_purchases where team_id = pg_temp.team_id(1)) as ttp_1,
  (select max(id) from audit_events) as audit_max, (select md5(string_agg(a::text, ',' order by a.id)) from audit_events a) as audit_fp,
  (select count(*) from audit_events where team_id = pg_temp.team_id(1)) as audit_1,
  (select count(*) from sessions) as sessions, (select count(*) from ufm_challenges) as chal;
do $$ begin
  assert (select ledger_1 from pre7) = 5 and (select ttp_1 from pre7) = 1, 'the fixture really gave team 1 five ledger rows and a purchase';
  assert (select l1 from pre7) <> '-/0';
end $$;
create temp table res7 as select pg_temp.del_teams(array[pg_temp.team_id(1)], 910) as j;
do $$
declare j jsonb := (select j from res7); t uuid := pg_temp.team_id(1);
begin
  assert (j->>'replayed')::boolean = false and (j->'deleted'->>'teams')::int = 1 and j->'team_ids' = to_jsonb(array[t]), 'response: ' || j::text;
  assert not (j::text ~* 'hash|password|token|session'), 'the response carries nothing but ids and counts';
  -- ---- everything team 1 owned is gone (every table that can name a team)
  assert pg_temp.team_rows(t) = 0, 'no operational row of team 1 remains: ' || pg_temp.team_rows(t);
  assert not exists (select 1 from coin_transactions where team_id = t), 'its WHOLE ledger is gone';
  assert not exists (select 1 from team_time_purchases where team_id = t), 'its purchase history is gone';
  assert not exists (select 1 from submissions where team_id = t) and not exists (select 1 from answer_drafts where team_id = t)
     and not exists (select 1 from hint_purchases where team_id = t) and not exists (select 1 from team_questions where team_id = t)
     and not exists (select 1 from team_themes where team_id = t) and not exists (select 1 from ufm_challenges where team_id = t);
  assert not exists (select 1 from teams where login_id = 'test_team_01' or team_code = 'T01');
  assert not exists (select 1 from team_members where admission_no like 'TEST1_');
  assert not exists (select 1 from sessions where team_id = t) and not exists (select 1 from sessions where member_id in (pg_temp.member_id(1, 1), pg_temp.member_id(1, 2)));
  assert not exists (select 1 from auth_throttle where key = 'team:test_team_01') and exists (select 1 from auth_throttle where key = 'team:test_team_02'),
         'only the removed login key is cleared';
  assert (select count(*) from coin_transactions) = (select ledger_n - ledger_1 from pre7) and (select count(*) from team_time_purchases) = (select ttp_n - ttp_1 from pre7),
         'exactly the team''s ledger and purchase rows left the tables, no others';
  -- ---- other accounts and their money are bit-for-bit unchanged
  assert pg_temp.team_fp(pg_temp.team_id(2)) = (select t2 from pre7) and pg_temp.team_fp(pg_temp.team_id(3)) = (select t3 from pre7)
     and pg_temp.team_fp(pg_temp.team_id(4)) = (select t4 from pre7) and pg_temp.team_fp(pg_temp.team_id(6)) = (select t6 from pre7), 'unselected teams unchanged';
  assert pg_temp.ledger_team_fp(pg_temp.team_id(2)) = (select l2 from pre7) and pg_temp.ledger_team_fp(pg_temp.team_id(3)) = (select l3 from pre7)
     and pg_temp.ledger_team_fp(pg_temp.team_id(4)) = (select l4 from pre7) and pg_temp.ledger_team_fp(pg_temp.team_id(6)) = (select l6 from pre7), 'other teams'' ledgers unchanged';
  assert pg_temp.ttp_fp(pg_temp.team_id(2)) = (select ttp2 from pre7) and pg_temp.ttp_fp(pg_temp.team_id(3)) = (select ttp3 from pre7), 'other teams'' purchases unchanged';
  assert (select coins from teams where id = pg_temp.team_id(2)) = (select c2 from pre7) and (select coins from teams where id = pg_temp.team_id(3)) = (select c3 from pre7), 'balances unchanged';
  assert (select count(*) from sessions) = (select sessions from pre7) - 2 and (select count(*) from ufm_challenges) = (select chal from pre7) - 1;
  assert exists (select 1 from staff_users where id = pg_temp.staff(2)), 'its admin is not deleted by deleting a team';
  -- ---- invariants and the leaderboard of the survivors
  assert not exists (select 1 from app.invariant_coin_balance_mismatch) and not exists (select 1 from app.invariant_team_member_count), 'every survivor''s balance equals its ledger tail';
  assert not exists (select 1 from jsonb_array_elements(public.list_deletable_teams(pg_temp.staff(1))->'teams') e where e->>'team_code' = 'T01');
  assert not exists (select 1 from app.leaderboard_rows(app.now()) where team_code = 'T01');
  assert (select count(*) from app.leaderboard_rows(app.now()) l join lb0 b using (team_code) where l.score = b.score and l.minutes = b.minutes) = (select count(*) from lb0) - 1,
         'every surviving team keeps its score and minutes';
  assert (select array_agg(team_code order by rank_no, team_code) from app.leaderboard_rows(app.now()))
       = (select array_agg(team_code order by rank_no, team_code) from lb0 where team_code <> 'T01'), 'the survivors keep their relative order';
  -- ---- the audit trail only grew; rows that existed are byte-identical; what was added is the deletion record
  assert (select md5(string_agg(a::text, ',' order by a.id)) from audit_events a where a.id <= (select audit_max from pre7)) = (select audit_fp from pre7), 'old audit rows untouched';
  assert (select count(*) from audit_events where team_id = t) = (select audit_1 from pre7) + 1, 'one new audit row for team 1 (TEAM_DELETED); its old rows stay';
  assert (select count(*) from audit_events where event_type = 'TEAM_DELETED' and team_id = t and staff_id = pg_temp.staff(1)) = 1;
  assert (select count(*) from audit_events where event_type = 'TEAMS_DELETED' and (payload->'team_ids') = to_jsonb(array[t])) = 1;
  assert position('NOT-A-HASH' in (select string_agg(payload::text, ' ') from audit_events where event_type like '%DELETED')) = 0, 'no hash in the audit payloads';
  -- the removed counts the audit summary reports are the real ones
  assert (select (payload->'removed'->>'coin_transactions')::int from audit_events where event_type = 'TEAMS_DELETED' and (payload->'team_ids') = to_jsonb(array[t])) = (select ledger_1 from pre7);
  assert (select (payload->'removed'->>'time_purchases')::int from audit_events where event_type = 'TEAMS_DELETED' and (payload->'team_ids') = to_jsonb(array[t])) = (select ttp_1 from pre7);
end $$;
-- the marker is closed again after the statement that needed it
do $$ begin assert coalesce(current_setting('app.retiring_team_ids', true), '') = '', 'no marker left behind'; end $$;

-- ===== 7b. request_log after deleting team 1 (direct team deletion; its admin a2 SURVIVES) ===========================
--   key  2,10,13,16,18,20  team 1's own scope: start_team_competition, unlock_theme, start_question, buy_hint, buy_time, submit_answer
--   key  23                a2's approve_submission reply for team 1's submission (a staff-scope record about the team)
-- nothing else: not team 2/3/6 scopes, not a2's other replies (60, 65, 66, 67), not the Super Admin's, not team 6 / a6 / a5 rows
do $$
begin
  assert pg_temp.log_gone('log1') = array[2, 10, 13, 16, 18, 20, 23], 'removed request_log keys: ' || pg_temp.log_gone('log1')::text;
  assert pg_temp.log_new('log1') = array[910], 'the only new record is the Super Admin''s own delete_teams reply: ' || pg_temp.log_new('log1')::text;
  assert pg_temp.log_changed('log1') = 0, 'every surviving record is byte-identical';
  assert (select count(*) from request_log where team_id = pg_temp.team_id(1)) = 0;
  assert (select count(*) from request_log where team_id = pg_temp.staff(2)) = 4, 'a2 keeps 60, 65, 66, 67';
  assert exists (select 1 from request_log where team_id = pg_temp.staff(1) and operation = 'delete_teams' and pg_temp.knum(idem_key) = 910), 'the deletion''s own idempotency record is stored';
end $$;

-- ===== 8. the old sessions of the deleted team stop authorising ======================================================
do $$
declare r jsonb := public.resolve_session(pg_temp.tok(11));
begin
  assert (r->>'ok')::boolean = false and r->>'code' = 'UNAUTHENTICATED', 'team 1 member cookie: ' || r::text;
  assert (public.resolve_session(pg_temp.tok(12))->>'ok')::boolean = false;
  assert (public.resolve_session(pg_temp.tok(21))->>'ok')::boolean, 'team 2 member cookie still works (unselected)';
  assert (public.resolve_session(pg_temp.tok(102))->>'ok')::boolean, 'admin a2 cookie still works (deleting its team does not delete it)';
end $$;
do $$
declare ghost uuid := gen_random_uuid(); ghost2 uuid := gen_random_uuid();
begin
  -- simulate corruption that the foreign keys make impossible: sessions whose principal row has vanished
  set local session_replication_role = replica;
  insert into sessions (token_hash, kind, staff_id, expires_at) values (pg_temp.tok(901), 'STAFF', ghost, app.now() + interval '1 hour');
  insert into sessions (token_hash, kind, team_id, member_id, expires_at) values (pg_temp.tok(902), 'MEMBER', ghost, ghost, app.now() + interval '1 hour');
  insert into sessions (token_hash, kind, team_id, member_id, expires_at) values (pg_temp.tok(903), 'MEMBER', pg_temp.team_id(2), ghost2, app.now() + interval '1 hour');
  set local session_replication_role = origin;
  assert (public.resolve_session(pg_temp.tok(901))->>'ok')::boolean = false, 'dangling STAFF session';
  assert (public.resolve_session(pg_temp.tok(902))->>'ok')::boolean = false, 'dangling MEMBER session (team and member gone)';
  assert (public.resolve_session(pg_temp.tok(903))->>'ok')::boolean = false, 'dangling MEMBER session (member gone)';
  set local session_replication_role = replica;
  delete from sessions where token_hash in (pg_temp.tok(901), pg_temp.tok(902), pg_temp.tok(903));
  set local session_replication_role = origin;
end $$;

-- ===== 9. login IDs, team codes, admission numbers and usernames are reusable; active ones stay unique ==============
create temp table reuse1 as select public.create_team(pg_temp.staff(2), 'T01', 'Reborn Team', 'test_team_01', 'reborn-pass-1',
  array['TEST11', 'TEST12', 'TEST13', 'TEST14'], pg_temp.key(920)) as j;
do $$
declare nid uuid := (select (r.j->'team'->>'id')::uuid from reuse1 r);
begin
  assert nid <> pg_temp.team_id(1), 'the new team is a different row';
  assert (select login_id from teams where id = nid) = 'test_team_01' and (select count(*) from team_members where team_id = nid) = 4;
  assert (select count(*) from coin_transactions where team_id = nid) = 1 and (select balance_after from coin_transactions where team_id = nid) = 500, 'a fresh ledger of its own';
  assert (select count(*) from coin_transactions where team_id = pg_temp.team_id(1)) = 0, 'the old team''s ledger is still gone';
  assert (select count(*) from team_time_purchases where team_id = nid) = 0, 'the reborn team owns none of the old purchases';
end $$;
select pg_temp.rejects($s$select public.create_team(pg_temp.staff(2), 'T99', 'Dup', 'TEST_team_01', 'reborn-pass-1', array['Z1', 'Z2', 'Z3', 'Z4'], pg_temp.key(921))$s$, 'LOGIN_ID_TAKEN');
select pg_temp.rejects($s$select public.create_team(pg_temp.staff(2), 'T01', 'Dup', 'another_login', 'reborn-pass-1', array['Z1', 'Z2', 'Z3', 'Z4'], pg_temp.key(922))$s$, 'TEAM_CODE_TAKEN');
select pg_temp.rejects($s$select public.create_team(pg_temp.staff(2), 'T98', 'Dup', 'another_login', 'reborn-pass-1', array['TEST11', 'Z2', 'Z3', 'Z4'], pg_temp.key(923))$s$, 'ADMISSION_NO_TAKEN');
-- a deleted team's id can be reused only by a brand-new row (it is just a UUID again)... and the old ledger does not reappear
do $$ begin assert not exists (select 1 from coin_transactions where team_id = pg_temp.team_id(1)); end $$;

-- ===== 10. idempotency ================================================================================================
create temp table pre10 as select pg_temp.world_fp() as world;
do $$
declare r jsonb;
begin
  -- the same key + the same selection replays the stored answer and does nothing
  r := pg_temp.del_teams(array[pg_temp.team_id(1)], 910);
  assert (r->>'replayed')::boolean = true and (r->'deleted'->>'teams')::int = 1, 'replay: ' || r::text;
  assert (select pg_temp.world_fp()) = (select world from pre10), 'a replay changes nothing in any table (no audit row, no ledger, no log)';
end $$;
-- Malformed selections must fail validation even when their normalized
-- fingerprint would match a previously successful request.
select pg_temp.rejects(
  $s$select pg_temp.del_teams(array[pg_temp.team_id(1), null]::uuid[], 910)$s$,
  'VALIDATION_FAILED'
);
select pg_temp.rejects(
  $s$select pg_temp.del_teams(array[pg_temp.team_id(1), pg_temp.team_id(1)], 910)$s$,
  'VALIDATION_FAILED'
);
select pg_temp.rejects($s$select pg_temp.del_teams(array[pg_temp.team_id(2)], 910)$s$, 'IDEMPOTENCY_KEY_REUSED');    -- same key, other selection
select pg_temp.rejects($s$select pg_temp.del_admins(array[pg_temp.staff(4)], 910)$s$, 'IDEMPOTENCY_KEY_REUSED');    -- same key, other operation
-- a NEW key for ids that are already gone is an honest NOT_FOUND, never a fake success
select pg_temp.rejects($s$select pg_temp.del_teams(array[pg_temp.team_id(1)], 911)$s$, 'NOT_FOUND');
-- the deletion's own record survives later deletions (a retry of an old request after more deletions still replays)


-- ===== 11. bulk team deletion across admins (teams of a2, a3, a5 in one request) ====================================
--   team 2 (a3): started, bought hint+time, its submission was approved by the SUPER ADMIN (key 64)
--   team 3 (a2): started, its submission disapproved (65) and then PENALISED (66) by its owner a2
--   teams 4, 5: grant-only
create temp table log2 as select * from request_log;
create temp table pre11 as select
  pg_temp.ledger_team_fp(pg_temp.team_id(6)) as l6,
  pg_temp.team_fp(pg_temp.team_id(6)) as t6, (select coins from teams where id = pg_temp.team_id(6)) as c6,
  (select count(*) from coin_transactions where team_id in (pg_temp.team_id(2), pg_temp.team_id(3), pg_temp.team_id(4), pg_temp.team_id(5))) as ledger_sel,
  (select count(*) from coin_transactions) as ledger_n, (select count(*) from team_time_purchases) as ttp_n,
  (select count(*) from team_time_purchases where team_id in (pg_temp.team_id(2), pg_temp.team_id(3))) as ttp_sel,
  (select max(id) from audit_events) as audit_max, (select md5(string_agg(a::text, ',' order by a.id)) from audit_events a) as audit_fp,
  (select count(*) from audit_events where team_id in (pg_temp.team_id(2), pg_temp.team_id(3))) as audit_sel,
  pg_temp.ledger_team_fp((select (r.j->'team'->>'id')::uuid from reuse1 r)) as lre, pg_temp.team_fp((select (r.j->'team'->>'id')::uuid from reuse1 r)) as tre;
do $$
declare j jsonb := pg_temp.del_teams(array[pg_temp.team_id(2), pg_temp.team_id(3), pg_temp.team_id(4), pg_temp.team_id(5)], 930);
begin
  assert (j->'deleted'->>'teams')::int = 4;
  assert pg_temp.team_rows(pg_temp.team_id(2)) = 0 and pg_temp.team_rows(pg_temp.team_id(3)) = 0 and pg_temp.team_rows(pg_temp.team_id(4)) = 0 and pg_temp.team_rows(pg_temp.team_id(5)) = 0;
  assert not exists (select 1 from coin_transactions where team_id in (pg_temp.team_id(2), pg_temp.team_id(3), pg_temp.team_id(4), pg_temp.team_id(5))), 'their ledgers are gone';
  assert not exists (select 1 from team_time_purchases where team_id in (pg_temp.team_id(2), pg_temp.team_id(3))), 'their purchases are gone';
  assert (select count(*) from coin_transactions) = (select ledger_n - ledger_sel from pre11) and (select count(*) from team_time_purchases) = (select ttp_n - ttp_sel from pre11);
  assert pg_temp.team_fp(pg_temp.team_id(6)) = (select t6 from pre11) and pg_temp.ledger_team_fp(pg_temp.team_id(6)) = (select l6 from pre11)
     and (select coins from teams where id = pg_temp.team_id(6)) = (select c6 from pre11), 'team 6 (a6) unchanged: data, ledger, balance';
  assert pg_temp.team_fp((select (r.j->'team'->>'id')::uuid from reuse1 r)) = (select tre from pre11) and pg_temp.ledger_team_fp((select (r.j->'team'->>'id')::uuid from reuse1 r)) = (select lre from pre11),
         'the re-created T01 (a2) is unchanged';
  assert exists (select 1 from staff_users where id in (pg_temp.staff(2), pg_temp.staff(3), pg_temp.staff(5))), 'their admins are untouched';
  assert not (public.resolve_session(pg_temp.tok(21))->>'ok')::boolean and not (public.resolve_session(pg_temp.tok(31))->>'ok')::boolean, 'team 2 and 3 cookies are dead';
  assert (public.resolve_session(pg_temp.tok(102))->>'ok')::boolean and (public.resolve_session(pg_temp.tok(103))->>'ok')::boolean, 'admin cookies alive (only teams went)';
  assert not exists (select 1 from app.invariant_coin_balance_mismatch) and not exists (select 1 from app.invariant_team_member_count);
  assert (select md5(string_agg(a::text, ',' order by a.id)) from audit_events a where a.id <= (select audit_max from pre11)) = (select audit_fp from pre11), 'old audit rows untouched';
  assert (select count(*) from audit_events where event_type = 'TEAM_DELETED' and staff_id = pg_temp.staff(1)) = 5, 'one TEAM_DELETED per team: 1 + 4';
  assert (select count(*) from audit_events where team_id in (pg_temp.team_id(2), pg_temp.team_id(3))) = (select audit_sel from pre11) + 2, 'the old audit rows stay; the deletions add one each';
  assert (select (payload->'removed'->>'coin_transactions')::int from audit_events where event_type = 'TEAMS_DELETED' and request_id = pg_temp.key(930)) = (select ledger_sel from pre11);
end $$;
-- request_log: team 2's scope (3, 11, 14, 17, 19, 21) + the Super Admin's approval of ITS submission (64); team 3's scope (4, 12, 15, 22, 24)
-- + a2's disapproval (65) and penalty (66) of ITS team. Teams 4 and 5 had none. A SECOND scope, not the team's, holds 64/65/66.
do $$
begin
  assert pg_temp.log_gone('log2') = array[3, 4, 11, 12, 14, 15, 17, 19, 21, 22, 24, 64, 65, 66], 'removed request_log keys: ' || pg_temp.log_gone('log2')::text;
  assert pg_temp.log_new('log2') = array[930] and pg_temp.log_changed('log2') = 0;
  assert not exists (select 1 from request_log where operation = 'approve_submission' and team_id = pg_temp.staff(1) and pg_temp.knum(idem_key) = 64), 'the Super Admin''s reply about team 2''s submission is gone';
  -- unrelated records, explicitly: team 6 / a6 / a5 / the Super Admin / the other admins' create replies
  assert (select count(*) from request_log where pg_temp.knum(idem_key) in (1, 60, 61, 62, 63, 67, 70, 71, 72, 73, 74, 75, 910, 920)) = 14, 'all the records that must survive survive';
end $$;

-- ===== 11b. a team's create_team reply is removed with the team even though its admin survives; a replay then creates anew ====
create temp table log2b as select * from request_log;
create temp table n1 as select (e->>'id')::uuid as id from jsonb_array_elements(public.list_deletable_teams(pg_temp.staff(1))->'teams') e where e->>'team_code' = 'N1';
do $$
declare old_id uuid := (select id from n1); j jsonb; r jsonb;
begin
  assert (select count(*) from coin_transactions where team_id = old_id) = 1;
  j := pg_temp.del_teams(array[old_id], 935);
  assert pg_temp.log_gone('log2b') = array[60], 'only the create_team reply for N1: ' || pg_temp.log_gone('log2b')::text;
  assert pg_temp.log_new('log2b') = array[935] and pg_temp.log_changed('log2b') = 0;
  assert not exists (select 1 from coin_transactions where team_id = old_id);
  -- the very same create_team request, retried with the same key, is NOT answered with the stored reply about a deleted team: it runs
  r := public.create_team(pg_temp.staff(2), 'N1', 'New Team 1', 'new_team_1', 'new-team-pass-1', array['NA1', 'NA2', 'NA3', 'NA4'], pg_temp.key(60));
  assert (r->>'replayed')::boolean = false and (r->'team'->>'id')::uuid <> old_id, 'a fresh team, not a replay of the deleted one: ' || r::text;
  assert (select count(*) from coin_transactions where team_id = (r->'team'->>'id')::uuid) = 1;
end $$;

-- ===== 12. atomicity: an induced failure at the LAST statement rolls EVERYTHING back (ledger and request_log deletions too) ==
-- (a) admin a2 owns two teams (the reborn T01 and the new N1) AND created a team that belongs to another admin
--     (teams.created_by -> staff_users, RESTRICT): deleting a2 fails at the very last statement, after its teams' ledgers,
--     purchases and request_log records were already removed inside the transaction. D's create_admin reply (62) is removed first too.
insert into teams (id, team_code, name, login_id, password_hash, admin_id, created_by, coins)
values (pg_temp.team_id(7), 'T07', 'Test Team 7', 'test_team_07', 'TEST-NOT-A-HASH', pg_temp.staff(6), pg_temp.staff(2), 500);
insert into team_members (id, team_id, slot, admission_no)
select pg_temp.member_id(7, s), pg_temp.team_id(7), s, 'TEST7' || s from generate_series(1, 4) s;
insert into coin_transactions (team_id, type, amount, balance_after, created_at) values (pg_temp.team_id(7), 'INITIAL_GRANT', 500, 500, now());
create temp table pre12 as select pg_temp.world_fp() as world;
do $$ begin assert (select count(*) from request_log where team_id = pg_temp.staff(2)) >= 3, 'a2 has request_log records that the failed deletion must give back'; end $$;
select pg_temp.rejects($s$select pg_temp.del_admins(array[pg_temp.staff(2), (select (doomed->'admin'->>'id')::uuid from made_admins)], 940)$s$, 'DELETE_BLOCKED');
do $$
begin
  assert (select pg_temp.world_fp()) = (select world from pre12), 'EVERY table is exactly as before: teams, ledger, purchases, request_log, sessions, audit';
  assert coalesce(current_setting('app.retiring_team_ids', true), '') = '', 'the marker is gone';
  assert (public.resolve_session(pg_temp.tok(102))->>'ok')::boolean, 'a2''s cookie still works after the failed deletion';
  assert exists (select 1 from request_log where pg_temp.knum(idem_key) = 62), 'D''s create_admin reply came back';
  assert not exists (select 1 from request_log where pg_temp.knum(idem_key) = 940), 'a failed request stores nothing: its key stays reusable';
end $$;
-- (b) a ledger row of ANOTHER team names admin a4 (an adjustment made by a4): the ledger is immutable, so a4 cannot be deleted
--     while that row exists, and nothing is removed - a deleted account's money history is never silently orphaned
insert into coin_transactions (team_id, type, amount, balance_after, staff_id, created_at) values (pg_temp.team_id(6), 'ADMIN_ADJUSTMENT', 10, 510, pg_temp.staff(4), now());
update teams set coins = 510 where id = pg_temp.team_id(6);
create temp table pre12b as select pg_temp.world_fp() as world;
select pg_temp.rejects($s$select pg_temp.del_admins(array[pg_temp.staff(4), (select (doomed->'admin'->>'id')::uuid from made_admins)], 941)$s$, 'DELETE_BLOCKED');
do $$
begin
  assert (select pg_temp.world_fp()) = (select world from pre12b), 'rolled back whole (b)';
  assert exists (select 1 from staff_users where id = pg_temp.staff(4)) and exists (select 1 from request_log where pg_temp.knum(idem_key) = 62);
  assert not exists (select 1 from app.invariant_coin_balance_mismatch);
end $$;
-- (c) NOT_FOUND is not DELETE_BLOCKED: a selection that mixes a real team with an unknown id deletes nothing (the genuine
--     delete_teams DELETE_BLOCKED + rollback tests are in section 12b)
select pg_temp.rejects($s$select pg_temp.del_teams(array[pg_temp.team_id(6), gen_random_uuid()], 942)$s$, 'NOT_FOUND');
do $$ begin assert (select pg_temp.world_fp()) = (select world from pre12b), 'a selection with one unknown id deletes nothing'; end $$;
-- with the blocker gone the very same selection succeeds (a failed request is not remembered)
update teams set created_by = pg_temp.staff(6) where id = pg_temp.team_id(7);

-- ===== 12b. DELETE_BLOCKED, precisely: every reference kind, both sides vs one side, unknown tables, diagnostics ======================
-- Each scenario plants ONE out-of-band reference (as the table owner - the application cannot create any of them, which is the
-- point of the audit), runs the real function, records the outcome, and then UNDOES everything in a sub-transaction. So these
-- scenarios leave the world exactly as sections 13+ expect it (proved by the world fingerprint at the end of this section).
-- Diagnostics: a blocked deletion carries the NAME of the constraint and of the referencing table in the error DETAIL (the API
-- logs it on the server and never forwards it); nothing else - no id, no key, no row value.
create function pg_temp.scenario(p_plant text, p_call text, p_probe text default $q$select '-'$q$, p_check text default $q$select null::jsonb$q$)
returns jsonb language plpgsql as $f$
declare f0 text; f1 text; pr0 text; pr1 text; o text := 'OK'; st text; d text; chk jsonb; res jsonb;
begin
  begin
    execute p_plant;
    f0 := pg_temp.world_fp();
    execute p_probe into pr0;
    begin
      execute p_call;
    exception when others then
      get stacked diagnostics st = returned_sqlstate, d = pg_exception_detail;
      o := sqlerrm;
    end;
    f1 := pg_temp.world_fp();
    execute p_probe into pr1;
    execute p_check into chk;
    res := jsonb_build_object('outcome', o, 'sqlstate', st, 'detail_text', d, 'detail', case when d like '{%' then d::jsonb end,
                              'unchanged', f0 = f1, 'probe_same', pr0 = pr1, 'check', chk);
    raise exception 'scenario-undo';
  exception when others then
    if sqlerrm <> 'scenario-undo' then raise; end if;
  end;
  return res;
end $f$;
create function pg_temp.assert_blocked(label text, r jsonb, cons text, tbl text) returns void language plpgsql as $f$
begin
  assert r->>'outcome' = 'DELETE_BLOCKED' and r->>'sqlstate' = 'P0001', label || ': expected DELETE_BLOCKED, got ' || r::text;
  assert (r->>'unchanged')::boolean, label || ': the whole world must be exactly as before (teams, ledger, request_log, sessions, audit ...)';
  assert r->'detail'->>'constraint' = cons and r->'detail'->>'table' = tbl, label || ': diagnostics must name ' || cons || ' on ' || tbl || ': ' || coalesce(r->>'detail_text', '-');
  assert (select array_agg(k order by k) from jsonb_object_keys(r->'detail') k) = array['constraint', 'table'], label || ': diagnostics carry exactly two keys';
  assert r->>'detail_text' !~* '[0-9a-f]{8}-[0-9a-f]{4}|password|hash|token|\d{3}', label || ': no id, secret or row value in the diagnostics';
end $f$;
create function pg_temp.assert_deleted(label text, r jsonb) returns void language plpgsql as $f$
begin
  assert r->>'outcome' = 'OK' and not (r->>'unchanged')::boolean, label || ': expected a successful deletion, got ' || r::text;
end $f$;

create temp table pre12c as select pg_temp.world_fp() as world;
do $$
declare
  r jsonb;
  cb text := $c$select pg_temp.del_admins(array[%s], 970)$c$;
begin
  -- (1) submissions.reviewed_by: admin a2 reviewed a submission of T06 (owner a6)
  r := pg_temp.scenario($p$insert into submissions (team_id, question_id, member_id, answer, explanation, status, submitted_at, reviewed_by, reviewed_at)
                           values (pg_temp.team_id(6), 1, pg_temp.member_id(6, 1), 'a', '', 'REJECTED', app.now(), pg_temp.staff(2), app.now())$p$,
                        format(cb, 'pg_temp.staff(2)'));
  perform pg_temp.assert_blocked('reviewed_by, a2 alone', r, 'submissions_reviewed_by_fkey', 'submissions');
  -- ... the same reference with BOTH sides selected: T06 goes with its owner a6, so nothing references a2 any more
  r := pg_temp.scenario($p$insert into submissions (team_id, question_id, member_id, answer, explanation, status, submitted_at, reviewed_by, reviewed_at)
                           values (pg_temp.team_id(6), 1, pg_temp.member_id(6, 1), 'a', '', 'REJECTED', app.now(), pg_temp.staff(2), app.now())$p$,
                        format(cb, 'pg_temp.staff(2), pg_temp.staff(6)'), $p$select '-'$p$,
                        $p$select jsonb_build_object('a2', exists (select 1 from staff_users where id = pg_temp.staff(2)), 'a6', exists (select 1 from staff_users where id = pg_temp.staff(6)),
                                                    't06', exists (select 1 from teams where id = pg_temp.team_id(6)), 'subs06', (select count(*) from submissions where team_id = pg_temp.team_id(6)))$p$);
  perform pg_temp.assert_deleted('reviewed_by, a2 + a6', r);
  assert r->'check' = '{"a2": false, "a6": false, "t06": false, "subs06": 0}', 'both admins, T06 and the reviewed submission are gone: ' || (r->'check')::text;
  -- (2) teams.ufm_penalized_by: admin a2 penalised T06 (owner a6)
  r := pg_temp.scenario($p$update teams set status = 'ENDED', started_at = app.now() - interval '1 hour', timer_seconds = 3600, ended_at = app.now(),
                                  ufm_penalized_at = app.now(), ufm_penalized_by = pg_temp.staff(2) where id = pg_temp.team_id(6)$p$,
                        format(cb, 'pg_temp.staff(2)'));
  perform pg_temp.assert_blocked('ufm_penalized_by, a2 alone', r, 'teams_ufm_penalized_by_fkey', 'teams');
  r := pg_temp.scenario($p$update teams set status = 'ENDED', started_at = app.now() - interval '1 hour', timer_seconds = 3600, ended_at = app.now(),
                                  ufm_penalized_at = app.now(), ufm_penalized_by = pg_temp.staff(2) where id = pg_temp.team_id(6)$p$,
                        format(cb, 'pg_temp.staff(2), pg_temp.staff(6)'));
  perform pg_temp.assert_deleted('ufm_penalized_by, a2 + a6', r);
  -- (3) staff_users.created_by: a2 created another account
  r := pg_temp.scenario($p$insert into staff_users (id, username, display_name, password_hash, role, created_by)
                           values (pg_temp.staff(8), 'created_by_a2', 'x', 'TEST-NOT-A-HASH', 'ADMIN', pg_temp.staff(2))$p$,
                        format(cb, 'pg_temp.staff(2)'));
  perform pg_temp.assert_blocked('staff_users.created_by, a2 alone', r, 'staff_users_created_by_fkey', 'staff_users');
  r := pg_temp.scenario($p$insert into staff_users (id, username, display_name, password_hash, role, created_by)
                           values (pg_temp.staff(8), 'created_by_a2', 'x', 'TEST-NOT-A-HASH', 'ADMIN', pg_temp.staff(2))$p$,
                        format(cb, 'pg_temp.staff(2), pg_temp.staff(8)'), $p$select '-'$p$,
                        $p$select jsonb_build_object('a2', exists (select 1 from staff_users where id = pg_temp.staff(2)), 'a8', exists (select 1 from staff_users where id = pg_temp.staff(8)))$p$);
  perform pg_temp.assert_deleted('staff_users.created_by, a2 + a8', r);
  assert r->'check' = '{"a2": false, "a8": false}', 'creator and created account are both gone: ' || (r->'check')::text;
  -- (4) coin_transactions.staff_id: the persisted row of section 12(b) (T06's ledger names a4): a4 alone blocks, a4 + T06's owner a6 does not
  r := pg_temp.scenario('select 1', format(cb, 'pg_temp.staff(4)'));
  perform pg_temp.assert_blocked('ledger staff_id, a4 alone', r, 'coin_transactions_staff_id_fkey', 'coin_transactions');
  r := pg_temp.scenario('select 1', format(cb, 'pg_temp.staff(4), pg_temp.staff(6)'));
  perform pg_temp.assert_deleted('ledger staff_id, a4 + a6', r);
  -- (5) teams.created_by: a2 created T07, which is owned by a6 (re-planted: section 12 repaired it)
  r := pg_temp.scenario('update teams set created_by = pg_temp.staff(2) where id = pg_temp.team_id(7)', format(cb, 'pg_temp.staff(2)'));
  perform pg_temp.assert_blocked('teams.created_by, a2 alone', r, 'teams_created_by_fkey', 'teams');
  r := pg_temp.scenario('update teams set created_by = pg_temp.staff(2) where id = pg_temp.team_id(7)', format(cb, 'pg_temp.staff(2), pg_temp.staff(6)'));
  perform pg_temp.assert_deleted('teams.created_by, a2 + a6', r);
end $$;

-- the sub-transactions left nothing behind
do $$ begin assert (select pg_temp.world_fp()) = (select world from pre12c), 'section 12b changed nothing that remains'; end $$;

-- (6) delete_teams: a genuine DELETE_BLOCKED. A ledger row of T07 points at a SUBMISSION of T06 (the application cannot create this).
-- Deleting T06 erases T06's ledger and then its submissions, and the surviving row still references one of them.
do $$
declare
  plant text := $p$insert into submissions (id, team_id, question_id, member_id, answer, explanation, status, submitted_at, reviewed_by, reviewed_at)
                     values ('00000000-0000-4000-8000-0000000b0001', pg_temp.team_id(6), 1, pg_temp.member_id(6, 1), 'a', '', 'REJECTED', app.now(), pg_temp.staff(1), app.now());
                   insert into coin_transactions (team_id, type, amount, balance_after, question_id, submission_id, created_at)
                     values (pg_temp.team_id(7), 'QUESTION_REWARD', 10, 510, 1, '00000000-0000-4000-8000-0000000b0001', now())$p$;
  r jsonb;
begin
  r := pg_temp.scenario(plant, $c$select pg_temp.del_teams(array[pg_temp.team_id(6)], 971)$c$,
                        $p$select pg_temp.team_fp(pg_temp.team_id(6)) || pg_temp.ledger_team_fp(pg_temp.team_id(6)) || pg_temp.ledger_team_fp(pg_temp.team_id(7))$p$,
                        $p$select jsonb_build_object('t6', exists (select 1 from teams where id = pg_temp.team_id(6)), 'marker', coalesce(current_setting('app.retiring_team_ids', true), ''),
                                                    'key_reusable', not exists (select 1 from request_log where pg_temp.knum(idem_key) = 971))$p$);
  perform pg_temp.assert_blocked('delete_teams [T06] with a foreign ledger row on its submission', r, 'coin_transactions_submission_id_fkey', 'coin_transactions');
  assert (r->>'probe_same')::boolean, 'T06 and both ledgers are byte-identical after the refusal';
  assert (r->'check'->>'t6')::boolean and r->'check'->>'marker' = '' and (r->'check'->>'key_reusable')::boolean, 'T06 is still there, the ledger marker is cleared, a failed request stores nothing: ' || r::text;
  -- both sides selected: T07's ledger goes with T07 BEFORE T06's submission is deleted, so the pair succeeds
  r := pg_temp.scenario(plant, $c$select pg_temp.del_teams(array[pg_temp.team_id(6), pg_temp.team_id(7)], 972)$c$);
  perform pg_temp.assert_deleted('delete_teams [T06, T07] together', r);
  -- ... and deleting only T07 (the team that holds the reference) is also fine
  r := pg_temp.scenario(plant, $c$select pg_temp.del_teams(array[pg_temp.team_id(7)], 973)$c$);
  perform pg_temp.assert_deleted('delete_teams [T07] alone', r);
end $$;

-- (7) an UNKNOWN table with a foreign key to teams (schema drift, a future migration): both functions refuse and roll back, and
-- the constraint of that table is what the diagnostics name. A team the table does not reference is still deletable.
do $$
declare
  plant text := $p$create table public.drift_probe (team uuid references teams(id)); insert into drift_probe values (pg_temp.team_id(6))$p$;
  r jsonb;
begin
  r := pg_temp.scenario(plant, $c$select pg_temp.del_teams(array[pg_temp.team_id(6)], 974)$c$);
  perform pg_temp.assert_blocked('unknown FK, delete_teams', r, 'drift_probe_team_fkey', 'drift_probe');
  r := pg_temp.scenario(plant, $c$select pg_temp.del_admins(array[pg_temp.staff(6)], 975)$c$);
  perform pg_temp.assert_blocked('unknown FK, delete_admins (owner of T06)', r, 'drift_probe_team_fkey', 'drift_probe');
  r := pg_temp.scenario(plant, $c$select pg_temp.del_teams(array[pg_temp.team_id(7)], 976)$c$);
  perform pg_temp.assert_deleted('unknown FK on another team does not block T07', r);
  r := pg_temp.scenario(plant, $c$select pg_temp.del_teams(array[pg_temp.team_id(6)], 977)$c$,
                        $p$select '-'$p$, $p$select jsonb_build_object('drift_rows', (select count(*) from drift_probe))$p$);
  assert (r->'check'->>'drift_rows')::int = 1, 'the unknown table was not touched either';
end $$;
do $$ begin assert not exists (select 1 from pg_class where relname = 'drift_probe'), 'the planted table is gone'; end $$;

-- (8) an unrelated team's Super-Admin-reviewed ledger row is untouched. This is a REAL approval by the Super Admin on T06
-- (owner a6) - the documented exception to "the owner reviews" - and then a2 (who owns neither T06 nor anything it needs) is deleted.
do $$
declare
  r jsonb;
begin
  r := pg_temp.scenario($p$select pg_temp.start(6, 1001), pg_temp.unlock(6, 1, 1002), pg_temp.enter(6, 1, 1003), pg_temp.submit(6, 1, 1004), pg_temp.approve(1, 6, 1, 1005)$p$,
                        $c$select pg_temp.del_admins(array[pg_temp.staff(2), pg_temp.staff(3)], 978)$c$,
                        $p$select pg_temp.team_fp(pg_temp.team_id(6)) || pg_temp.ledger_team_fp(pg_temp.team_id(6)) || pg_temp.ledger_team_fp(pg_temp.team_id(7))$p$,
                        $p$select jsonb_build_object('super_rows', (select count(*) from coin_transactions where team_id = pg_temp.team_id(6) and staff_id = pg_temp.staff(1) and type = 'QUESTION_REWARD' and submission_id is not null),
                                                    'a2_gone', not exists (select 1 from staff_users where id = pg_temp.staff(2)), 'a3_gone', not exists (select 1 from staff_users where id = pg_temp.staff(3)),
                                                    'balance_ok', not exists (select 1 from app.invariant_coin_balance_mismatch))$p$);
  perform pg_temp.assert_deleted('unrelated Super-reviewed ledger row', r);
  assert (r->>'probe_same')::boolean, 'T06 (its rows, its ledger incl. the Super-reviewed reward) and T07 are byte-identical after deleting a2 and a3';
  assert (r->'check'->>'super_rows')::int = 1 and (r->'check'->>'a2_gone')::boolean and (r->'check'->>'a3_gone')::boolean and (r->'check'->>'balance_ok')::boolean, 'check: ' || (r->'check')::text;
end $$;

-- (9) a deleted admin's UFM challenges and sessions are removed even when the TEAM they point at survives (documented in
-- docs/ADMIN_TEAM_DELETION.md): a2 raised a challenge on T06 (owner a6). The challenge and a2's cookies go; T06, its member session and
-- everyone else's challenges stay.
do $$
declare
  r jsonb;
begin
  r := pg_temp.scenario($p$insert into ufm_challenges (staff_id, team_id, action, expires_at) values (pg_temp.staff(2), pg_temp.team_id(6), 'RESET_SCORE', now() + interval '5 minutes'),
                                                                                                    (pg_temp.staff(6), pg_temp.team_id(6), 'DISQUALIFY', now() + interval '5 minutes');
                           insert into sessions (token_hash, kind, team_id, member_id, expires_at) values (pg_temp.tok(601), 'MEMBER', pg_temp.team_id(6), pg_temp.member_id(6, 1), app.now() + interval '1 hour')$p$,
                        $c$select pg_temp.del_admins(array[pg_temp.staff(2)], 979)$c$,
                        $p$select pg_temp.team_fp(pg_temp.team_id(6))$p$,
                        $p$select jsonb_build_object('a2_challenges', (select count(*) from ufm_challenges where staff_id = pg_temp.staff(2)),
                                                    'a6_challenge_kept', (select count(*) from ufm_challenges where staff_id = pg_temp.staff(6) and team_id = pg_temp.team_id(6)),
                                                    'a2_sessions', (select count(*) from sessions where staff_id = pg_temp.staff(2)),
                                                    'a2_cookie', (public.resolve_session(pg_temp.tok(102))->>'ok')::boolean,
                                                    'member_cookie', (public.resolve_session(pg_temp.tok(601))->>'ok')::boolean,
                                                    't6', exists (select 1 from teams where id = pg_temp.team_id(6)))$p$);
  perform pg_temp.assert_deleted('foreign UFM challenge and sessions', r);
  assert (r->'check'->>'a2_challenges')::int = 0 and (r->'check'->>'a2_sessions')::int = 0, 'a2''s challenge (on a team that survives) and sessions are removed: ' || (r->'check')::text;
  assert (r->'check'->>'a6_challenge_kept')::int = 1 and (r->'check'->>'t6')::boolean, 'the owner''s own challenge and the team are kept: ' || (r->'check')::text;
  assert not (r->'check'->>'a2_cookie')::boolean and (r->'check'->>'member_cookie')::boolean, 'a2''s cookie is dead, the team''s member cookie is alive: ' || (r->'check')::text;
  assert (r->>'probe_same')::boolean, 'T06''s own rows (not counting the challenge) are unchanged';
end $$;
do $$ begin assert (select pg_temp.world_fp()) = (select world from pre12c), 'section 12b as a whole changed nothing that remains'; end $$;

-- ===== 13. delete SEVERAL admins: their teams and data go; usernames come back =====================================
-- a2 (teams: re-created T01, new N1), a3 (team N2), D "doomed_admin" (no team, created by a real create_admin)
create temp table log3 as select * from request_log;
do $$
begin
  assert (public.staff_login('doomed_admin', 'doomed-admin-pw-1', pg_temp.tok(310))->>'ok')::boolean, 'D can sign in while it exists';
  assert (public.participant_login('new_team_2', 'new-team-pass-2', 'NB1', pg_temp.tok(311))->>'ok')::boolean, 'N2 can sign in while it exists';
  assert (public.resolve_session(pg_temp.tok(310))->>'ok')::boolean and (public.resolve_session(pg_temp.tok(311))->>'ok')::boolean;
end $$;
create temp table pre13 as select
  pg_temp.team_fp(pg_temp.team_id(6)) as t6, pg_temp.team_fp(pg_temp.team_id(7)) as t7,
  pg_temp.ledger_team_fp(pg_temp.team_id(6)) as l6, pg_temp.ledger_team_fp(pg_temp.team_id(7)) as l7,
  (select coins from teams where id = pg_temp.team_id(6)) as c6, (select count(*) from staff_users) as staff,
  (select count(*) from coin_transactions where team_id in (select id from teams where admin_id in (pg_temp.staff(2), pg_temp.staff(3)))) as ledger_sel,
  (select count(*) from coin_transactions) as ledger_n, (select count(*) from teams where admin_id in (pg_temp.staff(2), pg_temp.staff(3))) as teams_sel,
  (select max(id) from audit_events) as audit_max, (select md5(string_agg(a::text, ',' order by a.id)) from audit_events a) as audit_fp,
  array(select id from teams where admin_id in (pg_temp.staff(2), pg_temp.staff(3)) order by id) as doomed_teams;
do $$
declare j jsonb := pg_temp.del_admins(array[(select (doomed->'admin'->>'id')::uuid from made_admins), pg_temp.staff(2), pg_temp.staff(3)], 950);
begin
  assert (j->'deleted'->>'admins')::int = 3 and (j->'deleted'->>'teams')::int = (select teams_sel from pre13), 'response: ' || j::text;
  assert (select teams_sel from pre13) = 3, 'a2: re-created T01 + N1b, a3: N2';
  assert not exists (select 1 from teams where id = any(array(select unnest(doomed_teams) from pre13))), 'every team of the deleted admins is gone';
  assert not exists (select 1 from coin_transactions where team_id = any(array(select unnest(doomed_teams) from pre13))) and not exists (select 1 from team_time_purchases where team_id = any(array(select unnest(doomed_teams) from pre13)));
  assert (select count(*) from coin_transactions) = (select ledger_n - ledger_sel from pre13), 'exactly their ledgers left the table';
  assert not exists (select 1 from staff_users where id in (pg_temp.staff(2), pg_temp.staff(3)) or username in ('test_admin1', 'test_admin2', 'doomed_admin'));
  assert (select count(*) from staff_users) = (select staff - 3 from pre13);
  assert not exists (select 1 from sessions where staff_id in (pg_temp.staff(2), pg_temp.staff(3))), 'staff sessions removed';
  assert not (public.resolve_session(pg_temp.tok(102))->>'ok')::boolean and not (public.resolve_session(pg_temp.tok(103))->>'ok')::boolean, 'old admin cookies are dead';
  assert not (public.resolve_session(pg_temp.tok(310))->>'ok')::boolean and not (public.resolve_session(pg_temp.tok(311))->>'ok')::boolean, 'the doomed admin''s and the doomed team''s fresh cookies are dead';
  assert (public.resolve_session(pg_temp.tok(101))->>'ok')::boolean, 'the Super Admin''s own cookie is untouched';
  assert not exists (select 1 from ufm_challenges where staff_id in (pg_temp.staff(2), pg_temp.staff(3)));
  assert not exists (select 1 from auth_throttle where key = 'staff:test_admin1') and exists (select 1 from auth_throttle where key = 'staff:other');
  -- unrelated: other admins, their teams, their money
  assert exists (select 1 from staff_users where id in (pg_temp.staff(4), pg_temp.staff(5), pg_temp.staff(6)) or username = 'kept_admin'), 'other admins unchanged';
  assert pg_temp.team_fp(pg_temp.team_id(6)) = (select t6 from pre13) and pg_temp.team_fp(pg_temp.team_id(7)) = (select t7 from pre13), 'other admins'' teams unchanged';
  assert pg_temp.ledger_team_fp(pg_temp.team_id(6)) = (select l6 from pre13) and pg_temp.ledger_team_fp(pg_temp.team_id(7)) = (select l7 from pre13), 'their ledgers unchanged';
  assert (select coins from teams where id = pg_temp.team_id(6)) = (select c6 from pre13);
  assert not exists (select 1 from app.invariant_coin_balance_mismatch) and not exists (select 1 from app.invariant_team_member_count);
  -- audit: only grew
  assert (select md5(string_agg(a::text, ',' order by a.id)) from audit_events a where a.id <= (select audit_max from pre13)) = (select audit_fp from pre13), 'old audit rows untouched';
  assert (select count(*) from audit_events where event_type = 'ADMIN_DELETED' and staff_id = pg_temp.staff(1)) = 3 and (select count(*) from audit_events where event_type = 'ADMINS_DELETED') = 1;
  assert (select count(*) from audit_events where event_type = 'TEAM_DELETED' and request_id = pg_temp.key(950)) = 3;
end $$;
-- request_log for an admin deletion: a2's scope (the new N1's create reply 60, the re-created T01's reply 920, 67), a3's scope (61),
-- D's create_admin reply in the SUPER ADMIN's scope (62). Nothing else - not K's reply (63), not a6/a5/team 6 rows (70-75), not the
-- Super Admin's own delete records (910, 930, 935), not its status/approve replies (1, 73).
do $$
begin
  assert pg_temp.log_gone('log3') = array[60, 61, 62, 67, 920], 'removed request_log keys: ' || pg_temp.log_gone('log3')::text;
  assert pg_temp.log_new('log3') = array[950] and pg_temp.log_changed('log3') = 0;
  assert (select count(*) from request_log where team_id in (pg_temp.staff(2), pg_temp.staff(3))) = 0, 'no record in a deleted admin''s scope';
  assert (select array_agg(pg_temp.knum(idem_key) order by pg_temp.knum(idem_key)) from request_log where pg_temp.knum(idem_key) in (1, 63, 70, 71, 72, 73, 74, 75, 910, 930, 935, 950))
       = array[1, 63, 70, 71, 72, 73, 74, 75, 910, 930, 935, 950], 'unrelated records and the Super Admin''s deletion replies survive';
end $$;
-- a deleted admin can no longer sign in; the username is free again; a live one is still taken
do $$
declare l jsonb := public.staff_login('doomed_admin', 'doomed-admin-pw-1', pg_temp.tok(312));
begin
  assert (l->>'ok')::boolean = false, 'deleted admin cannot log in with the RIGHT password: ' || l::text;
  assert not (public.participant_login('new_team_2', 'new-team-pass-2', 'NB1', pg_temp.tok(313))->>'ok')::boolean, 'deleted team cannot log in with the RIGHT credentials';
  assert not exists (select 1 from sessions where token_hash in (pg_temp.tok(312), pg_temp.tok(313))), 'no session was issued';
end $$;
create temp table reuse2 as select public.create_admin(pg_temp.staff(1), 'Doomed_Admin', 'reborn-admin-pw-1', pg_temp.key(960)) as j;
do $$
declare nid uuid := (select (r.j->'admin'->>'id')::uuid from reuse2 r);
begin
  assert exists (select 1 from staff_users where id = nid and role = 'ADMIN' and created_by = pg_temp.staff(1)) and nid <> (select (doomed->'admin'->>'id')::uuid from made_admins);
  assert (public.staff_login('doomed_admin', 'reborn-admin-pw-1', pg_temp.tok(314))->>'ok')::boolean, 'the re-created admin signs in';
  assert (select count(*) from teams where admin_id = nid) = 0, 'and owns nothing from before';
end $$;
select pg_temp.rejects($s$select public.create_admin(pg_temp.staff(1), 'KEPT_ADMIN', 'another-admin-pw-1', pg_temp.key(961))$s$, 'USERNAME_TAKEN');
select pg_temp.rejects($s$select public.create_admin(pg_temp.staff(1), 'test_admin4', 'another-admin-pw-1', pg_temp.key(962))$s$, 'USERNAME_TAKEN');
-- a login id of a deleted team is free again
do $$
declare r jsonb := public.create_team(pg_temp.staff(5), 'N2', 'Reborn N2', 'new_team_2', 'reborn-pass-n2', array['NB1', 'NB2', 'NB3', 'NB4'], pg_temp.key(963));
begin
  assert (public.participant_login('new_team_2', 'reborn-pass-n2', 'NB1', pg_temp.tok(315))->>'ok')::boolean, 'the new owner of the login id signs in';
  assert (select count(*) from coin_transactions where team_id = (r->'team'->>'id')::uuid) = 1;
end $$;
-- the Super Admin is still there, still unique, still not deletable
do $$
begin
  assert (select count(*) from staff_users where role = 'SUPER_ADMIN') = 1 and exists (select 1 from staff_users where id = pg_temp.staff(1) and is_active);
  assert not exists (select 1 from jsonb_array_elements(public.list_deletable_admins(pg_temp.staff(1))->'admins') e where e->>'username' = 'test_super');
end $$;

-- ===== 14. what the audit trail still says about deleted accounts (documented, not hidden) ============================
-- audit_events is append-only and its rows about deleted accounts stay. This section pins down exactly WHAT is retained so the
-- documentation can never drift from the data: ids everywhere, and the identifiers listed below in the payloads - no secret.
do $$
declare keys text;
begin
  select string_agg(distinct k, ',' order by k) into keys
    from audit_events a, lateral jsonb_object_keys(a.payload) k
   where a.event_type in ('TEAM_CREATED', 'TEAM_DELETED', 'ADMIN_CREATED', 'ADMIN_DELETED');
  assert keys = 'admin_id,initial_coins,login_id,member_count,name,role,status,team_code,username', 'payload keys retained in the creation/deletion events: ' || keys;
  assert not exists (select 1 from audit_events where payload::text ~* 'password|hash|token|admission');
  -- the deleted team is still named by id in the trail, and nowhere else
  assert exists (select 1 from audit_events where team_id = pg_temp.team_id(1) and event_type = 'TEAM_DELETED');
  assert (select count(*) from audit_events where team_id = pg_temp.team_id(1)) >= 2, 'the history rows from before the deletion are still there';
end $$;

-- ===== 15. the world is consistent afterwards =========================================================================
do $$
begin
  assert not exists (select 1 from app.invariant_coin_balance_mismatch), 'every surviving team''s balance equals its ledger tail';
  assert not exists (select 1 from app.invariant_team_member_count);
  assert not exists (select 1 from coin_transactions c where not exists (select 1 from teams t where t.id = c.team_id)), 'no ledger row for a team that does not exist';
  assert not exists (select 1 from team_time_purchases p where not exists (select 1 from teams t where t.id = p.team_id)), 'no purchase row for a team that does not exist';
  assert not exists (select 1 from request_log r where r.operation not in ('delete_teams', 'delete_admins', 'create_admin', 'status', 'set_competition_status')
                       and r.team_id not in (select id from teams union select id from staff_users)), 'every remaining record is in the scope of an account that still exists: ' ||
                       coalesce((select string_agg(operation || '/' || pg_temp.knum(idem_key), ',') from request_log r where r.operation not in ('delete_teams', 'delete_admins', 'create_admin', 'status', 'set_competition_status')
                       and r.team_id not in (select id from teams union select id from staff_users)), '');
  assert (select count(*) from pg_trigger where tgrelid = 'coin_transactions'::regclass and not tgisinternal and tgenabled = 'O') = 3, 'ledger triggers still enabled';
  assert (select count(*) from pg_trigger where tgrelid = 'audit_events'::regclass and not tgisinternal and tgenabled = 'O') = 2, 'audit triggers still enabled';
  assert coalesce(current_setting('app.retiring_team_ids', true), '') = '';
end $$;
-- ... and the immutable tables are still immutable after all of that
select pg_temp.rejects($s$update coin_transactions set amount = amount where team_id = pg_temp.team_id(6)$s$, 'append-only');
select pg_temp.rejects($s$delete from coin_transactions where team_id = pg_temp.team_id(6)$s$, 'append-only');
select pg_temp.rejects($s$truncate coin_transactions cascade$s$, 'append-only');
select pg_temp.rejects($s$update audit_events set payload = '{}'$s$, 'append-only');
select pg_temp.rejects($s$delete from audit_events$s$, 'append-only');
select pg_temp.rejects($s$truncate audit_events$s$, 'append-only');
rollback;

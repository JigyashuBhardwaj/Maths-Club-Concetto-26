-- B14 (migration 15): member presence, the Admin "My Teams" matrix (admin_matrix), the theme drill-down
-- (admin_team_theme), Admin ownership, and the approval -> reward -> next question flow as the matrix sees it.
-- Fixture: Admin a2 owns team 1, Admin a3 owns team 2, a1 is the Super Admin.
begin;
\ir include/helpers.sql
\ir include/fixture.sql

set app.allow_test_clock = 'on';
set app.test_now = '2026-12-02 09:00:00+00';

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
create function pg_temp.submit(t int, s int, q int, a text, n int) returns jsonb language sql as
  $$ select public.submit_answer(pg_temp.team_id(t), pg_temp.member_id(t, s), q::smallint, a, 'because', pg_temp.key(n)) $$;
create function pg_temp.approve(who uuid, sub uuid, n int) returns jsonb language sql as
  $$ select public.approve_submission(who, sub, pg_temp.key(n)) $$;
create function pg_temp.disapprove(who uuid, sub uuid, n int) returns jsonb language sql as
  $$ select public.disapprove_submission(who, sub, null, pg_temp.key(n)) $$;
create function pg_temp.sub(t int, q int) returns uuid language sql as
  $$ select id from submissions where team_id = pg_temp.team_id(t) and question_id = q and status = 'PENDING' $$;
create function pg_temp.coins(t int) returns int language sql as $$ select coins from teams where id = pg_temp.team_id(t) $$;
create function pg_temp.tq(t int, q int) returns team_questions language sql as
  $$ select * from team_questions where team_id = pg_temp.team_id(t) and question_id = q $$;
-- the matrix row of one team as the Admin `who` sees it, and one cell of it
create function pg_temp.row(who int, t int) returns jsonb language sql as
  $$ select e from jsonb_array_elements(public.admin_matrix(pg_temp.staff(who))->'teams') e where (e->>'id')::uuid = pg_temp.team_id(t) $$;
create function pg_temp.cell(who int, t int, theme text) returns text language sql as
  $$ select c->>'state' from jsonb_array_elements(pg_temp.row(who, t)->'themes') c where c->>'code' = theme $$;
create function pg_temp.presence(who int, t int, slot int) returns text language sql as
  $$ select m->>'presence' from jsonb_array_elements(pg_temp.row(who, t)->'members') m where (m->>'slot')::int = slot $$;
-- a live participant session whose last sign of life was `ago` seconds before the test clock
create function pg_temp.login(t int, s int, ago int) returns void language plpgsql as $$
begin
  insert into sessions (token_hash, kind, team_id, member_id, created_at, last_seen_at, expires_at)
  values (sha256(('tok-' || t || '-' || s)::bytea), 'MEMBER', pg_temp.team_id(t), pg_temp.member_id(t, s),
          app.now() - make_interval(secs => ago), app.now() - make_interval(secs => ago), app.now() + interval '1 day');
end $$;

-- ===== 1. the matrix has exactly the Admin's own teams, M1..M4 and A..J ============================================
select pg_temp.status('open', 1);
do $$
declare m jsonb;
begin
  m := public.admin_matrix(pg_temp.staff(2));
  assert jsonb_array_length(m->'teams') = 1 and m->'teams'->0->>'team_code' = 'T01', 'Admin 1 owns exactly T01';
  assert (m->>'presence_timeout_seconds')::int = 75;
  assert jsonb_array_length(m->'teams'->0->'members') = 4 and jsonb_array_length(m->'teams'->0->'themes') = 10;
  assert (select string_agg(c->>'code', '' order by ord) from jsonb_array_elements(m->'teams'->0->'themes') with ordinality x(c, ord)) = 'ABCDEFGHIJ';
  assert (select bool_and(c->>'state' = 'NORMAL' and (c->>'approved')::int = 0 and (c->>'pending')::int = 0)
            from jsonb_array_elements(m->'teams'->0->'themes') c), 'nothing played: every cell is NORMAL';
  assert (m->'teams'->0->>'final_submitted')::boolean = false;
  -- ownership: the other Admin sees only their own team, never T01 (or its members, presence, themes)
  m := public.admin_matrix(pg_temp.staff(3));
  assert jsonb_array_length(m->'teams') = 1 and m->'teams'->0->>'team_code' = 'T02';
  assert m::text not like '%T01%' and m::text not like '%Test Team 1%';
  assert m::text not like '%reference_answer%' and m::text not like '%solution_notes%' and m::text not like '%password%';
end $$;
select pg_temp.rejects($s$select public.admin_matrix(pg_temp.staff(1))$s$, 'FORBIDDEN');          -- the Super Admin is not an Admin here
select pg_temp.rejects($s$select public.admin_matrix(pg_temp.team_id(1))$s$, 'FORBIDDEN');         -- not a staff id
select pg_temp.rejects($s$select public.admin_matrix(null)$s$, 'FORBIDDEN');

-- ===== 2. presence: member-specific, login -> IN, silence -> OUT, return -> IN, logout -> OUT =======================
do $$ begin
  assert pg_temp.presence(2, 1, 1) = 'OFFLINE' and pg_temp.presence(2, 1, 2) = 'OFFLINE', 'no session: everybody is OUT';
end $$;
select pg_temp.login(1, 1, 0);                                  -- M1 signs in
select pg_temp.login(1, 3, 10);                                 -- M3 signs in, last seen 10 s ago
do $$ begin
  assert pg_temp.presence(2, 1, 1) = 'ONLINE' and pg_temp.presence(2, 1, 3) = 'ONLINE';
  assert pg_temp.presence(2, 1, 2) = 'OFFLINE' and pg_temp.presence(2, 1, 4) = 'OFFLINE', 'presence is per member, not per team';
  -- the team with the other Admin is not affected by, and cannot reveal, T01's sessions
  assert pg_temp.presence(3, 2, 1) = 'OFFLINE';
end $$;
-- time passes with no heartbeat: 74 s still IN, 76 s OUT (the boundary is the documented 75 s)
select pg_temp.at('2026-12-02 09:01:04+00');                    -- M1 last seen 09:00:00 -> 64 s ago; M3 74 s
do $$ begin
  assert pg_temp.presence(2, 1, 1) = 'ONLINE' and pg_temp.presence(2, 1, 3) = 'ONLINE';
end $$;
select pg_temp.at('2026-12-02 09:01:16+00');                    -- M1 76 s, M3 86 s
do $$ begin
  assert pg_temp.presence(2, 1, 1) = 'OFFLINE' and pg_temp.presence(2, 1, 3) = 'OFFLINE', 'stale beyond the timeout: OUT';
end $$;
-- the participant is back (a heartbeat / any authenticated request refreshes last_seen_at): IN again
update sessions set last_seen_at = app.now() where member_id = pg_temp.member_id(1, 3);
do $$ begin
  assert pg_temp.presence(2, 1, 3) = 'ONLINE' and pg_temp.presence(2, 1, 1) = 'OFFLINE', 'only the reconnecting member returns';
end $$;
-- a session that is fresh but EXPIRED does not count; a revoked one (logout) is OUT at once
update sessions set expires_at = app.now() - interval '1 second' where member_id = pg_temp.member_id(1, 3);
do $$ begin assert pg_temp.presence(2, 1, 3) = 'OFFLINE', 'an expired session is not presence'; end $$;
update sessions set expires_at = app.now() + interval '1 day' where member_id = pg_temp.member_id(1, 3);
select pg_temp.login(1, 2, 0);
do $$ begin assert pg_temp.presence(2, 1, 2) = 'ONLINE'; end $$;
update sessions set revoked_at = app.now(), revoke_reason = 'LOGOUT' where member_id = pg_temp.member_id(1, 2);
do $$ begin assert pg_temp.presence(2, 1, 2) = 'OFFLINE', 'logout: OUT immediately'; end $$;
-- the view and the matrix agree
do $$ begin
  assert (select presence::text from member_presence where member_id = pg_temp.member_id(1, 3)) = pg_temp.presence(2, 1, 3);
end $$;

-- ===== 3. cells: unlocked is NOT red; pending is RED; several themes and several teams at once =======================
select pg_temp.at('2026-12-02 09:05:00+00');
select pg_temp.start(1, 1, 10);
select pg_temp.start(2, 1, 11);
-- team 1 unlocks A, D, G (400 coins buys them); team 2 unlocks C, F
select pg_temp.unlock(1, 1, 1, 12); select pg_temp.unlock(1, 1, 4, 13); select pg_temp.unlock(1, 2, 7, 14);
select pg_temp.unlock(2, 1, 3, 15); select pg_temp.unlock(2, 1, 6, 16);
select pg_temp.enter(1, 1, 1, 17);      -- A.1 ACTIVE
select pg_temp.enter(1, 1, 16, 18);     -- D.1 ACTIVE
select pg_temp.enter(1, 1, 31, 19);     -- G.1 ACTIVE
select pg_temp.enter(2, 1, 11, 20);     -- C.1 ACTIVE
do $$ begin
  assert pg_temp.cell(2, 1, 'A') = 'NORMAL' and pg_temp.cell(2, 1, 'D') = 'NORMAL' and pg_temp.cell(2, 1, 'G') = 'NORMAL',
    'a merely unlocked (or active) theme is not red';
end $$;
select pg_temp.at('2026-12-02 09:05:30+00');
select pg_temp.submit(1, 1, 16, 'answer D1', 21);     -- T1 -> D.1
select pg_temp.submit(1, 2, 31, 'answer G1', 22);     -- T1 -> G.1   (two themes at once)
select pg_temp.submit(2, 1, 11, 'answer C1', 23);     -- T2 -> C.1   (another team, another admin)
do $$
declare r jsonb := pg_temp.row(2, 1);
begin
  assert pg_temp.cell(2, 1, 'D') = 'RED' and pg_temp.cell(2, 1, 'G') = 'RED', 'two RED cells at once';
  assert pg_temp.cell(2, 1, 'A') = 'NORMAL' and pg_temp.cell(2, 1, 'B') = 'NORMAL';
  assert (select (c->>'pending')::int from jsonb_array_elements(r->'themes') c where c->>'code' = 'D') = 1;
  -- each Admin sees only their own red cells
  assert pg_temp.cell(3, 2, 'C') = 'RED' and pg_temp.row(3, 1) is null and pg_temp.row(2, 2) is null;
end $$;

-- ===== 4. the theme drill-down: five questions, colours, the right submission, no key ===============================
do $$
declare d jsonb;
begin
  d := public.admin_team_theme(pg_temp.staff(2), pg_temp.team_id(1), 'D');
  assert d->'team'->>'team_code' = 'T01' and d->'theme'->>'code' = 'D';
  assert jsonb_array_length(d->'questions') = 5;
  assert (select string_agg(q->>'label', ',' order by (q->>'ordinal')::int) from jsonb_array_elements(d->'questions') q) = 'D.1,D.2,D.3,D.4,D.5';
  assert d->'questions'->0->>'color' = 'RED' and d->'questions'->0->>'state' = 'PENDING_APPROVAL';
  assert (select bool_and(q->>'color' = 'WHITE') from jsonb_array_elements(d->'questions') q where (q->>'ordinal')::int > 1);
  assert d->'questions'->0->'submission'->>'answer' = 'answer D1' and d->'questions'->0->'submission'->>'explanation' = 'because';
  assert (d->'questions'->0->'submission'->>'id')::uuid = pg_temp.sub(1, 16), 'the drill-down opens the very submission the approve endpoint acts on';
  assert (d->'questions'->0->'submission'->>'submitted_by_slot')::int = 1;
  assert d->'questions'->1->'submission' = 'null'::jsonb, 'only a RED question carries a submission';
  assert d::text not like '%reference_answer%' and d::text not like '%solution_notes%' and d::text not like '%question_keys%';
  -- a theme the team has not unlocked: five LOCKED, WHITE questions, no data leaked
  d := public.admin_team_theme(pg_temp.staff(2), pg_temp.team_id(1), 'J');
  assert (select bool_and(q->>'state' = 'LOCKED' and q->>'color' = 'WHITE') from jsonb_array_elements(d->'questions') q);
  assert jsonb_array_length(d->'questions') = 5;
  -- lowercase theme codes are accepted, unknown ones are NOT_FOUND
  assert public.admin_team_theme(pg_temp.staff(2), pg_temp.team_id(1), ' d ')->'theme'->>'code' = 'D';
end $$;
select pg_temp.rejects($s$select public.admin_team_theme(pg_temp.staff(2), pg_temp.team_id(1), 'K')$s$, 'NOT_FOUND');
select pg_temp.rejects($s$select public.admin_team_theme(pg_temp.staff(2), pg_temp.team_id(1), null)$s$, 'NOT_FOUND');
-- ownership cannot be bypassed: another Admin, the Super Admin, a participant id, an unknown team
select pg_temp.rejects($s$select public.admin_team_theme(pg_temp.staff(3), pg_temp.team_id(1), 'D')$s$, 'NOT_FOUND');
select pg_temp.rejects($s$select public.admin_team_theme(pg_temp.staff(1), pg_temp.team_id(1), 'D')$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.admin_team_theme(pg_temp.member_id(1, 1), pg_temp.team_id(1), 'D')$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.admin_team_theme(pg_temp.staff(2), gen_random_uuid(), 'D')$s$, 'NOT_FOUND');
select pg_temp.rejects($s$select public.admin_team_theme(pg_temp.staff(2), pg_temp.team_id(2), 'C')$s$, 'NOT_FOUND');
-- ... and neither can the existing approve / disapprove (B13): Admin 2 cannot decide T02's submission
select pg_temp.rejects($s$select pg_temp.approve(pg_temp.staff(2), pg_temp.sub(2, 11), 40)$s$, 'NOT_FOUND');
select pg_temp.rejects($s$select pg_temp.disapprove(pg_temp.staff(2), pg_temp.sub(2, 11), 41)$s$, 'NOT_FOUND');
do $$ begin assert pg_temp.cell(3, 2, 'C') = 'RED' and pg_temp.coins(2) = (select balance_after from coin_transactions where team_id = pg_temp.team_id(2) order by id desc limit 1); end $$;

-- ===== 5. approval: GREEN question, + reward once (question-level data), next question ACTIVE, ledger ===============
do $$
declare before_coins int := pg_temp.coins(1);
begin
  assert (select reward_coins from questions where id = 16) = 50;
  perform pg_temp.approve(pg_temp.staff(2), pg_temp.sub(1, 16), 50);
  assert pg_temp.coins(1) = before_coins + 50, '+50 (questions.reward_coins)';
  assert (select count(*) from coin_transactions where team_id = pg_temp.team_id(1) and question_id = 16 and type = 'QUESTION_REWARD') = 1;
  assert (select amount from coin_transactions where team_id = pg_temp.team_id(1) and question_id = 16 and type = 'QUESTION_REWARD') = 50;
  assert (pg_temp.tq(1, 16)).state = 'APPROVED' and (pg_temp.tq(1, 17)).state = 'ACTIVE' and (pg_temp.tq(1, 17)).timer_deadline is not null,
    'D.2 opens with its own deadline';
  assert pg_temp.cell(2, 1, 'D') = 'NORMAL', 'nothing pending any more: D is no longer red';
  assert pg_temp.cell(2, 1, 'G') = 'RED', 'G is still waiting';
  assert (select count(*) from submissions where team_id = pg_temp.team_id(1) and status = 'APPROVED' and reward_awarded = 50) = 1;
end $$;
do $$
declare d jsonb := public.admin_team_theme(pg_temp.staff(2), pg_temp.team_id(1), 'D');
begin
  assert d->'questions'->0->>'color' = 'GREEN' and d->'questions'->1->>'state' = 'ACTIVE' and d->'questions'->1->>'color' = 'WHITE';
end $$;
-- retry with the same key: replayed, still ONE approval, ONE reward, ONE progression
do $$
declare j jsonb; c int := pg_temp.coins(1);
begin
  j := pg_temp.approve(pg_temp.staff(2), (select id from submissions where team_id = pg_temp.team_id(1) and question_id = 16 and status = 'APPROVED'), 50);
  assert (j->>'replayed')::boolean;
  assert pg_temp.coins(1) = c and (select count(*) from coin_transactions where team_id = pg_temp.team_id(1) and question_id = 16 and type = 'QUESTION_REWARD') = 1;
end $$;
-- a second approval with a NEW key is refused (nothing left pending) and pays nothing
select pg_temp.rejects($s$select pg_temp.approve(pg_temp.staff(2), (select id from submissions where team_id = pg_temp.team_id(1) and question_id = 16 and status = 'APPROVED'), 51)$s$, 'SUBMISSION_NOT_PENDING');
do $$ begin
  assert (select count(*) from coin_transactions where team_id = pg_temp.team_id(1) and question_id = 16 and type = 'QUESTION_REWARD') = 1;
  assert (select count(*) from app.invariant_coin_balance_mismatch) = 0;
end $$;

-- ===== 6. the reward is configuration, not code: a question-level value is what gets paid ==========================
select pg_temp.at('2026-12-02 09:08:00+00');
update questions set reward_coins = 75 where id = 31;           -- G.1 configured to 75 BEFORE approval
do $$
declare c int := pg_temp.coins(1);
begin
  perform pg_temp.approve(pg_temp.staff(2), pg_temp.sub(1, 31), 52);
  assert pg_temp.coins(1) = c + 75, 'the approval pays the configured question reward';
  assert (select amount from coin_transactions where team_id = pg_temp.team_id(1) and question_id = 31 and type = 'QUESTION_REWARD') = 75;
  assert (select reward_awarded from submissions where team_id = pg_temp.team_id(1) and question_id = 31 and status = 'APPROVED') = 75;
  assert pg_temp.cell(2, 1, 'G') = 'NORMAL';
end $$;
update questions set reward_coins = 50 where id = 31;
do $$ begin
  assert (select count(*) from questions where reward_coins <> 50) = 0, 'every seeded question is configured to 50';
end $$;

-- ===== 7. disapproval: no reward, back to ACTIVE (not red), resubmission possible ==================================
select pg_temp.at('2026-12-02 09:09:00+00');
select pg_temp.submit(1, 1, 17, 'wrong answer', 53);            -- D.2
do $$ begin assert pg_temp.cell(2, 1, 'D') = 'RED'; end $$;
do $$
declare c int := pg_temp.coins(1);
begin
  perform pg_temp.disapprove(pg_temp.staff(2), pg_temp.sub(1, 17), 54);
  assert pg_temp.coins(1) = c, 'no reward for a disapproval';
  assert (select count(*) from coin_transactions where team_id = pg_temp.team_id(1) and question_id = 17 and type = 'QUESTION_REWARD') = 0;
  assert (pg_temp.tq(1, 17)).state = 'ACTIVE';
  assert pg_temp.cell(2, 1, 'D') = 'NORMAL', 'the red cell disappears when nothing is pending';
  assert public.admin_team_theme(pg_temp.staff(2), pg_temp.team_id(1), 'D')->'questions'->1->>'color' = 'WHITE';
end $$;
select pg_temp.submit(1, 3, 17, 'right answer', 55);            -- resubmission after a disapproval
do $$ begin assert pg_temp.cell(2, 1, 'D') = 'RED'; end $$;

-- ===== 8. theme completion: five approvals make the cell GREEN (not before) =========================================
select pg_temp.approve(pg_temp.staff(2), pg_temp.sub(1, 17), 56);                    -- D.2 approved
do $$ begin assert pg_temp.cell(2, 1, 'D') = 'NORMAL'; end $$;
select pg_temp.at('2026-12-02 09:10:00+00');
select pg_temp.submit(1, 1, 18, 'd3', 57);  select pg_temp.approve(pg_temp.staff(2), pg_temp.sub(1, 18), 58);
select pg_temp.submit(1, 1, 19, 'd4', 59);  select pg_temp.approve(pg_temp.staff(2), pg_temp.sub(1, 19), 60);
do $$ begin
  assert pg_temp.cell(2, 1, 'D') = 'NORMAL', 'four of five approved: not green yet';
  assert (select (c->>'approved')::int from jsonb_array_elements(pg_temp.row(2, 1)->'themes') c where c->>'code' = 'D') = 4;
end $$;
select pg_temp.submit(1, 1, 20, 'd5', 61);
do $$ begin assert pg_temp.cell(2, 1, 'D') = 'RED'; end $$;
select pg_temp.approve(pg_temp.staff(2), pg_temp.sub(1, 20), 62);
do $$
declare d jsonb := public.admin_team_theme(pg_temp.staff(2), pg_temp.team_id(1), 'D');
begin
  assert pg_temp.cell(2, 1, 'D') = 'GREEN', 'all five approved: the theme cell is GREEN';
  assert (select bool_and(q->>'color' = 'GREEN') from jsonb_array_elements(d->'questions') q);
  assert pg_temp.cell(2, 1, 'A') = 'NORMAL', 'an unrelated unlocked theme stays NORMAL';
end $$;

-- ===== 9. Final Submit column follows the team status; reads never write ===========================================
do $$ begin assert (pg_temp.row(2, 1)->>'final_submitted')::boolean = false; end $$;
update teams set status = 'FINAL_SUBMITTED', final_submitted_at = app.now(), final_submitted_by = pg_temp.member_id(1, 1),
                 ended_at = app.now() where id = pg_temp.team_id(1);
do $$ begin
  assert (pg_temp.row(2, 1)->>'final_submitted')::boolean = true and pg_temp.row(2, 1)->>'status' = 'FINAL_SUBMITTED';
end $$;
do $$
declare v bigint := (select state_version from teams where id = pg_temp.team_id(1));
        a int := (select count(*) from audit_events);
        s timestamptz := (select max(updated_at) from sessions);
begin
  perform public.admin_matrix(pg_temp.staff(2));
  perform public.admin_team_theme(pg_temp.staff(2), pg_temp.team_id(1), 'D');
  assert (select state_version from teams where id = pg_temp.team_id(1)) = v and (select count(*) from audit_events) = a,
    'the matrix reads change nothing';
  assert (select max(updated_at) from sessions) is not distinct from s, 'and do not even touch presence';
end $$;

-- ===== 10. privileges: service_role only; the old temporary queue is gone ==========================================
do $$
declare f text;
begin
  foreach f in array array['public.admin_matrix(uuid)', 'public.admin_team_theme(uuid,uuid,text)',
                            'app.require_owner_admin(uuid,uuid)', 'app.presence_timeout_seconds()']
  loop
    assert not has_function_privilege('anon', f, 'execute') and not has_function_privilege('authenticated', f, 'execute'),
      f || ' must not be callable by anon/authenticated';
    assert has_function_privilege('service_role', f, 'execute'), f || ' must be callable by service_role';
  end loop;
  assert to_regprocedure('public.list_pending_submissions(uuid)') is null, 'the temporary B13 queue is removed';
end $$;

rollback;

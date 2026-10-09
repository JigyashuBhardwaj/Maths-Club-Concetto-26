-- B16 / migration 18: the UFM penalty. Official score 0 + team frozen, as an override: gameplay history is never touched.
-- Owner ADMIN only; atomic, idempotent, audited. The multi-connection races are in concurrency/leaderboard.concurrency.mjs.
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
create function pg_temp.final(t int, n int) returns jsonb language sql as
  $$ select public.final_submit(pg_temp.team_id(t), pg_temp.member_id(t, 1), true, pg_temp.key(n)) $$;
create function pg_temp.pen(who int, t int, n int) returns jsonb language sql as
  $$ select public.penalize_team(pg_temp.staff(who), pg_temp.team_id(t), pg_temp.key(n)) $$;
create function pg_temp.score(t int) returns int language sql as
  $$ select official_score from app.team_scores(app.now(), pg_temp.team_id(t)) $$;
create function pg_temp.board() returns text language sql as
  $$ select string_agg(team_code, ',' order by rank_no) from app.leaderboard_rows(app.now()) $$;
create function pg_temp.hist(t int) returns text language sql as
  $$ select (select count(*) from submissions where team_id = pg_temp.team_id(t)) || '/'
         || (select count(*) from coin_transactions where team_id = pg_temp.team_id(t)) || '/'
         || (select string_agg(question_id || state::text, ',' order by question_id) from team_questions where team_id = pg_temp.team_id(t)) $$;
create function pg_temp.audits(ev text, t int) returns bigint language sql as
  $$ select count(*) from audit_events where event_type = ev and team_id = pg_temp.team_id(t) $$;

-- Teams 3 (never starts) and 4 (used for the pause case); both owned by admin 1 (staff 2).
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
values ('00000000-0000-0000-0000-0000000000b3', 'T03', 'Test Team 3', 'test_team_03', 'TEST-NOT-A-HASH', '00000000-0000-0000-0000-0000000000a2', 500),
       ('00000000-0000-0000-0000-0000000000b4', 'T04', 'Test Team 4', 'test_team_04', 'TEST-NOT-A-HASH', '00000000-0000-0000-0000-0000000000a2', 500);
insert into team_members (id, team_id, slot, admission_no)
select ('00000000-0000-0000-0000-00000000c' || n || '0' || s)::uuid, ('00000000-0000-0000-0000-0000000000b' || n)::uuid, s, 'TEST' || n || s
  from generate_series(3, 4) n cross join generate_series(1, 4) s;
insert into coin_transactions (team_id, type, amount, balance_after, created_at)
select ('00000000-0000-0000-0000-0000000000b' || n)::uuid, 'INITIAL_GRANT', 500, 500, now() from generate_series(3, 4) n;

select pg_temp.status('open', 1);
select pg_temp.start(1, 2), pg_temp.start(2, 3), pg_temp.start(4, 4);
select pg_temp.at('2026-12-01 12:01:00+00');
select pg_temp.unlock(1, 1, 10), pg_temp.unlock(2, 1, 11), pg_temp.unlock(4, 1, 12);
select pg_temp.at('2026-12-01 12:02:00+00');
select pg_temp.enter(1, 1, 13), pg_temp.enter(2, 1, 14);
select pg_temp.at('2026-12-01 12:03:00+00');
select pg_temp.submit(1, 1, 15), pg_temp.submit(2, 1, 16);                              -- Q1 of teams 1 and 2 wait for review
select pg_temp.at('2026-12-01 12:10:00+00');

-- ===== 1. authorization ===============================================================================================
select pg_temp.rejects($s$select pg_temp.pen(3, 1, 100)$s$, 'NOT_FOUND');              -- an admin that does not own the team
select pg_temp.rejects($s$select pg_temp.pen(1, 1, 100)$s$, 'FORBIDDEN');              -- the Super Admin gets no penalty
select pg_temp.rejects($s$select public.penalize_team(pg_temp.member_id(1, 1), pg_temp.team_id(1), pg_temp.key(100))$s$, 'FORBIDDEN');   -- a participant
select pg_temp.rejects($s$select public.penalize_team(null, pg_temp.team_id(1), pg_temp.key(100))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.penalize_team(gen_random_uuid(), pg_temp.team_id(1), pg_temp.key(100))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.penalize_team(pg_temp.staff(2), gen_random_uuid(), pg_temp.key(100))$s$, 'NOT_FOUND');
select pg_temp.rejects($s$select public.penalize_team(pg_temp.staff(2), null, pg_temp.key(100))$s$, 'NOT_FOUND');
select pg_temp.rejects($s$select public.penalize_team(pg_temp.staff(2), pg_temp.team_id(1), null)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select pg_temp.pen(2, 3, 100)$s$, 'TEAM_NOT_STARTED');        -- nothing to penalise before the team starts
update staff_users set is_active = false where id = pg_temp.staff(2);
select pg_temp.rejects($s$select pg_temp.pen(2, 1, 100)$s$, 'FORBIDDEN');               -- a disabled admin
update staff_users set is_active = true where id = pg_temp.staff(2);
do $$ begin
  assert (select count(*) = 0 from teams where ufm_penalized_at is not null), 'every refusal left everything untouched';
  assert (select count(*) = 0 from audit_events where event_type = 'UFM_PENALIZED');
end $$;

-- ===== 2. "Yes": official 0, frozen, history intact ==================================================================
create temp table before as select pg_temp.hist(1) as hist, pg_temp.hist(2) as hist2,
       (select state_version from teams where id = pg_temp.team_id(1)) as v, pg_temp.score(1) as live, pg_temp.score(2) as other;
do $$ begin
  assert (select live from before) = 350 and (select other from before) = 350, 'before the penalty: 400 coins - 10 min x 5';
end $$;
create temp table pj as select pg_temp.pen(2, 1, 101) as j;
do $$
declare j jsonb := (select j from pj); t teams%rowtype;
begin
  select * into t from teams where id = pg_temp.team_id(1);
  assert not (j->>'replayed')::boolean and (j->>'changed')::boolean and (j->'team'->>'official_score')::int = 0, j::text;
  assert j->'team'->>'status' = 'ENDED' and j->'team'->>'team_code' = 'T01';
  assert t.status = 'ENDED' and t.ended_at = timestamptz '2026-12-01 12:10:00+00', 'a running team is ended at the penalty instant';
  assert t.ufm_penalized_at = t.ended_at and t.ufm_penalized_by = pg_temp.staff(2);
  assert t.state_version = (select v from before) + 1, 'a version bump tells the participants';
  assert pg_temp.score(1) = 0, 'official score is 0';
  assert t.final_score = (select live from before) and t.final_score <> 0, 'the gameplay score (frozen) is kept: ' || t.final_score;
  assert pg_temp.hist(1) = (select hist from before), 'answers, submissions, ledger and question states are untouched: ' || pg_temp.hist(1);
  assert pg_temp.hist(2) = (select hist2 from before) and pg_temp.score(2) = (select other from before), 'other teams are untouched';
  assert pg_temp.audits('UFM_PENALIZED', 1) = 1 and pg_temp.audits('TEAM_ENDED', 1) = 1;
  assert (select actor_kind = 'STAFF' and staff_id = pg_temp.staff(2) and payload->>'previous_status' = 'RUNNING'
                 and (payload->>'official_score')::int = 0 and (payload->>'gameplay_score')::int = t.final_score
                 and request_id = pg_temp.key(101)
            from audit_events where event_type = 'UFM_PENALIZED' and team_id = t.id);
  assert (select payload->>'reason' = 'UFM_PENALTY' from audit_events where event_type = 'TEAM_ENDED' and team_id = t.id);
end $$;

-- the penalised team can no longer play (every participant mutation is refused), but can still read
select pg_temp.rejects($s$select pg_temp.submit(1, 1, 110)$s$, 'TEAM_ENDED');
select pg_temp.rejects($s$select pg_temp.enter(1, 2, 111)$s$, 'TEAM_ENDED');
select pg_temp.rejects($s$select pg_temp.unlock(1, 2, 112)$s$, 'TEAM_ENDED');
select pg_temp.rejects($s$select pg_temp.final(1, 113)$s$, 'TEAM_ENDED');
select pg_temp.rejects($s$select public.buy_hint(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint, 2::smallint, pg_temp.key(114))$s$, 'TEAM_ENDED');
select pg_temp.rejects($s$select public.save_draft(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint, 'x', 1, '')$s$, 'TEAM_ENDED');
do $$ begin
  assert (public.get_team_state(pg_temp.team_id(1), pg_temp.member_id(1, 1))->'team'->>'frozen')::boolean, 'the snapshot reports frozen';
  assert pg_temp.hist(1) = (select hist from before), 'the refused attempts changed nothing';
end $$;

-- ===== 3. idempotency =================================================================================================
do $$ declare j jsonb; v bigint := (select state_version from teams where id = pg_temp.team_id(1));
begin
  j := pg_temp.pen(2, 1, 101);                                                            -- same key: the stored answer
  assert (j->>'replayed')::boolean and (j->>'changed')::boolean, 'the replay repeats the original answer: ' || j::text;
  j := pg_temp.pen(2, 1, 120);                                                            -- a new key, already penalised
  assert not (j->>'replayed')::boolean and not (j->>'changed')::boolean and (j->'team'->>'official_score')::int = 0, j::text;
  assert pg_temp.audits('UFM_PENALIZED', 1) = 1 and pg_temp.audits('TEAM_ENDED', 1) = 1, 'still one audit row';
  assert (select state_version from teams where id = pg_temp.team_id(1)) = v, 'no second version bump';
end $$;
select pg_temp.rejects($s$select pg_temp.pen(2, 4, 101)$s$, 'IDEMPOTENCY_KEY_REUSED');   -- the key belongs to another team

-- ===== 4. the board and late approvals ================================================================================
do $$ begin
  assert pg_temp.board() = 'T02,T04,T01,T03', 'started teams by score, the penalised team (0) below them, the unstarted team last: ' || pg_temp.board();
  assert (select rank_no from app.leaderboard_rows(app.now()) where team_code = 'T01') > (select rank_no from app.leaderboard_rows(app.now()) where team_code = 'T02'),
         'the penalised team ranks below a team that kept its score';
end $$;
select pg_temp.at('2026-12-01 12:30:00+00');
select pg_temp.approve(2, 1, 1, 130);                                                     -- a pending answer is approved afterwards
do $$ begin
  assert (select coins = 400 + 50 from teams where id = pg_temp.team_id(1)), 'the approval still pays (B14)';
  assert pg_temp.score(1) = 0 and (select final_score = (select live from before) from teams where id = pg_temp.team_id(1)), 'official 0, gameplay snapshot frozen';
end $$;

-- ===== 5. a team that already finished: only the mark is added =========================================================
select pg_temp.at('2026-12-01 12:40:00+00');
select pg_temp.final(2, 140);
do $$ declare fs int := (select final_score from teams where id = pg_temp.team_id(2)); j jsonb; v bigint := (select state_version from teams where id = pg_temp.team_id(2));
begin
  j := pg_temp.pen(3, 2, 141);                                                            -- team 2 belongs to admin 2 (staff 3)
  assert (j->>'changed')::boolean and j->'team'->>'status' = 'FINAL_SUBMITTED', j::text;
  assert pg_temp.score(2) = 0 and (select final_score = fs and status = 'FINAL_SUBMITTED' and ended_at = final_submitted_at from teams where id = pg_temp.team_id(2));
  assert pg_temp.audits('TEAM_ENDED', 2) = 0 and pg_temp.audits('UFM_PENALIZED', 2) = 1, 'no second ending';
  assert (select state_version = v + 1 from teams where id = pg_temp.team_id(2));
end $$;

-- ===== 6. during a pause: ended at the pause instant ==================================================================
select pg_temp.at('2026-12-01 13:00:00+00');
select pg_temp.status('pause', 150);
select pg_temp.at('2026-12-01 13:30:00+00');
select pg_temp.pen(2, 4, 151);
do $$ begin
  assert (select status = 'ENDED' and ended_at = timestamptz '2026-12-01 13:00:00+00' and final_minutes_taken = 60 from teams where id = pg_temp.team_id(4)),
         'the pause instant is the end, and the pause is not charged';
end $$;
select pg_temp.status('resume', 152);

-- ===== 7. the override is permanent and well-formed ===================================================================
select pg_temp.rejects($s$update teams set ufm_penalized_at = null, ufm_penalized_by = null where id = pg_temp.team_id(1)$s$, 'UFM_PENALTY_IMMUTABLE');
select pg_temp.rejects($s$update teams set ufm_penalized_by = pg_temp.staff(3) where id = pg_temp.team_id(1)$s$, 'UFM_PENALTY_IMMUTABLE');
select pg_temp.rejects($s$update teams set ufm_penalized_at = now(), ufm_penalized_by = pg_temp.staff(2) where id = pg_temp.team_id(3)$s$, 'teams_ufm_penalty_terminal');
select pg_temp.rejects($s$update teams set ufm_penalized_at = now() where id = pg_temp.team_id(3)$s$, 'teams_ufm_penalty_paired');
select pg_temp.rejects($s$update teams set final_score = null where id = pg_temp.team_id(1)$s$, 'teams_final_cache_paired');

-- ===== 8. My Teams shows the state; privileges =====================================================================
do $$ begin
  assert (select (x->>'ufm_penalized')::boolean from jsonb_array_elements(public.admin_matrix(pg_temp.staff(2))->'teams') x where x->>'team_code' = 'T01');
  assert (select not (x->>'ufm_penalized')::boolean from jsonb_array_elements(public.admin_matrix(pg_temp.staff(2))->'teams') x where x->>'team_code' = 'T03');
end $$;
do $$
declare r record; n int := 0;
begin
  for r in select p.oid, p.proacl, p.oid::regprocedure::text as sig, p.prosecdef
             from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where (ns.nspname = 'public' and p.proname in ('penalize_team', 'get_team_leaderboard', 'get_leaderboard'))
               or (ns.nspname = 'app' and p.proname in ('team_scores', 'freeze_final_score', 'leaderboard_rows', 'compute_score'))
  loop
    n := n + 1;
    assert r.proacl is not null, r.sig || ': ACL must be explicit';
    assert not exists (select 1 from aclexplode(r.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'), r.sig || ': PUBLIC';
    assert not has_function_privilege('anon', r.oid, 'execute') and not has_function_privilege('authenticated', r.oid, 'execute'), r.sig || ': browser role';
    assert has_function_privilege('service_role', r.oid, 'execute'), r.sig || ': service_role';
    assert r.sig not like 'public.%' or r.prosecdef, r.sig || ': SECURITY DEFINER';
  end loop;
  assert n = 7, 'catalog check saw all functions (' || n || ')';
end $$;

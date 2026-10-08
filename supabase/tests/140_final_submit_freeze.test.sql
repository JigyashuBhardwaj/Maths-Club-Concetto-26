-- B15 / migration 17: final_submit and the terminal team freeze. A team that submits (FINAL_SUBMITTED) and a team whose timer
-- reaches zero (ENDED) must be frozen in exactly the same way, and the freeze must survive logout / login because it is only
-- database state. The multi-connection races are in supabase/tests/concurrency/team_economy.concurrency.mjs.
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
create function pg_temp.q(t int, s int, q int) returns jsonb language sql as
  $$ select public.get_question_for_team(pg_temp.team_id(t), pg_temp.member_id(t, s), q::smallint)->'question' $$;
create function pg_temp.submit(t int, s int, q int, a text, n int) returns jsonb language sql as
  $$ select public.submit_answer(pg_temp.team_id(t), pg_temp.member_id(t, s), q::smallint, a, 'because', pg_temp.key(n)) $$;
create function pg_temp.approve(who uuid, sub uuid, n int) returns jsonb language sql as
  $$ select public.approve_submission(who, sub, pg_temp.key(n)) $$;
create function pg_temp.disapprove(who uuid, sub uuid, n int) returns jsonb language sql as
  $$ select public.disapprove_submission(who, sub, 'try again', pg_temp.key(n)) $$;
create function pg_temp.state(t int, s int) returns jsonb language sql as
  $$ select public.get_team_state(pg_temp.team_id(t), pg_temp.member_id(t, s)) $$;
create function pg_temp.tq(t int, q int) returns team_questions language sql as
  $$ select * from team_questions where team_id = pg_temp.team_id(t) and question_id = q $$;
create function pg_temp.coins(t int) returns int language sql as $$ select coins from teams where id = pg_temp.team_id(t) $$;
create function pg_temp.tv(t int) returns bigint language sql as $$ select state_version from teams where id = pg_temp.team_id(t) $$;
create function pg_temp.sub(t int, q int) returns uuid language sql as
  $$ select id from submissions where team_id = pg_temp.team_id(t) and question_id = q and status = 'PENDING' $$;
create function pg_temp.hint(t int, s int, q int, tier int, n int) returns jsonb language sql as
  $$ select public.buy_hint(pg_temp.team_id(t), pg_temp.member_id(t, s), q::smallint, tier::smallint, pg_temp.key(n)) $$;
create function pg_temp.time(t int, s int, q int, opt int, expected int, n int) returns jsonb language sql as
  $$ select public.buy_time(pg_temp.team_id(t), pg_temp.member_id(t, s), q::smallint, opt::smallint, expected, pg_temp.key(n)) $$;
create function pg_temp.final(t int, s int, n int) returns jsonb language sql as
  $$ select public.final_submit(pg_temp.team_id(t), pg_temp.member_id(t, s), true, pg_temp.key(n)) $$;
create function pg_temp.draft(t int, s int, q int, a text, v int) returns jsonb language sql as
  $$ select public.save_draft(pg_temp.team_id(t), pg_temp.member_id(t, s), q::smallint, a, v, '') $$;

-- one function for "play the same game on a team": theme 1 and 2 unlocked, Q1 submitted and waiting for review,
-- Hint 1 of Q1 bought, Q6 entered and submitted too (a second pending answer), Q7 locked. At 12:05 / 12:06.
create function pg_temp.play(t int, base int) returns void language plpgsql as $$
begin
  perform pg_temp.at('2026-12-01 12:01:00+00');
  perform pg_temp.unlock(t, 1, 1, base + 1);
  perform pg_temp.unlock(t, 2, 2, base + 2);
  perform pg_temp.enter(t, 1, 1, base + 3);
  perform pg_temp.hint(t, 1, 1, 1, base + 4);
  perform pg_temp.at('2026-12-01 12:02:00+00');
  perform pg_temp.submit(t, 1, 1, 'ans1', base + 5);                     -- Q1 PENDING_APPROVAL
  perform pg_temp.at('2026-12-01 12:05:00+00');
  perform pg_temp.enter(t, 1, 6, base + 6);                              -- Q6 ACTIVE, deadline 12:09
  perform pg_temp.at('2026-12-01 12:06:00+00');
  perform pg_temp.submit(t, 1, 6, 'ans6', base + 7);                     -- Q6 PENDING_APPROVAL, 180 s frozen
end $$;

select pg_temp.status('open', 1);
select pg_temp.at('2026-12-01 12:00:00+00');
select pg_temp.start(1, 1, 2);
select pg_temp.start(2, 1, 3);
select pg_temp.play(1, 100);
select pg_temp.play(2, 200);

-- ===== 1. refusals ===================================================================================================
select pg_temp.at('2026-12-01 12:30:00+00');
select pg_temp.rejects($s$select public.final_submit(pg_temp.team_id(1), pg_temp.member_id(1, 1), false, pg_temp.key(300))$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.final_submit(pg_temp.team_id(1), pg_temp.member_id(1, 1), null, pg_temp.key(300))$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.final_submit(pg_temp.team_id(1), pg_temp.member_id(1, 1), true, null)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.final_submit(pg_temp.team_id(1), pg_temp.member_id(2, 1), true, pg_temp.key(300))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.final_submit(null, null, true, pg_temp.key(300))$s$, 'FORBIDDEN');
do $$ begin
  assert (select status = 'RUNNING' and final_submitted_at is null from teams where id = pg_temp.team_id(1)), 'refusals leave the team running';
  assert not (pg_temp.state(1, 1)->'team'->>'frozen')::boolean;
end $$;
-- a paused competition cannot be final-submitted
select pg_temp.status('pause', 4);
select pg_temp.rejects($s$select pg_temp.final(1, 1, 301)$s$, 'COMPETITION_PAUSED');
select pg_temp.status('resume', 5);

-- ===== 2. the freeze =================================================================================================
create temp table pre as select pg_temp.tv(1) as v, pg_temp.coins(1) as coins,
  (select count(*) from coin_transactions where team_id = pg_temp.team_id(1)) as ledger,
  (select ends_at from teams where id = pg_temp.team_id(1)) as ends_at;
select pg_temp.at('2026-12-01 13:00:00+00');
create temp table fs as select pg_temp.final(1, 3, 310) as j;
do $$
declare j jsonb := (select j from fs); t teams%rowtype; s jsonb;
begin
  assert not (j->>'replayed')::boolean;
  select * into t from teams where id = pg_temp.team_id(1);
  assert t.status = 'FINAL_SUBMITTED' and t.ended_at = timestamptz '2026-12-01 13:00:00+00' and t.final_submitted_at = t.ended_at
         and t.final_submitted_by = pg_temp.member_id(1, 3), 'terminal, with who and when';
  assert t.ends_at = (select ends_at from pre) and t.timer_seconds = 14400, 'the schedule itself is not rewritten';
  assert t.coins = (select coins from pre) and (select count(*) from coin_transactions where team_id = t.id) = (select ledger from pre), 'no coin moved';
  assert t.state_version = (select v from pre) + 1;
  assert t.final_score is null and t.final_completed_themes is null and t.final_solved_questions is null and t.final_minutes_taken is null,
         'scores are B16: nothing is computed here';
  s := j->'state';
  assert s->'team'->>'status' = 'FINAL_SUBMITTED' and (s->'team'->>'frozen')::boolean and not (s->'team'->>'expired')::boolean;
  assert (s->'team'->>'remaining_seconds')::int = 10800, '16:00 - 13:00, frozen';
  assert (select count(*) = 1 and (min(payload->>'pending_submissions'))::int = 2 and (min(payload->>'active_questions'))::int = 0
            and min(actor_kind) = 'MEMBER' and min(request_id::text) = pg_temp.key(310)::text
            from audit_events where event_type = 'TEAM_FINAL_SUBMITTED' and team_id = pg_temp.team_id(1));
  -- the pending answers were left alone
  assert (pg_temp.tq(1, 1)).state = 'PENDING_APPROVAL' and (pg_temp.tq(1, 6)).state = 'PENDING_APPROVAL';
end $$;
-- a teammate, a retry and a second click
select pg_temp.rejects($s$select pg_temp.final(1, 1, 311)$s$, 'ALREADY_SUBMITTED');
do $$ declare j jsonb; v bigint := pg_temp.tv(1);
begin
  j := pg_temp.final(1, 3, 310);                                                      -- same key, same member
  assert (j->>'replayed')::boolean and j->'state'->'team'->>'status' = 'FINAL_SUBMITTED' and pg_temp.tv(1) = v;
  assert (select count(*) from audit_events where event_type = 'TEAM_FINAL_SUBMITTED' and team_id = pg_temp.team_id(1)) = 1;
end $$;
select pg_temp.rejects($s$select pg_temp.final(1, 1, 310)$s$, 'IDEMPOTENCY_KEY_REUSED');   -- another member, the same key

-- ===== 3. every participant mutation is refused and writes nothing ====================================================
select pg_temp.at('2026-12-01 14:00:00+00');
create temp table frozen_before as select pg_temp.tv(1) as v, pg_temp.coins(1) as coins, (select count(*) from request_log) as logs,
  (select count(*) from audit_events where team_id = pg_temp.team_id(1)) as audits;
select pg_temp.rejects($s$select pg_temp.unlock(1, 1, 3, 320)$s$, 'ALREADY_SUBMITTED');
select pg_temp.rejects($s$select pg_temp.enter(1, 1, 2, 321)$s$, 'ALREADY_SUBMITTED');
select pg_temp.rejects($s$select pg_temp.draft(1, 1, 6, 'x', 0)$s$, 'ALREADY_SUBMITTED');
select pg_temp.rejects($s$select pg_temp.submit(1, 1, 6, 'x', 322)$s$, 'ALREADY_SUBMITTED');
select pg_temp.rejects($s$select pg_temp.hint(1, 1, 1, 2, 323)$s$, 'ALREADY_SUBMITTED');
select pg_temp.rejects($s$select pg_temp.time(1, 1, 6, 16, 0, 324)$s$, 'ALREADY_SUBMITTED');
select pg_temp.rejects($s$select pg_temp.start(1, 2, 325)$s$, 'ALREADY_SUBMITTED');
select pg_temp.rejects($s$select pg_temp.final(1, 2, 326)$s$, 'ALREADY_SUBMITTED');
do $$ declare r jsonb; f frozen_before%rowtype;
begin
  select * into f from frozen_before;
  assert pg_temp.tv(1) = f.v and pg_temp.coins(1) = f.coins and (select count(*) from request_log) = f.logs
         and (select count(*) from audit_events where team_id = pg_temp.team_id(1)) = f.audits, 'no refusal wrote anything';
  r := public.finalize_team_if_due(pg_temp.team_id(1));                                -- a submitted team is not "due"
  assert not (r->>'finalized')::boolean and r->>'status' = 'FINAL_SUBMITTED' and pg_temp.tv(1) = f.v;
  assert (select status = 'FINAL_SUBMITTED' from teams where id = pg_temp.team_id(1));
end $$;

-- ===== 4. reads keep working and the clock stays frozen ===============================================================
create function pg_temp.norm(t int) returns jsonb language sql as $$ select pg_temp.state(t, 1) - 'server_now' $$;
select pg_temp.at('2026-12-01 14:00:00+00');
create temp table snap1 as select pg_temp.norm(1) as j;
select pg_temp.at('2026-12-01 23:30:00+00');
do $$
declare q jsonb;
begin
  assert pg_temp.norm(1) = (select j from snap1), 'the snapshot is identical hours later (nothing runs on a frozen team)';
  assert (pg_temp.state(1, 1)->'team'->>'remaining_seconds')::int = 10800 and (pg_temp.state(1, 1)->'team'->>'frozen')::boolean;
  q := pg_temp.q(1, 2, 1);
  assert q->>'state' = 'PENDING_APPROVAL', 'the question is still readable';
  assert (q->'hints'->0->>'owned')::boolean and q->'hints'->0->>'body_md' like '%Hint 1 for question 1%', 'an owned hint stays readable';
  assert not (q->'hints'->1->>'purchasable')::boolean and not (q->'buy_time'->>'can_buy')::boolean, 'nothing can be bought';
end $$;

-- ===== 5. answers already waiting stay reviewable (DEC-03): the reward is paid once, the next question stays closed ====
create temp table rv as select pg_temp.coins(1) as c, pg_temp.tv(1) as v;
select pg_temp.at('2026-12-01 20:00:00+00');
do $$
declare j jsonb;
begin
  j := pg_temp.approve(pg_temp.staff(2), pg_temp.sub(1, 1), 330);
  assert (j->>'reward_awarded')::int = 50 and not (j->>'next_question_activated')::boolean, 'no next question on a frozen team';
  assert pg_temp.coins(1) = (select c from rv) + 50 and (pg_temp.tq(1, 1)).state = 'APPROVED' and (pg_temp.tq(1, 2)).state = 'LOCKED';
  assert (select count(*) from coin_transactions where team_id = pg_temp.team_id(1) and type = 'QUESTION_REWARD') = 1;
  j := pg_temp.approve(pg_temp.staff(2), (select id from submissions where team_id = pg_temp.team_id(1) and question_id = 1), 330);
  assert (j->>'replayed')::boolean and pg_temp.coins(1) = (select c from rv) + 50, 'a retry does not pay twice';
  assert (select status = 'FINAL_SUBMITTED' from teams where id = pg_temp.team_id(1)), 'approval does not revive the team';
end $$;
select pg_temp.rejects($s$select pg_temp.approve(pg_temp.staff(2), (select id from submissions where team_id = pg_temp.team_id(1) and question_id = 1), 331)$s$, 'SUBMISSION_NOT_PENDING');
-- a rejection on a frozen team gives the question back exactly the seconds it had when the team froze (C7)
select pg_temp.at('2026-12-01 21:00:00+00');
do $$
declare q jsonb;
begin
  perform pg_temp.disapprove(pg_temp.staff(2), pg_temp.sub(1, 6), 332);
  assert (pg_temp.tq(1, 6)).state = 'ACTIVE' and (pg_temp.tq(1, 6)).timer_deadline = timestamptz '2026-12-01 13:03:00+00', 'deadline = the freeze instant + 180 s';
  q := pg_temp.q(1, 1, 6);
  assert q->>'state' = 'ACTIVE' and (q->>'remaining_seconds')::int = 180, 'frozen at the 180 s it had, not 180 s after the rejection';
  perform pg_temp.at('2026-12-01 23:59:00+00');
  assert (pg_temp.q(1, 1, 6)->>'remaining_seconds')::int = 180, 'and it never moves';
  assert (select status = 'FINAL_SUBMITTED' from teams where id = pg_temp.team_id(1));
end $$;
select pg_temp.rejects($s$select pg_temp.submit(1, 1, 6, 'again', 333)$s$, 'ALREADY_SUBMITTED');

-- ===== 6. the timer reaching zero freezes a team in exactly the same way ==============================================
select pg_temp.at('2026-12-01 16:00:00+00');
do $$ declare r jsonb; begin
  r := public.finalize_team_if_due(pg_temp.team_id(2));
  assert (r->>'finalized')::boolean;
  assert (select status = 'ENDED' and ended_at = ends_at and final_submitted_at is null from teams where id = pg_temp.team_id(2));
end $$;
select pg_temp.at('2026-12-01 17:00:00+00');
create temp table frozen2 as select pg_temp.tv(2) as v, pg_temp.coins(2) as coins, (select count(*) from request_log) as logs,
  (select count(*) from audit_events where team_id = pg_temp.team_id(2)) as audits, pg_temp.norm(2) as j;
select pg_temp.rejects($s$select pg_temp.unlock(2, 1, 3, 340)$s$, 'TEAM_ENDED');
select pg_temp.rejects($s$select pg_temp.enter(2, 1, 2, 341)$s$, 'TEAM_ENDED');
select pg_temp.rejects($s$select pg_temp.draft(2, 1, 6, 'x', 0)$s$, 'TEAM_ENDED');
select pg_temp.rejects($s$select pg_temp.submit(2, 1, 6, 'x', 342)$s$, 'TEAM_ENDED');
select pg_temp.rejects($s$select pg_temp.hint(2, 1, 1, 2, 343)$s$, 'TEAM_ENDED');
select pg_temp.rejects($s$select pg_temp.time(2, 1, 6, 16, 0, 344)$s$, 'TEAM_ENDED');
select pg_temp.rejects($s$select pg_temp.start(2, 2, 345)$s$, 'TEAM_ENDED');
select pg_temp.rejects($s$select pg_temp.final(2, 2, 346)$s$, 'TEAM_ENDED');
select pg_temp.at('2026-12-01 23:30:00+00');
do $$
declare f frozen2%rowtype; s jsonb := pg_temp.state(2, 1);
begin
  select * into f from frozen2;
  assert pg_temp.tv(2) = f.v and pg_temp.coins(2) = f.coins and (select count(*) from request_log) = f.logs
         and (select count(*) from audit_events where team_id = pg_temp.team_id(2)) = f.audits, 'no refusal wrote anything';
  assert pg_temp.norm(2) = f.j, 'identical snapshot hours later';
  assert (s->'team'->>'frozen')::boolean and not (s->'team'->>'expired')::boolean and (s->'team'->>'remaining_seconds')::int = 0;
  -- both terminal paths are frozen: ended_at set, not RUNNING, no mutation possible, snapshot constant
  assert (select bool_and(ended_at is not null and status in ('FINAL_SUBMITTED', 'ENDED')) from teams);
  -- the same pending answers are reviewable after the timer end too: paid once, nothing opens
  perform pg_temp.approve(pg_temp.staff(3), pg_temp.sub(2, 1), 347);
  assert pg_temp.coins(2) = f.coins + 50 and (pg_temp.tq(2, 2)).state = 'LOCKED' and (select status = 'ENDED' from teams where id = pg_temp.team_id(2));
end $$;
do $$ begin assert not exists (select 1 from app.invariant_coin_balance_mismatch), 'teams.coins equals the ledger'; end $$;
-- privileges
do $$ begin
  assert not has_function_privilege('anon', 'public.final_submit(uuid, uuid, boolean, uuid)', 'execute');
  assert not has_function_privilege('authenticated', 'public.final_submit(uuid, uuid, boolean, uuid)', 'execute');
  assert has_function_privilege('service_role', 'public.final_submit(uuid, uuid, boolean, uuid)', 'execute');
end $$;
rollback;

-- ===== 7. final submit versus the clock ===============================================================================
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
create function pg_temp.final(t int, s int, n int) returns jsonb language sql as
  $$ select public.final_submit(pg_temp.team_id(t), pg_temp.member_id(t, s), true, pg_temp.key(n)) $$;
select public.set_competition_status(pg_temp.staff(1), 'open', pg_temp.key(1));
-- a team that has not started cannot final-submit
select pg_temp.rejects($s$select pg_temp.final(2, 1, 4)$s$, 'TEAM_NOT_STARTED');
select public.start_team_competition(pg_temp.team_id(1), pg_temp.member_id(1, 1), pg_temp.key(2));
select public.start_team_competition(pg_temp.team_id(2), pg_temp.member_id(2, 1), pg_temp.key(3));
-- one millisecond before the end it still works
select pg_temp.at('2026-12-01 15:59:59.999+00');
do $$ declare j jsonb; begin
  j := pg_temp.final(1, 1, 5);
  assert j->'state'->'team'->>'status' = 'FINAL_SUBMITTED' and (j->'state'->'team'->>'remaining_seconds')::int = 0;
  assert (select ended_at = timestamptz '2026-12-01 15:59:59.999+00' from teams where id = pg_temp.team_id(1));
end $$;
-- the instant of the end it does not: that team becomes ENDED, not FINAL_SUBMITTED
select pg_temp.at('2026-12-01 16:00:00+00');
select pg_temp.rejects($s$select pg_temp.final(2, 1, 6)$s$, 'TEAM_ENDED');
do $$ begin
  assert (select status = 'RUNNING' and final_submitted_at is null from teams where id = pg_temp.team_id(2)), 'the refusal wrote nothing';
  perform public.finalize_team_if_due(pg_temp.team_id(2));
  assert (select status = 'ENDED' and final_submitted_at is null and final_submitted_by is null from teams where id = pg_temp.team_id(2));
  assert (select count(*) from audit_events where event_type = 'TEAM_FINAL_SUBMITTED') = 1;
end $$;
rollback;

-- ===== 8. the freeze survives logout and login: it is only database state ============================================
begin;
\ir include/helpers.sql
\ir include/fixture.sql
set app.allow_test_clock = 'on';
set app.test_now = '2026-12-01 12:00:00+00';
create function pg_temp.at(ts text) returns void language plpgsql as $$
begin perform set_config('app.test_now', ts, false); end $$;
create function pg_temp.key(n int) returns uuid language sql as
  $$ select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.tok(n int) returns bytea language sql as $$ select sha256(convert_to('test-token-' || n, 'UTF8')) $$;
create function pg_temp.team_id(t int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-0000000000b' || t)::uuid $$;
create function pg_temp.member_id(t int, s int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-00000000c' || t || '0' || s)::uuid $$;
create function pg_temp.staff(n int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-0000000000a' || n)::uuid $$;
create function pg_temp.plogin(n int) returns jsonb language sql as
  $$ select public.participant_login('test_team_01', 'team-pass-01', 'TEST11', pg_temp.tok(n), '203.0.113.7'::inet, 'test-agent') $$;
create function pg_temp.norm() returns jsonb language sql as
  $$ select public.get_team_state(pg_temp.team_id(1), pg_temp.member_id(1, 1)) - 'server_now' $$;
update teams set password_hash = app.hash_password('team-pass-01') where login_id = 'test_team_01';
select public.set_competition_status(pg_temp.staff(1), 'open', pg_temp.key(1));
do $$ declare j jsonb; begin
  j := pg_temp.plogin(1);
  assert (j->>'ok')::boolean and j->'team'->>'status' = 'NOT_STARTED', 'login does not start the team';
end $$;
select public.start_team_competition(pg_temp.team_id(1), pg_temp.member_id(1, 1), pg_temp.key(2));
select public.unlock_theme(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint, pg_temp.key(3));
select public.start_question(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint, pg_temp.key(4));
select public.buy_hint(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint, 1::smallint, pg_temp.key(5));
select pg_temp.at('2026-12-01 13:00:00+00');
select public.final_submit(pg_temp.team_id(1), pg_temp.member_id(1, 1), true, pg_temp.key(6));
create temp table before_logout as select pg_temp.norm() as j;
-- logout
do $$ begin
  perform public.revoke_session(pg_temp.tok(1));
  assert (select count(*) from sessions where member_id = pg_temp.member_id(1, 1) and revoked_at is null) = 0, 'logged out';
end $$;
-- a day later the same member signs in again: still allowed (login only checks credentials and the competition), and the team is still frozen
select pg_temp.at('2026-12-02 09:00:00+00');
do $$ declare lj jsonb; r jsonb; begin
  lj := pg_temp.plogin(2);
  assert (lj->>'ok')::boolean and lj->'team'->>'status' = 'FINAL_SUBMITTED', 'login reports the frozen team';
  r := public.resolve_session(pg_temp.tok(2));
  assert (r->>'ok')::boolean or r ? 'member', 'the new session resolves';
  assert pg_temp.norm() = (select j from before_logout), 'the snapshot after login is identical to the one before logout';
  assert (pg_temp.norm()->'team'->>'frozen')::boolean and (pg_temp.norm()->'team'->>'remaining_seconds')::int = 10800;
  -- and it is still frozen for every mutation
  begin perform public.unlock_theme(pg_temp.team_id(1), pg_temp.member_id(1, 1), 2::smallint, pg_temp.key(7)); raise exception 'unlock after relogin';
  exception when others then assert sqlerrm = 'ALREADY_SUBMITTED', sqlerrm; end;
  assert (pg_temp.norm()->'themes'->0->'questions'->0->>'state') in ('ACTIVE', 'TIMED_OUT');
end $$;
-- the owned hint is still readable after the round trip
do $$ begin
  assert (public.get_question_for_team(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint)->'question'->'hints'->0->>'body_md') like '%Hint 1 for question 1%';
end $$;
rollback;

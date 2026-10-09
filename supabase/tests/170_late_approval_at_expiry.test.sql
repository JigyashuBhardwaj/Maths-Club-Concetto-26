-- B16 / migration 18: an approval that arrives after the timer ran out but BEFORE anything persisted the ENDED status.
-- The score is fixed at the team's own end (its ends_at); the late reward still pays coins (B14 / DEC-03) but cannot count.
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


select pg_temp.status('open', 1);
select pg_temp.start(1, 2), pg_temp.start(2, 3);
select pg_temp.at('2026-12-01 12:01:00+00');
select pg_temp.unlock(1, 1, 10), pg_temp.unlock(2, 1, 11);
select pg_temp.at('2026-12-01 12:02:00+00');
select pg_temp.enter(1, 1, 12), pg_temp.enter(2, 1, 13);
select pg_temp.at('2026-12-01 12:03:00+00');
select pg_temp.submit(1, 1, 14), pg_temp.submit(2, 1, 15);

-- team 1: approved while still in time (control); team 2: approved 10 s after its timer ran out
select pg_temp.at('2026-12-01 15:59:50+00');
select pg_temp.approve(2, 1, 1, 16);
do $$ begin
  assert pg_temp.score(1) = 100 + 450 - 1200, 'in time: the approval counts (solved 1, coins 450, 240 min): ' || pg_temp.score(1);
  assert (select status = 'RUNNING' from teams where id = pg_temp.team_id(1));
end $$;

select pg_temp.at('2026-12-01 16:00:10+00');                       -- ends_at is 16:00:00; nothing has finalised team 2
do $$ begin
  assert (select status = 'RUNNING' and final_score is null from teams where id = pg_temp.team_id(2)), 'not yet persisted';
  assert pg_temp.score(2) = 400 - 1200, 'derived live: 240 minutes, nothing approved';
end $$;
select pg_temp.approve(3, 2, 1, 17);                                -- the late approval
do $$ declare t teams%rowtype;
begin
  select * into t from teams where id = pg_temp.team_id(2);
  assert t.status = 'ENDED' and t.ended_at = timestamptz '2026-12-01 16:00:00+00', 'ended AT its end, not when the approval ran';
  assert t.coins = 450, 'the reward is paid';
  assert t.final_score = -800 and t.final_solved_questions = 0 and t.final_minutes_taken = 240, 'but the score was fixed before it: ' || t.final_score;
  assert pg_temp.score(2) = -800, 'and the board agrees';
  assert (select state = 'APPROVED' from team_questions where team_id = t.id and question_id = 1), 'history records the approval';
  assert (select count(*) = 1 from audit_events where team_id = t.id and event_type = 'TEAM_ENDED' and payload->>'reason' = 'TIMER');
  assert (select count(*) = 1 from audit_events where team_id = t.id and event_type = 'SUBMISSION_APPROVED');
end $$;
-- the later sweep finds nothing to do and changes nothing
select public.finalize_team_if_due(pg_temp.team_id(2));
select public.expire_due_teams();
do $$ begin
  assert (select count(*) = 1 from audit_events where team_id = pg_temp.team_id(2) and event_type = 'TEAM_ENDED');
  assert pg_temp.score(2) = -800;
end $$;

-- B16 / migration 18: the derived score, its freeze at the terminal moment, and the leaderboard ranking.
--   score = completed_themes × 500 + solved_questions × 100 + remaining_coins − minutes_taken × 5
--   minutes_taken = round((timer_seconds − remaining_seconds) / 60); never stored while a team plays; frozen into teams.final_*
--   at Final Submit and at timer expiry through ONE function. The concurrency proof is supabase/tests/concurrency/leaderboard.concurrency.mjs.
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
create function pg_temp.coins(t int) returns int language sql as $$ select coins from teams where id = pg_temp.team_id(t) $$;
-- the live (or frozen) score of one team, exactly as every read derives it
create function pg_temp.score(t int) returns int language sql as
  $$ select official_score from app.team_scores(app.now(), pg_temp.team_id(t)) $$;
create function pg_temp.mins(t int) returns int language sql as
  $$ select minutes from app.team_scores(app.now(), pg_temp.team_id(t)) $$;
create function pg_temp.board() returns text language sql as
  $$ select string_agg(team_code, ',' order by rank_no) from app.leaderboard_rows(app.now()) $$;

-- four more teams: T10 and T12 never start; T9 and T11 are started and left to expire.
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
select ('00000000-0000-0000-0000-0000000000b' || n)::uuid, c, 'Test Team ' || n, 'test_team_0' || n, 'TEST-NOT-A-HASH',
       '00000000-0000-0000-0000-0000000000a2', 500
  from (values (3, 'T10'), (4, 'T9'), (5, 'T11'), (6, 'T12')) v(n, c);
insert into team_members (id, team_id, slot, admission_no)
select ('00000000-0000-0000-0000-00000000c' || n || '0' || s)::uuid, ('00000000-0000-0000-0000-0000000000b' || n)::uuid, s, 'TEST' || n || s
  from generate_series(3, 6) n cross join generate_series(1, 4) s;
insert into coin_transactions (team_id, type, amount, balance_after, created_at)
select ('00000000-0000-0000-0000-0000000000b' || n)::uuid, 'INITIAL_GRANT', 500, 500, now() from generate_series(3, 6) n;

-- ===== 1. nobody has started: every team shows the formula on its coins; ties break on Team ID (code point) =========
do $$ begin
  assert (select count(*) = 6 and min(official_score) = 500 and max(official_score) = 500 and max(minutes) = 0 from app.team_scores(app.now())),
         'zero progress = coins only';
  assert pg_temp.board() = 'T01,T02,T10,T11,T12,T9', 'equal score, equal minutes: Team ID ascending in code-point order: ' || pg_temp.board();
end $$;

-- ===== 2. started: zero progress, then the time penalty and its rounding ============================================
select pg_temp.status('open', 1);
select pg_temp.start(1, 2), pg_temp.start(2, 3), pg_temp.start(4, 4), pg_temp.start(5, 5);
do $$ begin
  assert pg_temp.score(1) = 500 and pg_temp.mins(1) = 0, 'started, nothing done, no time gone: 500';
  perform pg_temp.at('2026-12-01 12:07:29+00');
  assert pg_temp.mins(1) = 7 and pg_temp.score(1) = 500 - 35, '7 min 29 s rounds down to 7: ' || pg_temp.score(1);
  perform pg_temp.at('2026-12-01 12:07:30+00');
  assert pg_temp.mins(1) = 8 and pg_temp.score(1) = 500 - 40, '7 min 30 s rounds up to 8 (half up)';
  perform pg_temp.at('2026-12-01 12:07:31+00');
  assert pg_temp.mins(1) = 8;
  perform pg_temp.at('2026-12-01 12:00:29+00');
  assert pg_temp.mins(1) = 0 and pg_temp.score(1) = 500, '29 s is 0 minutes';
  perform pg_temp.at('2026-12-01 12:00:30+00');
  assert pg_temp.mins(1) = 1 and pg_temp.score(1) = 495, '30 s is 1 minute';
  -- the score is derived: nothing about it is stored while the team plays
  assert (select final_score is null and final_minutes_taken is null from teams where id = pg_temp.team_id(1)), 'no persisted live score';
end $$;

-- ===== 3. spend: unlocking a theme costs coins ======================================================================
select pg_temp.at('2026-12-01 12:01:00+00');
select pg_temp.unlock(1, 1, 10);                       -- Team 1: theme A (-100)
select pg_temp.unlock(2, 1, 11);                       -- Team 2: theme A (-100); it will then sit idle
do $$ begin
  assert pg_temp.coins(1) = 400 and pg_temp.score(1) = 400 - 5, 'spend lowers the score by exactly the coins: ' || pg_temp.score(1);
end $$;

-- ===== 4. an approved question pays its reward and counts as solved; five approvals complete the theme ==============
select pg_temp.at('2026-12-01 12:11:00+00');
select pg_temp.enter(1, 1, 12);
select pg_temp.at('2026-12-01 12:11:30+00');
select pg_temp.submit(1, 1, 13);
do $$ begin
  assert pg_temp.score(1) = 400 - 60, 'a pending answer changes nothing yet (11.5 min -> 12 min): ' || pg_temp.score(1);
end $$;
select pg_temp.at('2026-12-01 12:12:00+00');
select pg_temp.approve(2, 1, 1, 14);
do $$ begin
  assert pg_temp.coins(1) = 450;
  assert (select solved = 1 and completed = 0 from app.team_scores(app.now(), pg_temp.team_id(1)));
  assert pg_temp.score(1) = 100 + 450 - 60, 'approved: +100 solved, +50 reward coins: ' || pg_temp.score(1);
end $$;
select pg_temp.at('2026-12-01 12:12:30+00');  select pg_temp.submit(1, 2, 15);
select pg_temp.at('2026-12-01 12:13:00+00');  select pg_temp.approve(2, 1, 2, 16);
select pg_temp.at('2026-12-01 12:13:30+00');  select pg_temp.submit(1, 3, 17);
select pg_temp.at('2026-12-01 12:14:00+00');  select pg_temp.approve(2, 1, 3, 18);
select pg_temp.at('2026-12-01 12:14:30+00');  select pg_temp.submit(1, 4, 19);
select pg_temp.at('2026-12-01 12:15:00+00');  select pg_temp.approve(2, 1, 4, 20);
do $$ begin
  assert (select solved = 4 and completed = 0 from app.team_scores(app.now(), pg_temp.team_id(1))), 'four of five: the theme is not complete';
  assert pg_temp.score(1) = 400 + 600 - 75, 'four approvals: 400 + 4 x 50 coins';
end $$;
select pg_temp.at('2026-12-01 12:15:30+00');  select pg_temp.submit(1, 5, 21);
select pg_temp.at('2026-12-01 12:16:00+00');  select pg_temp.approve(2, 1, 5, 22);
do $$ begin
  assert (select solved = 5 and completed = 1 from app.team_scores(app.now(), pg_temp.team_id(1))), 'five of five: theme completed';
  assert pg_temp.coins(1) = 400 + 250;
  assert pg_temp.score(1) = 1570, 'completed theme +500, five solved +500, coins 650, 16 min: ' || pg_temp.score(1);
end $$;

-- ===== 5. pause: the score clock stops with the competition, and the pause is not charged ==========================
select pg_temp.at('2026-12-01 12:20:00+00');
select pg_temp.status('pause', 30);
do $$ begin
  assert pg_temp.mins(1) = 20 and pg_temp.score(1) = 1550, '20 minutes at the instant of the pause';
  perform pg_temp.at('2026-12-01 12:40:00+00');
  assert pg_temp.mins(1) = 20 and pg_temp.score(1) = 1550, 'still 20 minutes 20 minutes later: the pause is not charged';
  assert pg_temp.mins(4) = 20 and pg_temp.score(4) = 500 - 100;
end $$;
select pg_temp.status('resume', 31);
select pg_temp.at('2026-12-01 12:50:00+00');
do $$ begin
  assert pg_temp.mins(1) = 30 and pg_temp.score(1) = 1500, '10 minutes after the resume: 30 minutes taken';
  assert (select ends_at from teams where id = pg_temp.team_id(1)) = timestamptz '2026-12-01 16:20:00+00', 'ends_at was shifted by the pause';
end $$;

-- ===== 6. Final Submit freezes the score; a late approval pays coins but never moves the score ======================
select pg_temp.at('2026-12-01 12:51:00+00');  select pg_temp.unlock(1, 2, 40);          -- theme B (-100): coins 550
select pg_temp.at('2026-12-01 12:52:00+00');  select pg_temp.enter(1, 6, 41);
select pg_temp.at('2026-12-01 12:53:00+00');  select pg_temp.submit(1, 6, 42);          -- Q6 waits for review
select pg_temp.at('2026-12-01 12:55:00+00');
do $$ declare live int := pg_temp.score(1); m int := pg_temp.mins(1);
begin
  assert m = 35 and live = 500 + 500 + 550 - 175, 'live score just before the submit: ' || live;
  perform pg_temp.final(1, 43);
  assert (select status = 'FINAL_SUBMITTED' and final_score = live and final_minutes_taken = 35
                 and final_completed_themes = 1 and final_solved_questions = 5 from teams where id = pg_temp.team_id(1)),
         'Final Submit froze exactly the live score';
end $$;
select pg_temp.at('2026-12-01 13:30:00+00');
select pg_temp.approve(2, 1, 6, 44);                                                    -- late approval
do $$ begin
  assert pg_temp.coins(1) = 600, 'the late approval still pays its coins (B14)';
  assert pg_temp.score(1) = 1375 and pg_temp.mins(1) = 35, 'but the score is frozen: ' || pg_temp.score(1);
  assert (select final_score = 1375 and final_solved_questions = 5 from teams where id = pg_temp.team_id(1)), 'the cache did not move';
  perform pg_temp.at('2026-12-02 03:00:00+00');
  assert pg_temp.score(1) = 1375 and pg_temp.mins(1) = 35, 'no drift hours later';
end $$;

-- ===== 7. timer expiry: the exact 240-minute boundary, negative score, same freeze as Final Submit ================
select pg_temp.at('2026-12-01 16:19:59+00');
do $$ begin
  assert pg_temp.mins(2) = 240 and pg_temp.score(2) = 400 - 1200, 'one second before the end: 239.98 min rounds to 240 (not yet finalised)';
  assert (select status = 'RUNNING' and final_score is null from teams where id = pg_temp.team_id(2));
end $$;
select pg_temp.at('2026-12-01 16:20:00+00');
select public.finalize_team_if_due(pg_temp.team_id(2));
select public.finalize_team_if_due(pg_temp.team_id(2));                                 -- idempotent
select public.expire_due_teams();                                                       -- the sweeper takes T9 and T11
do $$ begin
  assert (select status = 'ENDED' and ended_at = timestamptz '2026-12-01 16:20:00+00' and final_score = -800 and final_minutes_taken = 240
                 and final_completed_themes = 0 and final_solved_questions = 0 from teams where id = pg_temp.team_id(2)),
         'auto-expiry froze the NEGATIVE score on the same basis: 400 coins - 240 x 5';
  assert (select count(*) = 2 and min(final_score) = -700 and max(final_score) = -700 from teams where status = 'ENDED' and id <> pg_temp.team_id(2));
  perform pg_temp.at('2026-12-01 20:00:00+00');
  assert pg_temp.score(2) = -800 and pg_temp.mins(2) = 240 and pg_temp.score(4) = -700, 'nothing drifts after the end';
end $$;

-- ===== 8. ranking: started before unstarted; score desc, minutes asc, Team ID asc ==================================
do $$ begin
  assert pg_temp.board() = 'T01,T11,T9,T02,T10,T12', 'T01 1375 | T11 = T9 = -700 (tie on score and minutes: Team ID) | T02 -800 | unstarted T10, T12 (500): ' || pg_temp.board();
  assert (select array_agg(rank_no order by rank_no) = array[1, 2, 3, 4, 5, 6] from app.leaderboard_rows(app.now())), 'dense, unique ranks';
end $$;
-- the minutes tie-break: two teams with the same score, the faster one first
do $$ begin
  update teams set final_score = -700, final_minutes_taken = 239 where id = pg_temp.team_id(4);   -- a synthetic frozen record
  assert pg_temp.board() = 'T01,T9,T11,T02,T10,T12', 'same score: fewer minutes first: ' || pg_temp.board();
  update teams set final_score = -700, final_minutes_taken = 240 where id = pg_temp.team_id(4);
end $$;

-- ===== 9. the two read models agree; participant view =============================================================
do $$
declare s jsonb := public.get_leaderboard(pg_temp.staff(1)); a jsonb := public.get_leaderboard(pg_temp.staff(2));
        p jsonb := public.get_team_leaderboard(pg_temp.team_id(2), pg_temp.member_id(2, 3));
begin
  assert (s - 'server_now') = (a - 'server_now') and (s->'rows') = (p->'rows'), 'staff and participant boards are the same ranking';
  assert p->'me' = jsonb_build_object('rank', 4, 'team_id', 'T02', 'score', -800), 'own row: ' || (p->'me')::text;
  assert (select jsonb_array_length(p->'rows')) = 6;
end $$;

-- ===== 10. authorization of the read models ========================================================================
select pg_temp.rejects($s$select public.get_team_leaderboard(pg_temp.team_id(1), pg_temp.member_id(2, 1))$s$, 'FORBIDDEN');   -- another team's member
select pg_temp.rejects($s$select public.get_team_leaderboard(pg_temp.team_id(1), null)$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.get_team_leaderboard(null, null)$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.get_leaderboard(pg_temp.member_id(1, 1))$s$, 'FORBIDDEN');                              -- a participant is not staff
select pg_temp.rejects($s$select public.get_leaderboard(null)$s$, 'FORBIDDEN');
do $$
declare p jsonb := public.get_team_leaderboard(pg_temp.team_id(3), pg_temp.member_id(3, 2));
begin
  assert p->'me' = jsonb_build_object('rank', 5, 'team_id', 'T10', 'score', 500), 'an unstarted team sees itself last-but-one: ' || (p->'me')::text;
  assert (select array_agg(k order by k) from jsonb_object_keys(p) k) = array['me', 'rows', 'server_now'];
  assert (select array_agg(k order by k) from jsonb_object_keys(p->'rows'->0) k) = array['rank', 'score', 'team_id'], 'a row is rank, Team ID, score and nothing else';
  assert not (p::text ~* '(password|admission|login|token|coins)'), 'nothing private is on the board';
end $$;

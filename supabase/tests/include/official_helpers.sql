-- Shared by 180_official_content.test.sql and fresh/010_fresh_install.test.sql: pg_temp helpers over the public RPCs and the
-- reward matrix of the official document, written out here on purpose (independent of the generator). Include after fixture.sql.
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
create function pg_temp.q(t int, q int) returns jsonb language sql as
  $$ select public.get_question_for_team(pg_temp.team_id(t), pg_temp.member_id(t, 1), q::smallint)->'question' $$;
create function pg_temp.submit(t int, q int, n int) returns jsonb language sql as
  $$ select public.submit_answer(pg_temp.team_id(t), pg_temp.member_id(t, 1), q::smallint, 'ans', 'because', pg_temp.key(n)) $$;
create function pg_temp.sub(t int, q int) returns uuid language sql as
  $$ select id from submissions where team_id = pg_temp.team_id(t) and question_id = q and status = 'PENDING' $$;
create function pg_temp.approve(t int, q int, n int) returns jsonb language sql as
  $$ select public.approve_submission(pg_temp.staff(case t when 1 then 2 else 3 end), pg_temp.sub(t, q), pg_temp.key(n)) $$;
create function pg_temp.hint(t int, q int, tier int, n int) returns jsonb language sql as
  $$ select public.buy_hint(pg_temp.team_id(t), pg_temp.member_id(t, 1), q::smallint, tier::smallint, pg_temp.key(n)) $$;
create function pg_temp.final(t int, n int) returns jsonb language sql as
  $$ select public.final_submit(pg_temp.team_id(t), pg_temp.member_id(t, 1), true, pg_temp.key(n)) $$;
create function pg_temp.state(t int) returns jsonb language sql as
  $$ select public.get_team_state(pg_temp.team_id(t), pg_temp.member_id(t, 1)) $$;
create function pg_temp.coins(t int) returns int language sql as $$ select coins from teams where id = pg_temp.team_id(t) $$;
create function pg_temp.score(t int) returns int language sql as
  $$ select official_score from app.team_scores(app.now(), pg_temp.team_id(t)) $$;
-- the reward the OFFICIAL document gives each question (id = (theme - 1) * 5 + ordinal), written out here on purpose
create temp table doc_reward as
select q as id, r as reward from unnest(array[
  100,100,100,100,100,   70,70,90,60,100,   70,80,80,90,90,   100,60,90,50,90,   70,80,90,60,100,
   70, 70, 90, 90,100,   80,90,90,50,100,   70,90,90,90,100,   90,100,80,80,100,   80,90,70,90,90]) with ordinality as x(r, q);

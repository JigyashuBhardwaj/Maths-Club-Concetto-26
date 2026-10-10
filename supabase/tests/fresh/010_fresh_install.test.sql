-- B17: a FRESH database, built the way Supabase builds one - every migration in order, THEN supabase/seed.sql (the harness has already
-- applied the seed twice). `supabase db reset` / `supabase start` run migrations first and the seed after them, and `supabase db push`
-- applies migrations only (a seed only with --include-seed, again after them), so when migration 19 runs the content tables are
-- EMPTY. The official content must therefore be installed by the migration itself, and the seed that follows must keep it.
-- This file runs against that pristine state (before db-verify rebuilds the placeholder fixture for the older tests).
begin;
\ir ../include/helpers.sql
\ir ../include/fixture.sql
\ir ../include/official_helpers.sql

-- ===== 1. the content is official straight after migrations + seed ===================================================
do $$ begin
  assert (select count(*) from themes) = 10 and (select count(*) from questions) = 50 and (select count(*) from hints) = 100, '10 / 50 / 100 rows';
  assert (select count(*) from question_keys) = 50 and (select count(*) from question_buy_time_options) = 150, 'the seed still adds reviewer-key placeholders and buy-time options';
  assert not exists (select 1 from themes where name ~ 'PLACEHOLDER' or description ~ 'Placeholder')
     and not exists (select 1 from questions where body_md ~ 'PLACEHOLDER|Lorem')
     and not exists (select 1 from hints where body_md ~ 'PLACEHOLDER|Lorem'), 'no placeholder text survived the seed';
  assert (select string_agg(name, ' | ' order by id) from themes) =
    'DIG INTO THE PASSWORD OF IIT ISM | HOW BAD CAN BE HOSTEL FOOD | END SEM FEAR TAKEOVER | WHAT IS THE SIZE OF THE CAMPUS? | WHO IS THE POKER GUY HERE | ASK OUT YOUR CRUSH | I WANT A STRAIGHT TRAJECTORY IN LIFE | IS THE GUARD CHASING YOU? | WHAT AMOUNT TO PUT IN PAY REQUEST TO MY SENIORS | DO YOU HATE PROVING YOURSELF?',
    'official theme names in theme order';
  assert (select description from themes where code = 'E') = 'Probability, Combinatorics, Game Theory, and Derangements';
  assert not exists (select 1 from questions q join doc_reward d using (id) where q.reward_coins <> d.reward), 'rewards equal the document';
  assert (select sum(reward_coins) from questions) = 4230 and (select count(distinct reward_coins) from questions) = 6;
  assert (select reward_coins from questions where id = 17) = 60, 'D.2 = 60';
  assert (select body_md from questions where id = 1) like 'A message intercepted from the campus network%';
  assert (select body_md from questions where id = 50) = 'The last surviving soldier has rank 45. What is the smallest number of soldiers that could have been on the ship?';
  assert (select body_md from hints where id = 1) like 'REVERSE THE PIPELINE: The last encryption step was reversing%'
     and (select body_md from hints where id = 100) is not null
     and not exists (select 1 from hints h where h.question_id <> (h.id + 1) / 2 or h.tier <> (h.id - 1) % 2 + 1), 'hints map to their question and tier';
end $$;

-- ===== 2. the structure is what the seed gives its rows (an installed row == a seeded row) ============================
do $$ begin
  assert not exists (select 1 from themes where code <> chr(64 + id) or unlock_cost <> 100 or display_order <> id or topics <> array['placeholder']
                     or difficulty <> (case when id <= 3 then 'EASY' when id <= 7 then 'MEDIUM' else 'HARD' end)::difficulty), 'themes: code, cost 100, order, topics, difficulty';
  assert not exists (select 1 from questions q join themes t on t.id = q.theme_id
                      where q.difficulty <> t.difficulty or q.time_limit_seconds <> 240 or q.id <> (q.theme_id - 1) * 5 + q.ordinal), 'questions: theme difficulty, 4:00 timer, id = (theme - 1) * 5 + ordinal';
  assert not exists (select 1 from hints where cost <> case tier when 1 then 20 else 40 end), 'hints cost 20 / 40';
  assert not exists (select 1 from question_buy_time_options o
                      where (o.seconds, o.cost) <> (case o.display_order when 1 then (120, 20) when 2 then (240, 40) else (480, 80) end)), 'buy-time options 120/20, 240/40, 480/80';
end $$;

-- ===== 3. the install is the database's initial content: no audit row; re-applying the migration changes nothing ===========
do $$ begin
  assert (select count(*) from audit_events) = 0, 'a freshly built database has an empty audit log (the install is initial content, not a change)';
end $$;
create temp table fresh_snapshot as
select 't' k, id, name || '|' || description as v from themes
union all select 'q', id, body_md || '|' || reward_coins from questions
union all select 'h', id, body_md from hints;
\ir ../../migrations/20261006000019_official_content.sql
do $$ begin
  assert (select count(*) from audit_events) = 0, 'a re-run of the migration on installed content writes nothing';
  assert not exists ((select k, id, v from fresh_snapshot) except (select 't', id::int, name || '|' || description from themes
                      union all select 'q', id, body_md || '|' || reward_coins from questions union all select 'h', id, body_md from hints)), 'content identical';
end $$;

-- ===== 4. the game on the freshly installed content ===================================================================
\ir ../include/official_gameplay.sql
rollback;

-- Seed correctness and competition structure (runs on the seeded scratch database).
begin;
\ir include/helpers.sql

do $$
begin
  assert (select count(*) from themes) = 10, 'exactly 10 themes';
  assert (select string_agg(code, '' order by id) from themes) = 'ABCDEFGHIJ', 'themes are exactly A..J';
  assert not exists (select 1 from themes where code in ('K', 'L') or id > 10 or name ilike '%theme k%' or name ilike '%theme l%'), 'no K/L';
  assert (select count(*) from questions) = 50, 'exactly 50 questions';
  assert (select count(*) from (select theme_id from questions group by theme_id having count(*) = 5) x) = 10, '5 questions per theme';
  assert (select count(distinct id) from questions) = 50 and (select min(id) from questions) = 1 and (select max(id) from questions) = 50;
  assert (select count(*) from hints) = 100 and (select count(*) from hints where tier = 1) = 50 and (select count(*) from hints where tier = 2) = 50;
  assert (select count(*) from question_keys) = 50, 'a reviewer key per question';
  assert (select count(*) from competition) = 1 and (select status from competition) = 'SETUP', 'one competition, initial state SETUP';
  assert (select count(*) from staff_users) = 0 and (select count(*) from teams) = 0, 'no credentials or teams are seeded';
  assert (select count(*) from coin_transactions) = 0 and (select count(*) from audit_events) = 0;
  -- placeholder content is clearly labelled and carries no real answer key
  assert not exists (select 1 from questions where body_md not like '[DEV PLACEHOLDER]%'), 'questions are marked placeholder';
  assert not exists (select 1 from question_keys where reference_answer not like 'DEV-PLACEHOLDER-ANSWER-%'), 'keys are placeholders';
  -- the 11-ticket home = 10 themes + Final Submit (the Final Submit ticket is UI-only: it is not a database row)
  assert (select count(*) from themes) + 1 = 11;
end $$;

-- timer / content configuration is deterministic and correct
do $$
begin
  assert not exists (select 1 from questions where time_limit_seconds <> 240), 'question timer is 4:00 everywhere';
  assert not exists (select 1 from questions where reward_coins <> 50), 'reward is fixed per question (50)';
  assert not exists (select 1 from hints where cost <> case tier when 1 then 20 else 40 end), 'hint prices 20/40';
  -- Buy Time: three configurable options for every question (placeholder content, not constants)
  assert (select count(*) from question_buy_time_options) = 150, '3 options x 50 questions';
  assert not exists (select 1 from questions q where (select count(*) from question_buy_time_options o where o.question_id = q.id) <> 3), 'exactly 3 options per question';
  assert not exists (select 1 from question_buy_time_options where (display_order, seconds, cost) not in ((1, 120, 20), (2, 240, 40), (3, 480, 80))), 'options are 120s/20, 240s/40, 480s/80 in display order';
  assert not exists (select 1 from question_buy_time_options where max_purchases is not null), 'unlimited purchases in the seed';
end $$;

-- K / L can never be added: ids, codes and positions are all pinned
select pg_temp.rejects($s$insert into themes (id, code, name, description, difficulty, unlock_cost, display_order) values (11, 'K', 'x', 'x', 'EASY', 1, 11)$s$, '23514');
select pg_temp.rejects($s$insert into themes (id, code, name, description, difficulty, unlock_cost, display_order) values (10, 'K', 'x', 'x', 'EASY', 1, 99)$s$, '23514');
select pg_temp.rejects($s$insert into themes (id, code, name, description, difficulty, unlock_cost, display_order) values (12, 'L', 'x', 'x', 'EASY', 1, 12)$s$, '23514');
select pg_temp.rejects($s$insert into questions (id, theme_id, ordinal, body_md, difficulty, reward_coins, time_limit_seconds) values (51, 10, 5, 'x', 'EASY', 1, 1)$s$, '23514');
select pg_temp.rejects($s$insert into questions (id, theme_id, ordinal, body_md, difficulty, reward_coins, time_limit_seconds) values (51, 10, 6, 'x', 'EASY', 1, 1)$s$, '23514');
rollback;

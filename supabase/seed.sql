-- Patch B — deterministic development seed (safe to re-run; no credentials, no staff, no teams).
--
-- Seeds ONLY: the competition configuration, 10 themes (A–J), 5 questions per theme (50), 2 hints per question
-- (100) and placeholder reviewer keys. All text is clearly marked DEV PLACEHOLDER. The real competition content
-- replaces it later; the structure (and the assertions at the bottom) stay.
-- Prices/rewards are placeholder CONTENT DATA (unlock 100, reward 50, hints 40/80, buy-time pack 2 min for 20 coins).
-- Staff accounts and teams are never seeded here: the Super Admin is provisioned out of band (no fake credentials).

insert into competition (id) values (1) on conflict (id) do nothing;   -- defaults: SETUP, 7200 s, 500 coins, -1200 / -1201

insert into themes (id, code, name, description, topics, difficulty, unlock_cost, display_order)
select n, chr(64 + n), 'Theme ' || chr(64 + n) || ' [DEV PLACEHOLDER]',
       'Placeholder description for theme ' || chr(64 + n) || '.',
       array['placeholder'],
       (case when n <= 3 then 'EASY' when n <= 7 then 'MEDIUM' else 'HARD' end)::difficulty,
       100, n
from generate_series(1, 10) as n
on conflict (id) do nothing;

insert into questions (id, theme_id, ordinal, body_md, difficulty, reward_coins,
                       time_limit_seconds, buy_time_seconds, buy_time_cost, max_time_purchases)
select (t.id - 1) * 5 + q, t.id, q,
       '[DEV PLACEHOLDER] Question ' || chr(64 + t.id) || q || '. Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
       t.difficulty, 50,
       240,      -- the per-question timer: 4:00
       120, 20,  -- buy-time pack: +2 min for 20 coins (configurable content data)
       null      -- unlimited purchases
from themes t cross join generate_series(1, 5) as q
on conflict (id) do nothing;

insert into question_keys (question_id, reference_answer, solution_notes)
select id, 'DEV-PLACEHOLDER-ANSWER-' || id, 'Development placeholder; not a real answer key.'
from questions
on conflict (question_id) do nothing;

insert into hints (id, question_id, tier, body_md, cost)
select (q.id - 1) * 2 + tier, q.id, tier,
       '[DEV PLACEHOLDER] Hint ' || tier || ' for question ' || q.id || '.',
       case tier when 1 then 40 else 80 end
from questions q cross join generate_series(1, 2) as tier
on conflict (id) do nothing;

-- Seed completeness assertions (fail loudly if the structure drifts).
do $$
begin
  assert (select count(*) from competition) = 1,                         'seed: exactly one competition row';
  assert (select count(*) from themes) = 10,                             'seed: exactly 10 themes';
  assert (select string_agg(code, '' order by id) from themes) = 'ABCDEFGHIJ', 'seed: themes are A..J';
  assert (select count(*) from questions) = 50,                          'seed: exactly 50 questions';
  assert (select count(*) = 10 and min(c) = 5 and max(c) = 5
            from (select count(*) c from questions group by theme_id) x), 'seed: 5 questions per theme';
  assert (select count(*) from hints) = 100,                             'seed: 2 hints per question';
  assert (select count(*) from question_keys) = 50,                      'seed: a reviewer key per question';
  assert (select count(*) from staff_users) = 0 and (select count(*) from teams) = 0, 'seed: no staff or team accounts';
end $$;

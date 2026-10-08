-- Patch B — deterministic development seed (safe to re-run; no credentials, no staff, no teams).
--
-- Seeds ONLY: the competition configuration, 10 themes (A–J), 5 questions per theme (50), 2 hints per question
-- (100) and placeholder reviewer keys. All text is clearly marked DEV PLACEHOLDER. The real competition content
-- replaces it later; the structure (and the assertions at the bottom) stay.
-- Prices/rewards are placeholder CONTENT DATA (unlock 100, reward 50, hints 20/40, buy-time options 120 s/20, 240 s/40, 480 s/80).
-- B15: the hint prices changed from 40/80 to 20/40. This file only seeds a development/CI database; it never updates an existing
-- one (every insert is ON CONFLICT DO NOTHING). Production hint prices are changed by a separate, human-run, reviewed script.
-- Staff accounts and teams are never seeded here: the Super Admin is provisioned out of band (no fake credentials).

insert into competition (id) values (1) on conflict (id) do nothing;   -- defaults: SETUP, 14400 s, 500 coins, -1200 / -1201

insert into themes (id, code, name, description, topics, difficulty, unlock_cost, display_order)
select n, chr(64 + n), 'Theme ' || chr(64 + n) || ' [DEV PLACEHOLDER]',
       'Placeholder description for theme ' || chr(64 + n) || '.',
       array['placeholder'],
       (case when n <= 3 then 'EASY' when n <= 7 then 'MEDIUM' else 'HARD' end)::difficulty,
       100, n
from generate_series(1, 10) as n
on conflict (id) do nothing;

insert into questions (id, theme_id, ordinal, body_md, difficulty, reward_coins,
                       time_limit_seconds)
select (t.id - 1) * 5 + q, t.id, q,
       '[DEV PLACEHOLDER] Question ' || chr(64 + t.id) || q || '. Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
       t.difficulty, 50,
       240       -- the per-question timer: 4:00
from themes t cross join generate_series(1, 5) as q
on conflict (id) do nothing;

-- Three configurable Buy Time options per question (placeholders: +2 min / +4 min / +8 min), unlimited purchases.
insert into question_buy_time_options (id, question_id, seconds, cost, max_purchases, display_order)
select (q.id - 1) * 3 + o.n, q.id, o.seconds, o.cost, null, o.n
from questions q
cross join (values (1, 120, 20), (2, 240, 40), (3, 480, 80)) as o(n, seconds, cost)
on conflict (id) do nothing;

insert into question_keys (question_id, reference_answer, solution_notes)
select id, 'DEV-PLACEHOLDER-ANSWER-' || id, 'Development placeholder; not a real answer key.'
from questions
on conflict (question_id) do nothing;

insert into hints (id, question_id, tier, body_md, cost)
select (q.id - 1) * 2 + tier, q.id, tier,
       '[DEV PLACEHOLDER] Hint ' || tier || ' for question ' || q.id || '.',
       case tier when 1 then 20 else 40 end
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
  assert (select count(*) from question_buy_time_options) = 150,        'seed: 3 buy-time options per question';
  assert (select count(*) = 50 and min(c) = 3 and max(c) = 3
            from (select count(*) c from question_buy_time_options group by question_id) x), 'seed: exactly 3 options for each question';
  assert (select count(*) from question_keys) = 50,                      'seed: a reviewer key per question';
  assert (select count(*) from staff_users) = 0 and (select count(*) from teams) = 0, 'seed: no staff or team accounts';
end $$;

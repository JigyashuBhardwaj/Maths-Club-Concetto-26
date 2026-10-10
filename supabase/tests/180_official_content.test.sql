-- B17 / migration 19: the official Concetto 26 content (10 themes, 50 questions, 100 hints, per-question rewards).
--
-- The ordinary fixture is the placeholder seed (supabase/seed.sql). This file starts from that state and applies migration 19 to
-- it with \ir, which is exactly what happens to a production database that was seeded with placeholders. It then checks
--   * the shape and the content that must have arrived (the exact text is compared to the JSON in the upgrade test and in the
--     unit test; here the structure, names, rewards and hint mapping are written out independently of the generator),
--   * that nothing but the content columns changed, and that a second run changes nothing,
--   * that a hint is never visible before it is bought, and the question text not before the question is entered,
--   * that an approval pays exactly the reward of THAT question, once, also on a retry, and a late approval after
--     Final Submit or after the timer end pays the reward but never moves the frozen score.
begin;
\ir include/helpers.sql
\ir include/fixture.sql

\ir include/official_helpers.sql

-- ===== 0. the starting point is the placeholder seed =================================================================
do $$ begin
  assert (select count(*) from questions where body_md like '[DEV PLACEHOLDER]%') = 50 and (select count(*) from questions where reward_coins = 50) = 50,
         'before: placeholder questions, reward 50';
end $$;
-- audit_events is append-only, and a database built the real way (migrations, then seed) already has the audit row of the
-- fresh install, so every audit assertion below is relative to this baseline
create temp table audit0 as select count(*) as n from audit_events where event_type = 'CONTENT_IMPORTED';
create temp table before_structure as
select 'themes' t, id::int, code::text a, unlock_cost::text b, difficulty::text c, display_order::text d, topics::text e from themes
union all select 'questions', id, theme_id::text, ordinal::text, difficulty::text, time_limit_seconds::text, '' from questions
union all select 'hints', id, question_id::text, tier::text, cost::text, '', '' from hints
union all select 'buy', id, question_id::text, seconds::text, cost::text, coalesce(max_purchases::text, 'null'), display_order::text from question_buy_time_options
union all select 'keys', question_id, reference_answer, coalesce(solution_notes, ''), '', '', '' from question_keys;

-- ===== 1. apply migration 19 ==========================================================================================
\ir ../migrations/20261006000019_official_content.sql

do $$ begin
  assert (select count(*) from themes) = 10 and (select count(*) from questions) = 50 and (select count(*) from hints) = 100, 'no row added or removed';
  assert (select string_agg(name, ' | ' order by id) from themes) =
    'DIG INTO THE PASSWORD OF IIT ISM | HOW BAD CAN BE HOSTEL FOOD | END SEM FEAR TAKEOVER | WHAT IS THE SIZE OF THE CAMPUS? | WHO IS THE POKER GUY HERE | ASK OUT YOUR CRUSH | I WANT A STRAIGHT TRAJECTORY IN LIFE | IS THE GUARD CHASING YOU? | WHAT AMOUNT TO PUT IN PAY REQUEST TO MY SENIORS | DO YOU HATE PROVING YOURSELF?',
    'theme names, in theme order';
  assert (select description from themes where code = 'A') = 'ADVANCED CRYPTOGRAPHY, NUMBER THEORY & COMBINATORICS';
  assert (select description from themes where code = 'F') = 'PROBABILITY AND STATISTICS';
  assert (select description from themes where code = 'E') = 'Probability, Combinatorics, Game Theory, and Derangements', 'no leading space on E';
  assert (select description from themes where code = 'J') = 'Mathematical proofs, logic, induction, and contradiction';
  assert not exists (select 1 from themes where description like 'Placeholder%' or name like '%PLACEHOLDER%');
  -- every question carries the reward of the document, and it differs between questions (it is not a global number)
  assert not exists (select 1 from questions q join doc_reward d using (id) where q.reward_coins <> d.reward), 'rewards equal the document';
  assert (select count(distinct reward_coins) from questions) = 6 and (select sum(reward_coins) from questions) = 4230, 'rewards vary: 50..100, total 4230';
  assert (select reward_coins from questions where id = 17) = 60, 'D.2 = 60 (approved by the project owner; the document leaves it blank)';
  assert not exists (select 1 from questions where body_md ~ 'PLACEHOLDER|Lorem') and not exists (select 1 from hints where body_md ~ 'PLACEHOLDER|Lorem');
  -- question text arrives with its line breaks and symbols intact
  assert (select body_md from questions where id = 1) like E'A message intercepted from the campus network%\nThe intercepted ciphertext is:\n    PHOHOHYHHHGHTBFR\n\nRecover the original message%';
  assert (select body_md from questions where id = 2) like E'%\n\nPart A: Diffie–Hellman\n%Part B: RSA decryption\n%K,T.';
  assert position(E'                         Player B\n                   Call (C)     Fold (F)\nPlayer A  Bluff (B)      −4           6\n          Play Safe (S)   3          −2\n\nBoth players'
                  in (select body_md from questions where id = 23)) > 0, 'E.3 payoff table keeps its spacing';
  assert (select body_md from questions where id = 27) like 'Using S = 5 from Question 1,%', 'F.2 keeps its wording';
  assert (select body_md from questions where id = 50) = 'The last surviving soldier has rank 45. What is the smallest number of soldiers that could have been on the ship?';
  assert (select body_md from questions where id = 31) like '%X = [[0, −2], [1/2, 0]]%' , 'G.1 matrix text';
  -- the cross references are kept word for word (they use the document''s own numbering)
  assert (select body_md from questions where id = 12) like 'Using the value of a from Q3.1,%' and (select body_md from questions where id = 14) like '%QC.3.';
  assert (select body_md from questions where id = 19) like 'Using the stopping point obtained in Q4.3,%';
  assert (select body_md from questions where id = 28) like 'Using K = 11 from Question 2,%';
  assert (select body_md from questions where id = 32) like 'The trajectory from Q8.1 traces an ellipse.%' and (select body_md from questions where id = 37) like '%from Q9.1.%',
         'G.2 / H.2 keep the document''s own (inconsistent) numbering: flagged in the report, not changed';
  -- hints: two per question, tier 1 / tier 2, mapped to the right question
  assert not exists (select 1 from hints h where h.question_id <> (h.id + 1) / 2 or h.tier <> (h.id - 1) % 2 + 1), 'hint id <-> question/tier';
  assert (select count(*) from hints where body_md = '' ) = 0;
  assert (select body_md from hints where id = 1) like 'REVERSE THE PIPELINE: The last encryption step was reversing%';
  assert (select body_md from hints where id = 2) like 'MODULAR SHIFT: Convert each ciphertext letter%';
  assert (select body_md from hints where id = 5) like 'SPLIT BY THE LAST BIT:%' and (select body_md from hints where id = 9) like 'FORBIDDEN-CELL BOARD:%';
  assert (select body_md from hints where (id + 1) / 2 = 8 and tier = 1) like 'HINT 1 — TOPIC: This problem combines queueing theory%', 'B.3 hint 1 is kept as written';
  assert (select body_md from hints where (id + 1) / 2 = 8 and tier = 1) not like E'\n%', 'and has no leading blank lines';
  assert (select body_md from hints where (id + 1) / 2 = 11 and tier = 1) like '— TOPIC: A sum of function values%', 'C.1 hint 1 is kept as written';
end $$;

-- ===== 2. nothing but the content columns changed ===================================================================
do $$ begin
  assert not exists (
    (select t, id, a, b, c, d, e from before_structure)
    except
    (select 'themes', id::int, code::text, unlock_cost::text, difficulty::text, display_order::text, topics::text from themes
     union all select 'questions', id, theme_id::text, ordinal::text, difficulty::text, time_limit_seconds::text, '' from questions
     union all select 'hints', id, question_id::text, tier::text, cost::text, '', '' from hints
     union all select 'buy', id, question_id::text, seconds::text, cost::text, coalesce(max_purchases::text, 'null'), display_order::text from question_buy_time_options
     union all select 'keys', question_id, reference_answer, coalesce(solution_notes, ''), '', '', '' from question_keys)),
    'ids, order, difficulty, unlock costs, hint prices, timers, buy-time options and reviewer keys are exactly as before';
  assert not exists (select 1 from questions where time_limit_seconds <> 240), 'the question timer is still 4:00';
  assert not exists (select 1 from hints where cost <> case tier when 1 then 20 else 40 end), 'hint prices still 20 / 40';
  assert not exists (select 1 from themes where unlock_cost <> 100);
  assert (select count(*) from teams) = 2 and (select count(*) from team_themes) = 0 and (select count(*) from submissions) = 0, 'no team state';
  assert (select count(*) from audit_events where event_type = 'CONTENT_IMPORTED') = (select n from audit0) + 1, 'one new CONTENT_IMPORTED audit row';
  assert (select (payload->>'themes_changed')::int = 10 and (payload->>'questions_changed')::int = 50 and (payload->>'hints_changed')::int = 100
                 and payload->>'mode' = 'updated' and payload->>'content_sha256' ~ '^[0-9a-f]{64}$' and actor_kind = 'SYSTEM'
            from audit_events where event_type = 'CONTENT_IMPORTED' order by id desc limit 1), 'the new row counts the update of 10 / 50 / 100 rows';
end $$;

-- ===== 3. idempotent: a second run changes nothing (not a row, not an audit event) ==================================
create temp table content_snapshot as
select 't' k, id, name || '|' || description as v from themes
union all select 'q', id, body_md || '|' || reward_coins from questions
union all select 'h', id, body_md from hints;
\ir ../migrations/20261006000019_official_content.sql
do $$ begin
  assert (select count(*) from audit_events where event_type = 'CONTENT_IMPORTED') = (select n from audit0) + 1, 'no second audit row';
  assert not exists ((select k, id, v from content_snapshot) except (select 't', id::int, name || '|' || description from themes
                      union all select 'q', id, body_md || '|' || reward_coins from questions union all select 'h', id, body_md from hints)), 'content identical after the second run';
  assert (select count(*) from content_snapshot) = 160;
end $$;

\ir include/official_gameplay.sql
rollback;

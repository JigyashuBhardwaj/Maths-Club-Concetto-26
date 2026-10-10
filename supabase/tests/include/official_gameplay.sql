-- Shared by 180_official_content.test.sql and fresh/010_fresh_install.test.sql: gameplay on the OFFICIAL content (hint secrecy, the
-- reward of each question paid exactly once, late approvals, D.2 = 60). Needs fixture.sql and official_helpers.sql, an open
-- transaction, and a database that already holds the official content. The caller rolls back.
-- ===== 4. gameplay with the official content ==========================================================================
select pg_temp.status('open', 1);
select pg_temp.at('2026-12-01 12:00:00+00');
select pg_temp.start(1, 2);
select pg_temp.start(2, 3);
select pg_temp.at('2026-12-01 12:01:00+00');
select pg_temp.unlock(1, 1, 10);                                    -- theme A: -100
select pg_temp.enter(1, 1, 11);
do $$
declare q jsonb := pg_temp.q(1, 1); s jsonb := pg_temp.state(1);
begin
  assert q->>'state' = 'ACTIVE' and (q->>'reward_coins')::int = 100, 'A.1 shows its own reward';
  assert q->>'body_md' like 'A message intercepted from the campus network%', 'the official A.1 is what the team sees';
  assert (q->'hints'->0->>'cost')::int = 20 and (q->'hints'->1->>'cost')::int = 40, 'hint prices unchanged';
  -- no hint text anywhere before it is bought: not in the question, not in the team snapshot
  assert not (q->'hints'->0 ? 'body_md') and not (q->'hints'->1 ? 'body_md');
  assert q::text not like '%REVERSE THE PIPELINE%' and q::text not like '%MODULAR SHIFT%' and s::text not like '%REVERSE THE PIPELINE%' and s::text not like '%MODULAR SHIFT%';
  perform 1;
  -- the snapshot lists the official theme names/descriptions (public by design) and each question reward, never a hint or answer
  assert (select count(*) from jsonb_array_elements(s->'themes') t where t->>'name' ~ '^[A-Z]' and t->>'description' <> '') = 10;
  assert s::text not like '%reference_answer%' and s::text not like '%DEV-PLACEHOLDER%';
end $$;
select pg_temp.at('2026-12-01 12:02:00+00');
select pg_temp.hint(1, 1, 1, 12);                                   -- tier 1: -20
do $$
declare q jsonb := pg_temp.q(1, 1);
begin
  assert q->'hints'->0->>'body_md' like 'REVERSE THE PIPELINE:%' and (q->'hints'->0->>'owned')::boolean, 'the bought hint 1 is A.1''s own hint 1';
  assert not (q->'hints'->1 ? 'body_md') and q::text not like '%MODULAR SHIFT%', 'hint 2 is still hidden';
  assert pg_temp.coins(1) = 380;
end $$;
-- another team that did not buy it sees nothing of it, even for the same question
select pg_temp.unlock(2, 1, 20);
select pg_temp.enter(2, 1, 21);
do $$ begin
  assert pg_temp.q(2, 1)::text not like '%REVERSE THE PIPELINE%' and pg_temp.state(2)::text not like '%REVERSE THE PIPELINE%', 'team isolation: hint text';
end $$;
select pg_temp.rejects($s$select pg_temp.q(1, 2)$s$, 'QUESTION_NOT_ACTIVE');          -- A.2 is LOCKED: it exposes nothing at all
-- approval: exactly A.1's reward, once; a retry replays; a second approval is refused
select pg_temp.at('2026-12-01 12:03:00+00');
select pg_temp.submit(1, 1, 13);
select pg_temp.submit(2, 1, 60);
create temp table a1 as select pg_temp.coins(1) as coins;
do $$
declare j jsonb;
begin
  j := pg_temp.approve(1, 1, 14);
  assert (j->>'reward_awarded')::int = 100 and pg_temp.coins(1) = (select coins from a1) + 100, 'A.1 pays 100';
  assert (select count(*) from coin_transactions where team_id = pg_temp.team_id(1) and type = 'QUESTION_REWARD' and question_id = 1 and amount = 100) = 1;
  j := public.approve_submission(pg_temp.staff(2), (select id from submissions where team_id = pg_temp.team_id(1) and question_id = 1), pg_temp.key(14));
  assert (j->>'replayed')::boolean and pg_temp.coins(1) = (select coins from a1) + 100, 'same key: replayed, not paid again';
  assert (select count(*) from coin_transactions where team_id = pg_temp.team_id(1) and type = 'QUESTION_REWARD') = 1;
end $$;
select pg_temp.rejects($s$select public.approve_submission(pg_temp.staff(2), (select id from submissions where team_id = pg_temp.team_id(1) and question_id = 1), pg_temp.key(15))$s$, 'SUBMISSION_NOT_PENDING');
do $$ begin
  assert (select count(*) from coin_transactions where team_id = pg_temp.team_id(1) and type = 'QUESTION_REWARD') = 1 and (select reward_awarded from submissions where team_id = pg_temp.team_id(1) and question_id = 1) = 100;
  assert not exists (select 1 from app.invariant_coin_balance_mismatch), 'teams.coins equals the ledger';
end $$;

select pg_temp.at('2026-12-01 12:03:30+00');
select pg_temp.submit(1, 2, 71);                                    -- A.2 (active since A.1 was approved) now waits for review, reward 100

-- theme B: five approvals pay 70, 70, 90, 60, 100 (the document), each once, and the theme completes
select pg_temp.at('2026-12-01 12:05:00+00');
select pg_temp.unlock(1, 2, 30);                                    -- theme B: -100
select pg_temp.enter(1, 6, 31);
do $$
declare i int; c0 int; j jsonb; expected int[] := array[70, 70, 90, 60, 100];
begin
  for i in 1..5 loop
    perform pg_temp.at((timestamptz '2026-12-01 12:05:30+00' + i * interval '30 seconds')::text);
    assert (pg_temp.q(1, 5 + i)->>'reward_coins')::int = expected[i], 'the question page reward of B.' || i;
    perform pg_temp.submit(1, 5 + i, 40 + i);
    c0 := pg_temp.coins(1);
    j := pg_temp.approve(1, 5 + i, 50 + i);
    assert (j->>'reward_awarded')::int = expected[i] and pg_temp.coins(1) = c0 + expected[i], 'B.' || i || ' pays ' || expected[i];
    assert (select amount from coin_transactions where team_id = pg_temp.team_id(1) and question_id = 5 + i and type = 'QUESTION_REWARD') = expected[i];
  end loop;
  assert (select count(*) from coin_transactions where team_id = pg_temp.team_id(1) and type = 'QUESTION_REWARD') = 6;
  assert (select count(*) from team_questions where team_id = pg_temp.team_id(1) and theme_id = 2 and state = 'APPROVED') = 5, 'theme B completed';
  assert not exists (select 1 from app.invariant_coin_balance_mismatch);
end $$;

-- ===== 5. a late approval pays its reward and never moves a frozen score ===========================================
-- (a) after Final Submit: team 2 answers A.1 (reward 100), submits the whole competition, and is approved afterwards
select pg_temp.at('2026-12-01 12:30:00+00');
select pg_temp.final(2, 61);
create temp table frozen2 as select pg_temp.score(2) as score, pg_temp.coins(2) as coins, (select final_score from teams where id = pg_temp.team_id(2)) as final_score;
select pg_temp.at('2026-12-01 13:00:00+00');
do $$
declare f frozen2%rowtype; j jsonb;
begin
  select * into f from frozen2;
  assert f.final_score is not null and f.score = f.final_score, 'the score is frozen at Final Submit';
  j := pg_temp.approve(2, 1, 62);
  assert (j->>'reward_awarded')::int = 100 and pg_temp.coins(2) = f.coins + 100, 'the late approval pays the official reward of A.1';
  assert pg_temp.score(2) = f.score and (select final_score from teams where id = pg_temp.team_id(2)) = f.final_score, 'and the frozen score did not move';
  j := public.approve_submission(pg_temp.staff(3), (select id from submissions where team_id = pg_temp.team_id(2) and question_id = 1), pg_temp.key(62));
  assert (j->>'replayed')::boolean and pg_temp.coins(2) = f.coins + 100, 'a retry does not pay twice';
end $$;
-- (b) after the timer end: team 1 (4 h from 12:00) has A.2 waiting (reward 100) when its time is up
create temp table before_expiry as select pg_temp.coins(1) as coins;
select pg_temp.at('2026-12-01 17:30:00+00');                       -- 90 min after the 4 h timer ended
do $$
declare j jsonb; c0 int := (select coins from before_expiry);
begin
  j := pg_temp.approve(1, 2, 72);
  assert (j->>'reward_awarded')::int = 100 and pg_temp.coins(1) = c0 + 100, 'A.2 pays its own reward (100) after the timer end';
  assert (select status = 'ENDED' and final_score is not null from teams where id = pg_temp.team_id(1)), 'the team was ended at its own end and its score frozen';
  assert pg_temp.score(1) = (select final_score from teams where id = pg_temp.team_id(1));
end $$;
create temp table frozen1 as select pg_temp.score(1) as score;
select pg_temp.at('2026-12-02 09:00:00+00');
do $$ begin
  assert pg_temp.score(1) = (select score from frozen1) and pg_temp.score(2) = (select score from frozen2), 'no drift over time';
  assert not exists (select 1 from app.invariant_coin_balance_mismatch);
end $$;

-- ===== 6. D.2 (reward 60, set by the project owner) is paid as 60 ==================================================
-- a fresh team 3 (a started, running team with its own clock)
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
values ('00000000-0000-0000-0000-0000000000b3', 'T03', 'Test Team 3', 'test_team_03', 'TEST-NOT-A-HASH', '00000000-0000-0000-0000-0000000000a2', 500);
insert into team_members (id, team_id, slot, admission_no)
select ('00000000-0000-0000-0000-00000000c' || 3 || '0' || s)::uuid, '00000000-0000-0000-0000-0000000000b3'::uuid, s, 'TEST3' || s from generate_series(1, 4) s;
insert into coin_transactions (team_id, type, amount, balance_after, created_at)
values ('00000000-0000-0000-0000-0000000000b3', 'INITIAL_GRANT', 500, 500, now());
select pg_temp.at('2026-12-02 10:00:00+00');
select pg_temp.start(3, 80);
select pg_temp.unlock(3, 4, 81);                                    -- theme D
select pg_temp.enter(3, 16, 82);
select pg_temp.submit(3, 16, 83);
do $$
declare j jsonb; c0 int;
begin
  c0 := pg_temp.coins(3);
  j := public.approve_submission(pg_temp.staff(2), pg_temp.sub(3, 16), pg_temp.key(84));
  assert (j->>'reward_awarded')::int = 100 and pg_temp.coins(3) = c0 + 100, 'D.1 pays 100';
  perform pg_temp.at('2026-12-02 10:02:00+00');
  assert (pg_temp.q(3, 17)->>'reward_coins')::int = 60 and (pg_temp.q(3, 17)->>'state') = 'ACTIVE', 'D.2 is active and announces 60';
  perform pg_temp.submit(3, 17, 85);
  c0 := pg_temp.coins(3);
  j := public.approve_submission(pg_temp.staff(2), pg_temp.sub(3, 17), pg_temp.key(86));
  assert (j->>'reward_awarded')::int = 60 and pg_temp.coins(3) = c0 + 60, 'D.2 pays 60';
end $$;
-- the Final Submit ticket and the leaderboard are unaffected by the content: the board still ranks every team
do $$ begin
  assert (select count(*) from app.leaderboard_rows(app.now())) = 3;
  assert not exists (select 1 from app.invariant_coin_balance_mismatch);
end $$;
-- privileges: the migration added no function and no grant
do $$ begin
  assert not has_table_privilege('anon', 'public.hints', 'select') and not has_table_privilege('authenticated', 'public.hints', 'select')
     and not has_table_privilege('anon', 'public.questions', 'select') and not has_table_privilege('authenticated', 'public.question_keys', 'select'),
     'content tables stay unreadable to the browser roles';
end $$;

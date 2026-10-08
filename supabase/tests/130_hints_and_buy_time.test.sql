-- B15 / migration 17: real Hint purchases (buy_hint) and real Buy Time (buy_time).
-- Prices, seconds and caps are read from content rows (hints.cost, question_buy_time_options); the tests change those rows
-- to prove nothing is hard-coded. Multi-connection races are in supabase/tests/concurrency/team_economy.concurrency.mjs.
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
create function pg_temp.ledger(t int, ty text) returns bigint language sql as
  $$ select count(*) from coin_transactions where team_id = pg_temp.team_id(t) and type = ty::coin_tx_type $$;

select pg_temp.status('open', 1);
select pg_temp.at('2026-12-01 12:00:00+00');
select pg_temp.start(1, 1, 2);
select pg_temp.start(2, 1, 3);
-- team 1 unlocks theme 1 (500 -> 400); team 2 spends everything (five themes, 500 -> 0)
select pg_temp.unlock(1, 1, 1, 10);
select pg_temp.unlock(2, 1, 1, 11); select pg_temp.unlock(2, 2, 2, 12); select pg_temp.unlock(2, 3, 3, 13);
select pg_temp.unlock(2, 4, 4, 14); select pg_temp.unlock(2, 1, 5, 15);
do $$ begin assert pg_temp.coins(1) = 400 and pg_temp.coins(2) = 0; end $$;

-- ===== 1. hint refusals that charge nothing ========================================================================
-- Q1 is AVAILABLE (not entered yet): nothing to buy against
select pg_temp.rejects($s$select pg_temp.hint(1, 1, 1, 1, 20)$s$, 'QUESTION_NOT_ACTIVE');
select pg_temp.rejects($s$select pg_temp.hint(1, 1, 2, 1, 21)$s$, 'QUESTION_NOT_ACTIVE');          -- LOCKED Q2 of an unlocked theme
select pg_temp.rejects($s$select pg_temp.hint(1, 1, 6, 1, 22)$s$, 'THEME_LOCKED');                  -- theme 2 not unlocked
select pg_temp.rejects($s$select pg_temp.hint(1, 1, 999, 1, 23)$s$, 'NOT_FOUND');
select pg_temp.rejects($s$select pg_temp.hint(1, 1, 1, 3, 24)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select pg_temp.hint(1, 1, 1, 0, 24)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.buy_hint(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint, null, pg_temp.key(24))$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.buy_hint(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint, 1::smallint, null)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.buy_hint(pg_temp.team_id(1), pg_temp.member_id(2, 1), 1::smallint, 1::smallint, pg_temp.key(25))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.buy_hint(null, null, 1::smallint, 1::smallint, pg_temp.key(25))$s$, 'FORBIDDEN');
do $$ begin
  assert pg_temp.coins(1) = 400 and (select count(*) from hint_purchases) = 0 and pg_temp.ledger(1, 'HINT_PURCHASE') = 0, 'refusals charge nothing';
  assert (select count(*) from request_log where idem_key between pg_temp.key(20) and pg_temp.key(25)) = 0, 'rejections are not stored';
end $$;

-- ===== 2. Hint 1 on an ACTIVE question: priced from hints.cost, charged once, team-wide =============================
select pg_temp.at('2026-12-01 12:01:00+00');
select pg_temp.enter(1, 1, 1, 30);                                                   -- Q1 ACTIVE, deadline 12:05
do $$
declare j jsonb := pg_temp.q(1, 1, 1);
begin
  -- the question lists both prices (from the table) and no hint text before anything is bought
  assert (j->'hints'->0->>'tier')::int = 1 and (j->'hints'->0->>'cost')::int = 20 and (j->'hints'->1->>'cost')::int = 40;
  assert not (j->'hints'->0->>'owned')::boolean and (j->'hints'->0->>'purchasable')::boolean;
  assert not (j->'hints'->1->>'purchasable')::boolean, 'Hint 2 is not purchasable before Hint 1';
  assert not (j->'hints'->0 ? 'body_md') and j::text not like '%Hint 1 for question%', 'no hint text before purchase';
end $$;
select pg_temp.rejects($s$select pg_temp.hint(1, 1, 1, 2, 31)$s$, 'HINT_TIER1_REQUIRED');
do $$ begin assert pg_temp.coins(1) = 400 and (select count(*) from hint_purchases) = 0, 'Tier 2 first charged nothing'; end $$;

create temp table h1 as select pg_temp.tv(1) as v, pg_temp.hint(1, 1, 1, 1, 32) as j;
do $$
declare j jsonb := (select j from h1); hp hint_purchases%rowtype; lt coin_transactions%rowtype;
begin
  assert not (j->>'replayed')::boolean and not (j->>'already_owned')::boolean and (j->>'tier')::int = 1;
  assert j->'hint'->>'body_md' like '%Hint 1 for question 1%', 'the text is returned on purchase';
  assert pg_temp.coins(1) = 380 and (j->'state'->'team'->>'coins')::int = 380, 'charged hints.cost (20)';
  select * into hp from hint_purchases where team_id = pg_temp.team_id(1);
  assert hp.hint_id = 1 and hp.cost_paid = 20 and hp.purchased_by = pg_temp.member_id(1, 1) and hp.purchased_at = timestamptz '2026-12-01 12:01:00+00';
  select * into lt from coin_transactions where team_id = pg_temp.team_id(1) and type = 'HINT_PURCHASE';
  assert lt.amount = -20 and lt.balance_after = 380 and lt.hint_id = 1 and lt.question_id = 1 and lt.member_id = pg_temp.member_id(1, 1);
  assert pg_temp.tv(1) = (select v from h1) + 1, 'one version bump';
  assert (select payload->>'cost' = '20' and payload->>'balance_before' = '400' and payload->>'balance_after' = '380' and actor_kind = 'MEMBER'
            from audit_events where event_type = 'HINT_PURCHASED' and team_id = pg_temp.team_id(1));
  -- the question now shows the text, and Tier 2 became purchasable
  assert (j->'question'->'hints'->0->>'owned')::boolean and j->'question'->'hints'->0->>'body_md' like '%Hint 1 for question 1%';
  assert (j->'question'->'hints'->1->>'purchasable')::boolean and not (j->'question'->'hints'->1 ? 'body_md'), 'Tier 2 text stays hidden';
end $$;
-- a teammate buying the same hint (new key): no second charge, no ledger row, no version bump
do $$
declare v bigint := pg_temp.tv(1); j jsonb;
begin
  j := pg_temp.hint(1, 3, 1, 1, 33);
  assert (j->>'already_owned')::boolean and not (j->>'replayed')::boolean and j->'hint'->>'body_md' like '%Hint 1 for question 1%';
  assert pg_temp.coins(1) = 380 and pg_temp.ledger(1, 'HINT_PURCHASE') = 1 and pg_temp.tv(1) = v and (select count(*) from hint_purchases) = 1;
  -- the same key replays the stored response; the same key for another parameter is refused
  j := pg_temp.hint(1, 1, 1, 1, 32);
  assert (j->>'replayed')::boolean and pg_temp.coins(1) = 380 and pg_temp.ledger(1, 'HINT_PURCHASE') = 1;
end $$;
select pg_temp.rejects($s$select pg_temp.hint(1, 1, 1, 2, 32)$s$, 'IDEMPOTENCY_KEY_REUSED');
select pg_temp.rejects($s$select pg_temp.hint(1, 2, 1, 1, 32)$s$, 'IDEMPOTENCY_KEY_REUSED');
-- another team sees none of it
do $$
declare j jsonb;
begin
  select pg_temp.q(2, 1, 1) into j;
  assert not (j->'hints'->0->>'owned')::boolean and not (j->'hints'->0 ? 'body_md') and j::text not like '%Hint 1 for question%', 'team 2 owns nothing';
  assert pg_temp.state(1, 1)::text not like '%Hint 1 for question%' and pg_temp.state(2, 1)::text not like '%Hint%question%', 'hint text never travels in the team snapshot';
end $$;

-- ===== 3. Hint 2 while the answer awaits review (PENDING_APPROVAL) ===================================================
select pg_temp.at('2026-12-01 12:02:00+00');
select pg_temp.submit(1, 1, 1, 'ans', 40);
do $$ begin assert (pg_temp.tq(1, 1)).state = 'PENDING_APPROVAL'; end $$;
do $$
declare j jsonb := pg_temp.hint(1, 2, 1, 2, 41);
begin
  assert not (j->>'already_owned')::boolean and j->'hint'->>'body_md' like '%Hint 2 for question 1%';
  assert pg_temp.coins(1) = 340 and (select cost_paid = 40 from hint_purchases where hint_id = 2 and team_id = pg_temp.team_id(1)), 'Hint 2 costs hints.cost (40)';
end $$;

-- ===== 4. APPROVED: hints are still allowed ========================================================================
select pg_temp.at('2026-12-01 12:03:00+00');
select pg_temp.approve(pg_temp.staff(2), pg_temp.sub(1, 1), 42);                          -- Q1 APPROVED, +50; Q2 ACTIVE (deadline 12:07)
do $$ begin assert (pg_temp.tq(1, 1)).state = 'APPROVED' and (pg_temp.tq(1, 2)).state = 'ACTIVE' and pg_temp.coins(1) = 390; end $$;
select pg_temp.at('2026-12-01 12:04:00+00');
select pg_temp.hint(1, 1, 2, 1, 43);                                                       -- Q2 ACTIVE: Hint 1 (20)
select pg_temp.submit(1, 1, 2, 'ans2', 44);
select pg_temp.approve(pg_temp.staff(2), pg_temp.sub(1, 2), 45);                          -- Q2 APPROVED, +50; Q3 ACTIVE (deadline 12:08)
do $$ begin assert (pg_temp.tq(1, 2)).state = 'APPROVED' and (pg_temp.tq(1, 3)).state = 'ACTIVE' and pg_temp.coins(1) = 420; end $$;
select pg_temp.hint(1, 4, 2, 2, 46);                                                       -- Q2 APPROVED: Hint 2 (40)
do $$ begin
  assert pg_temp.coins(1) = 380 and pg_temp.ledger(1, 'HINT_PURCHASE') = 4, 'an APPROVED question still sells hints';
  assert (select count(*) from hint_purchases where team_id = pg_temp.team_id(1)) = 4;
end $$;

-- ===== 5. prices are data: change the rows, the next purchase follows ===============================================
update hints set cost = 55 where question_id = 3 and tier = 1;
update hints set cost = 0  where question_id = 3 and tier = 2;
do $$
declare j jsonb; c0 int := pg_temp.coins(1); l0 bigint := pg_temp.ledger(1, 'HINT_PURCHASE');
begin
  assert (pg_temp.q(1, 1, 3)->'hints'->0->>'cost')::int = 55 and (pg_temp.q(1, 1, 3)->'hints'->1->>'cost')::int = 0, 'the question shows the new prices';
  j := pg_temp.hint(1, 1, 3, 1, 47);
  assert pg_temp.coins(1) = c0 - 55 and (select cost_paid = 55 from hint_purchases where hint_id = 5 and team_id = pg_temp.team_id(1)), 'charged the new price';
  j := pg_temp.hint(1, 1, 3, 2, 48);
  assert pg_temp.coins(1) = c0 - 55 and pg_temp.ledger(1, 'HINT_PURCHASE') = l0 + 1, 'a free hint writes no ledger row';
  assert (select cost_paid = 0 from hint_purchases where hint_id = 6 and team_id = pg_temp.team_id(1)), 'but the purchase is recorded';
  assert (select cost_paid = 20 from hint_purchases where hint_id = 1 and team_id = pg_temp.team_id(1)), 'history keeps the price actually paid';
end $$;
update hints set cost = 20 where question_id = 3 and tier = 1;
update hints set cost = 40 where question_id = 3 and tier = 2;

-- ===== 6. INSUFFICIENT_COINS: team 2 has 0 coins =====================================================================
select pg_temp.at('2026-12-01 12:05:00+00');
select pg_temp.enter(2, 1, 1, 50);
do $$
declare d text; v bigint := pg_temp.tv(2);
begin
  begin perform pg_temp.hint(2, 1, 1, 1, 51); raise exception 'hint bought with no coins';
  exception when others then
    get stacked diagnostics d = pg_exception_detail;
    assert sqlerrm = 'INSUFFICIENT_COINS' and (d::jsonb->>'have')::int = 0 and (d::jsonb->>'need')::int = 20, sqlerrm || d;
  end;
  begin perform pg_temp.time(2, 1, 1, 1, 0, 52); raise exception 'time bought with no coins';
  exception when others then
    get stacked diagnostics d = pg_exception_detail;
    assert sqlerrm = 'INSUFFICIENT_COINS' and (d::jsonb->>'need')::int = 20, sqlerrm || d;
  end;
  assert pg_temp.coins(2) = 0 and pg_temp.tv(2) = v and not exists (select 1 from hint_purchases where team_id = pg_temp.team_id(2))
         and not exists (select 1 from team_time_purchases where team_id = pg_temp.team_id(2));
end $$;

-- ===== 7. Buy Time ====================================================================================================
-- Q3 (team 1) is ACTIVE with deadline 12:08. Q6 gives us a second, independent ACTIVE question.
select pg_temp.at('2026-12-01 12:05:30+00');
select pg_temp.unlock(1, 1, 2, 60);
select pg_temp.enter(1, 1, 6, 61);                                                          -- Q6 ACTIVE, deadline 12:09:30
create temp table bt0 as select
  (select ends_at from teams where id = pg_temp.team_id(1)) as ends_at, (pg_temp.tq(1, 6)).timer_deadline as q6_deadline,
  pg_temp.coins(1) as coins, pg_temp.tv(1) as v;
select pg_temp.at('2026-12-01 12:06:00+00');
-- refusals that charge nothing
select pg_temp.rejects($s$select pg_temp.time(1, 1, 3, 7, 1, 70)$s$, 'STALE_PURCHASE_COUNT');   -- the caller thinks one purchase exists; there are none
do $$ declare d text; begin
  begin perform pg_temp.time(1, 1, 3, 7, 4, 70); raise exception 'stale accepted';
  exception when others then get stacked diagnostics d = pg_exception_detail; assert sqlerrm = 'STALE_PURCHASE_COUNT' and (d::jsonb->>'count')::int = 0, sqlerrm || d; end;
end $$;
select pg_temp.rejects($s$select pg_temp.time(1, 1, 3, 16, 0, 71)$s$, 'NOT_FOUND');              -- an option of ANOTHER question
select pg_temp.rejects($s$select pg_temp.time(1, 1, 3, 999, 0, 72)$s$, 'NOT_FOUND');
select pg_temp.rejects($s$select pg_temp.time(1, 1, 999, 7, 0, 73)$s$, 'NOT_FOUND');
select pg_temp.rejects($s$select pg_temp.time(1, 1, 11, 31, 0, 74)$s$, 'THEME_LOCKED');
select pg_temp.rejects($s$select pg_temp.time(1, 1, 3, 7, -1, 75)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.buy_time(pg_temp.team_id(1), pg_temp.member_id(1, 1), 3::smallint, null, 0, pg_temp.key(76))$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.buy_time(pg_temp.team_id(1), pg_temp.member_id(1, 1), 3::smallint, 7::smallint, null, pg_temp.key(76))$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.buy_time(pg_temp.team_id(1), pg_temp.member_id(2, 1), 3::smallint, 7::smallint, 0, pg_temp.key(77))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select pg_temp.time(1, 1, 2, 4, 0, 78)$s$, 'QUESTION_NOT_ACTIVE');        -- Q2 is APPROVED
do $$ begin assert pg_temp.coins(1) = (select coins from bt0) and pg_temp.tv(1) = (select v from bt0), 'refusals changed nothing'; end $$;

-- the purchase: +120 s for 20 coins
create temp table bt1 as select pg_temp.time(1, 1, 3, 7, 0, 80) as j;
do $$
declare j jsonb := (select j from bt1); tq team_questions%rowtype; lt coin_transactions%rowtype; tp team_time_purchases%rowtype;
begin
  tq := pg_temp.tq(1, 3);
  assert (j->'purchase'->>'seq')::int = 1 and (j->'purchase'->>'seconds')::int = 120 and (j->'purchase'->>'cost')::int = 20 and (j->'purchase'->>'option_id')::int = 7;
  assert tq.timer_deadline = timestamptz '2026-12-01 12:10:00+00', 'deadline 12:08 + 120 s';
  assert tq.extra_seconds = 120 and tq.time_purchase_count = 1 and tq.state = 'ACTIVE';
  assert pg_temp.coins(1) = (select coins from bt0) - 20;
  select * into lt from coin_transactions where team_id = pg_temp.team_id(1) and type = 'TIME_PURCHASE';
  assert lt.amount = -20 and lt.question_id = 3 and lt.purchase_seq = 1 and lt.balance_after = pg_temp.coins(1);
  select * into tp from team_time_purchases where team_id = pg_temp.team_id(1) and question_id = 3;
  assert tp.seq = 1 and tp.option_id = 7 and tp.seconds_added = 120 and tp.cost_paid = 20 and tp.purchased_by = pg_temp.member_id(1, 1);
  assert (j->'question'->>'deadline')::bigint = floor(extract(epoch from timestamptz '2026-12-01 12:10:00+00') * 1000);
  assert (j->'question'->'buy_time'->>'purchase_count')::int = 1 and (j->'question'->'buy_time'->>'extra_seconds')::int = 120;
  assert pg_temp.tv(1) = (select v from bt0) + 1;
  -- THE TEAM TIMER IS NOT EXTENDED, and no other question moved
  assert (select ends_at from teams where id = pg_temp.team_id(1)) = (select ends_at from bt0), 'teams.ends_at unchanged';
  assert (pg_temp.tq(1, 6)).timer_deadline = (select q6_deadline from bt0), 'another question keeps its deadline';
  assert (select payload->>'old_deadline' <> payload->>'new_deadline' and (payload->>'seconds')::int = 120 from audit_events where event_type = 'TIME_PURCHASED' and team_id = pg_temp.team_id(1));
end $$;
-- a teammate who still sees purchase_count 0 loses the race (nothing charged); with the right count the next purchase works
do $$
declare c int := pg_temp.coins(1); j jsonb;
begin
  begin perform pg_temp.time(1, 2, 3, 8, 0, 81); raise exception 'double click accepted';
  exception when others then assert sqlerrm = 'STALE_PURCHASE_COUNT', sqlerrm; end;
  assert pg_temp.coins(1) = c;
  j := pg_temp.time(1, 2, 3, 8, 1, 82);                                                      -- +240 s for 40
  assert (j->'purchase'->>'seq')::int = 2 and pg_temp.coins(1) = c - 40;
  assert (pg_temp.tq(1, 3)).timer_deadline = timestamptz '2026-12-01 12:14:00+00' and (pg_temp.tq(1, 3)).time_purchase_count = 2 and (pg_temp.tq(1, 3)).extra_seconds = 360;
  assert (select array_agg(purchase_seq order by purchase_seq) from coin_transactions where team_id = pg_temp.team_id(1) and type = 'TIME_PURCHASE') = array[1, 2];
  -- idempotency: same key replays, the same key with another parameter is refused
  j := pg_temp.time(1, 2, 3, 8, 1, 82);
  assert (j->>'replayed')::boolean and pg_temp.coins(1) = c - 40 and (pg_temp.tq(1, 3)).time_purchase_count = 2;
end $$;
select pg_temp.rejects($s$select pg_temp.time(1, 2, 3, 9, 1, 82)$s$, 'IDEMPOTENCY_KEY_REUSED');

-- the per-team cap (content data): option 9 may be bought once
update question_buy_time_options set max_purchases = 1 where id = 9;
select pg_temp.time(1, 1, 3, 9, 2, 83);                                                      -- +480 s for 80
select pg_temp.rejects($s$select pg_temp.time(1, 1, 3, 9, 3, 84)$s$, 'TIME_PURCHASE_LIMIT');
do $$ begin
  assert (pg_temp.tq(1, 3)).time_purchase_count = 3 and (pg_temp.tq(1, 3)).timer_deadline = timestamptz '2026-12-01 12:22:00+00';
  assert (select count(*) from team_time_purchases where team_id = pg_temp.team_id(1) and question_id = 3) = 3;
end $$;
-- seconds and cost are data too
update question_buy_time_options set seconds = 100, cost = 5 where id = 7;
do $$
declare c int := pg_temp.coins(1);
begin
  assert (pg_temp.q(1, 1, 3)->'buy_time'->'options'->0->>'seconds')::int = 100, 'the question lists the new seconds';
  perform pg_temp.time(1, 1, 3, 7, 3, 85);
  assert pg_temp.coins(1) = c - 5 and (pg_temp.tq(1, 3)).timer_deadline = timestamptz '2026-12-01 12:23:40+00', 'new seconds and price applied';
  assert (select seconds_added = 120 and cost_paid = 20 from team_time_purchases where team_id = pg_temp.team_id(1) and question_id = 3 and seq = 1), 'history is a snapshot';
end $$;
-- a free option: recorded, no ledger row
update question_buy_time_options set cost = 0 where id = 8;
do $$
declare c int := pg_temp.coins(1); l bigint := pg_temp.ledger(1, 'TIME_PURCHASE');
begin
  perform pg_temp.time(1, 1, 3, 8, 4, 86);
  assert pg_temp.coins(1) = c and pg_temp.ledger(1, 'TIME_PURCHASE') = l and (pg_temp.tq(1, 3)).time_purchase_count = 5;
  assert exists (select 1 from team_time_purchases where team_id = pg_temp.team_id(1) and question_id = 3 and seq = 5 and cost_paid = 0);
end $$;

-- ===== 8. states that cannot buy time ===============================================================================
-- Q6's deadline (12:09:30) passes: TIMED_OUT, for hints and time alike; nothing is written
select pg_temp.at('2026-12-01 12:20:00+00');
do $$
declare c int := pg_temp.coins(1); v bigint := pg_temp.tv(1);
begin
  begin perform pg_temp.time(1, 1, 6, 16, 0, 90); raise exception 'time bought for a timed-out question';
  exception when others then assert sqlerrm = 'QUESTION_TIMED_OUT', sqlerrm; end;
  begin perform pg_temp.hint(1, 1, 6, 1, 91); raise exception 'hint bought for a timed-out question';
  exception when others then assert sqlerrm = 'QUESTION_TIMED_OUT', sqlerrm; end;
  assert pg_temp.coins(1) = c and pg_temp.tv(1) = v;
end $$;
-- PENDING_APPROVAL: the timer is frozen, so no time can be bought (hints can, see section 3)
select pg_temp.submit(1, 1, 3, 'ans3', 92);
select pg_temp.rejects($s$select pg_temp.time(1, 1, 3, 9, 5, 93)$s$, 'QUESTION_NOT_ACTIVE');

-- ===== 9. nothing leaks, nothing drifts ==============================================================================
do $$ begin
  assert not exists (select 1 from app.invariant_coin_balance_mismatch), 'teams.coins equals the ledger';
  assert (select coins from teams where id = pg_temp.team_id(1)) = (select balance_after from coin_transactions where team_id = pg_temp.team_id(1) order by id desc limit 1);
  assert (select count(*) from audit_events where event_type = 'HINT_PURCHASED' and team_id = pg_temp.team_id(1)) = (select count(*) from hint_purchases where team_id = pg_temp.team_id(1));
  assert (select count(*) from audit_events where event_type = 'TIME_PURCHASED' and team_id = pg_temp.team_id(1)) = (select count(*) from team_time_purchases where team_id = pg_temp.team_id(1));
  assert (select count(*) from request_log where response::text ~* '(hash|password|secret)') = 0;
end $$;
-- privileges: service_role only
do $$ begin
  assert not has_function_privilege('anon', 'public.buy_hint(uuid, uuid, smallint, smallint, uuid)', 'execute');
  assert not has_function_privilege('authenticated', 'public.buy_hint(uuid, uuid, smallint, smallint, uuid)', 'execute');
  assert not has_function_privilege('anon', 'public.buy_time(uuid, uuid, smallint, smallint, int, uuid)', 'execute');
  assert not has_function_privilege('authenticated', 'public.buy_time(uuid, uuid, smallint, smallint, int, uuid)', 'execute');
  assert has_function_privilege('service_role', 'public.buy_hint(uuid, uuid, smallint, smallint, uuid)', 'execute');
  assert has_function_privilege('service_role', 'public.buy_time(uuid, uuid, smallint, smallint, int, uuid)', 'execute');
end $$;
rollback;

-- ===== 10. Buy Time may carry a question past the team's end, but never moves the team's end ========================
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
create function pg_temp.tq(t int, q int) returns team_questions language sql as
  $$ select * from team_questions where team_id = pg_temp.team_id(t) and question_id = q $$;

select public.set_competition_status(pg_temp.staff(1), 'open', pg_temp.key(1));
select public.start_team_competition(pg_temp.team_id(1), pg_temp.member_id(1, 1), pg_temp.key(2));            -- ends 16:00
select public.unlock_theme(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint, pg_temp.key(3));
select pg_temp.at('2026-12-01 15:57:00+00');
select public.start_question(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint, pg_temp.key(4));      -- deadline 16:01, already past the team's end
select pg_temp.at('2026-12-01 15:58:00+00');
select public.buy_time(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint, 3::smallint, 0, pg_temp.key(5));   -- +480 s
do $$
declare s jsonb; q jsonb;
begin
  assert (select ends_at = timestamptz '2026-12-01 16:00:00+00' and timer_seconds = 14400 from teams where id = pg_temp.team_id(1)), 'the team end is untouched';
  assert (pg_temp.tq(1, 1)).timer_deadline = timestamptz '2026-12-01 16:09:00+00', 'the question deadline MAY pass the team end';
  s := public.get_team_state(pg_temp.team_id(1), pg_temp.member_id(1, 1));
  assert (s->'team'->>'remaining_seconds')::int = 120, 'the team still has only its own 2 minutes';
end $$;
-- at the team's end nothing more can be bought or submitted, although the question still has minutes left
select pg_temp.at('2026-12-01 16:00:00+00');
do $$ begin
  begin perform public.buy_time(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint, 3::smallint, 1, pg_temp.key(6)); raise exception 'time bought after the end';
  exception when others then assert sqlerrm = 'TEAM_ENDED', sqlerrm; end;
  begin perform public.buy_hint(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint, 1::smallint, pg_temp.key(7)); raise exception 'hint bought after the end';
  exception when others then assert sqlerrm = 'TEAM_ENDED', sqlerrm; end;
  begin perform public.submit_answer(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint, 'late', 'x', pg_temp.key(8)); raise exception 'solution accepted after the end';
  exception when others then assert sqlerrm = 'TEAM_ENDED', sqlerrm; end;
  assert not exists (select 1 from submissions) and (select time_purchase_count = 1 from team_questions where team_id = pg_temp.team_id(1) and question_id = 1);
end $$;
select public.finalize_team_if_due(pg_temp.team_id(1));
do $$
declare q jsonb;
begin
  assert (select status = 'ENDED' and ended_at = ends_at from teams where id = pg_temp.team_id(1));
  assert (pg_temp.tq(1, 1)).state = 'ACTIVE', 'the question still has time of its own, so it stays ACTIVE (frozen)';
  q := public.get_question_for_team(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint)->'question';
  assert (q->>'remaining_seconds')::int = 540 and not (q->'buy_time'->>'can_buy')::boolean, 'frozen at 9 minutes; nothing can be bought';
  assert not exists (select 1 from jsonb_array_elements(q->'hints') h where (h->>'purchasable')::boolean), 'no hint is purchasable on a frozen team';
end $$;
rollback;

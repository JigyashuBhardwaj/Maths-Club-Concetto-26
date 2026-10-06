-- Coin ledger integrity: immutable, balance chain, idempotency, no duplicate spend/reward.
begin;
\ir include/helpers.sql
\ir include/fixture.sql

do $$ begin
  assert (select initial_coins from competition) = 500, 'every team starts with 500 coins';
  assert not exists (select 1 from app.invariant_coin_balance_mismatch), 'teams.coins equals the ledger balance';
end $$;

-- unlock a theme for team 1 (balance 500 -> 400): the ledger row names the theme
insert into team_themes (team_id, theme_id, unlocked_by, unlocked_at, cost_paid)
values ('00000000-0000-0000-0000-0000000000b1', 1, '00000000-0000-0000-0000-00000000c101', now(), 100);
insert into coin_transactions (team_id, type, amount, balance_after, theme_id, member_id, created_at)
values ('00000000-0000-0000-0000-0000000000b1', 'THEME_UNLOCK', -100, 400, 1, '00000000-0000-0000-0000-00000000c101', now());
update teams set coins = 400 where team_code = 'T01';
do $$ begin assert not exists (select 1 from app.invariant_coin_balance_mismatch); end $$;

-- no duplicate deduction / reward / grant
select pg_temp.rejects($s$insert into coin_transactions (team_id, type, amount, balance_after, theme_id, created_at) values ('00000000-0000-0000-0000-0000000000b1', 'THEME_UNLOCK', -100, 300, 1, now())$s$, 'ctx_theme');
select pg_temp.rejects($s$insert into coin_transactions (team_id, type, amount, balance_after, created_at) values ('00000000-0000-0000-0000-0000000000b1', 'INITIAL_GRANT', 500, 900, now())$s$, 'ctx_initial');
insert into coin_transactions (team_id, type, amount, balance_after, question_id, created_at)
values ('00000000-0000-0000-0000-0000000000b1', 'QUESTION_REWARD', 50, 450, 1, now());
select pg_temp.rejects($s$insert into coin_transactions (team_id, type, amount, balance_after, question_id, created_at) values ('00000000-0000-0000-0000-0000000000b1', 'QUESTION_REWARD', 50, 500, 1, now())$s$, 'ctx_reward');
-- buy-time purchases are idempotent per (team, question, sequence number)
insert into coin_transactions (team_id, type, amount, balance_after, question_id, purchase_seq, created_at)
values ('00000000-0000-0000-0000-0000000000b1', 'TIME_PURCHASE', -20, 430, 1, 1, now());
select pg_temp.rejects($s$insert into coin_transactions (team_id, type, amount, balance_after, question_id, purchase_seq, created_at) values ('00000000-0000-0000-0000-0000000000b1', 'TIME_PURCHASE', -20, 410, 1, 1, now())$s$, 'ctx_time');
insert into coin_transactions (team_id, type, amount, balance_after, question_id, purchase_seq, created_at)
values ('00000000-0000-0000-0000-0000000000b1', 'TIME_PURCHASE', -20, 410, 1, 2, now());   -- a second, distinct purchase is fine
-- hint purchases: one per team and hint
insert into coin_transactions (team_id, type, amount, balance_after, hint_id, created_at)
values ('00000000-0000-0000-0000-0000000000b1', 'HINT_PURCHASE', -40, 370, 1, now());
select pg_temp.rejects($s$insert into coin_transactions (team_id, type, amount, balance_after, hint_id, created_at) values ('00000000-0000-0000-0000-0000000000b1', 'HINT_PURCHASE', -40, 330, 1, now())$s$, 'ctx_hint');

-- balance chain: balance_after must be previous balance + amount; never negative
select pg_temp.rejects($s$insert into coin_transactions (team_id, type, amount, balance_after, hint_id, created_at) values ('00000000-0000-0000-0000-0000000000b1', 'HINT_PURCHASE', -80, 999, 2, now())$s$, 'LEDGER_BALANCE_MISMATCH');
select pg_temp.rejects($s$insert into coin_transactions (team_id, type, amount, balance_after, hint_id, created_at) values ('00000000-0000-0000-0000-0000000000b1', 'HINT_PURCHASE', -400, -30, 2, now())$s$, 'coin_transactions_balance_after_check');
-- the initial grant must equal competition.initial_coins (500)
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
values ('00000000-0000-0000-0000-0000000000b3', 'T03', 'Test Team 3', 'test_team_03', 'TEST-NOT-A-HASH', '00000000-0000-0000-0000-0000000000a2', 500);
select pg_temp.rejects($s$insert into coin_transactions (team_id, type, amount, balance_after, created_at) values ('00000000-0000-0000-0000-0000000000b3', 'INITIAL_GRANT', 400, 400, now())$s$, 'LEDGER_INITIAL_GRANT_MISMATCH');
insert into coin_transactions (team_id, type, amount, balance_after, created_at) values ('00000000-0000-0000-0000-0000000000b3', 'INITIAL_GRANT', 500, 500, now());
-- sign rules and required subject
select pg_temp.rejects($s$insert into coin_transactions (team_id, type, amount, balance_after, theme_id, created_at) values ('00000000-0000-0000-0000-0000000000b1', 'THEME_UNLOCK', 100, 470, 2, now())$s$, 'coin_tx_sign');
select pg_temp.rejects($s$insert into coin_transactions (team_id, type, amount, balance_after, created_at) values ('00000000-0000-0000-0000-0000000000b1', 'THEME_UNLOCK', -10, 360, now())$s$, 'coin_tx_subject');
select pg_temp.rejects($s$insert into coin_transactions (team_id, type, amount, balance_after, question_id, created_at) values ('00000000-0000-0000-0000-0000000000b1', 'QUESTION_REWARD', 0, 370, 2, now())$s$, 'coin_transactions_amount_check');
select pg_temp.rejects($s$insert into coin_transactions (team_id, type, amount, balance_after, created_at) values ('00000000-0000-0000-0000-0000000000b1', 'ADMIN_ADJUSTMENT', 10, 380, now())$s$, 'coin_tx_subject');   -- needs staff_id
-- a ledger row must reference an existing team, and a member of that same team
select pg_temp.rejects($s$insert into coin_transactions (team_id, type, amount, balance_after, hint_id, member_id, created_at) values ('00000000-0000-0000-0000-0000000000b1', 'HINT_PURCHASE', -80, 290, 2, '00000000-0000-0000-0000-00000000c201', now())$s$, 'coin_tx_member_in_team');
-- balances are per team: team 2 is unaffected
do $$ begin assert (select coins from teams where team_code = 'T02') = 500 and (select balance_after from coin_transactions where team_id = '00000000-0000-0000-0000-0000000000b2') = 500; end $$;
-- ADMIN_ADJUSTMENT with a staff actor is allowed (compensations are new rows, never edits)
insert into coin_transactions (team_id, type, amount, balance_after, staff_id, created_at)
values ('00000000-0000-0000-0000-0000000000b1', 'ADMIN_ADJUSTMENT', 30, 400, '00000000-0000-0000-0000-0000000000a1', now());

-- immutability: no update, delete or truncate of the ledger
select pg_temp.rejects($s$update coin_transactions set amount = amount$s$, 'append-only');
select pg_temp.rejects($s$delete from coin_transactions$s$, 'append-only');
select pg_temp.rejects($s$truncate coin_transactions$s$, 'append-only');

-- a mismatching authoritative balance is detectable
update teams set coins = 123 where team_code = 'T01';
do $$ begin assert (select count(*) from app.invariant_coin_balance_mismatch) = 1, 'the checker finds a drifted balance'; end $$;
rollback;

-- Patch B / migration 6 of 9 — submissions (full history) and the immutable coin ledger.

create table submissions (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null references teams(id) on delete restrict,
  question_id   smallint not null references questions(id) on delete restrict,
  member_id     uuid not null,                         -- the member (M1–M4) who pressed Submit
  answer        text not null check (length(answer) between 1 and 10000),
  explanation   text not null check (length(explanation) <= 10000),
  status        submission_status not null default 'PENDING',
  submitted_at  timestamptz not null,
  reviewed_by   uuid references staff_users(id) on delete restrict,
  reviewed_at   timestamptz,
  review_note   text,                    -- optional reviewer note shown to the team
  reward_awarded int check (reward_awarded is null or reward_awarded >= 0),
  created_at    timestamptz not null default now(),
  constraint submissions_member_in_team foreign key (member_id, team_id) references team_members(id, team_id) on delete restrict,
  constraint submissions_reviewed_iff_decided check ((status = 'PENDING') = (reviewed_at is null)),
  constraint submissions_decided_has_reviewer check (status = 'PENDING' or reviewed_by is not null),
  constraint submissions_reward_only_if_approved check (reward_awarded is null or status = 'APPROVED')
);
-- only ONE pending submission per team+question, enforced by the database; REJECTED rows stay forever (auditable)
create unique index submissions_one_pending on submissions (team_id, question_id) where status = 'PENDING';
create index submissions_queue_idx on submissions (submitted_at) where status = 'PENDING';
create index submissions_team_idx  on submissions (team_id, question_id, submitted_at);
create index submissions_member_idx on submissions (member_id);

-- Immutable ledger. teams.coins is the authoritative balance; the ledger explains every change to it.
create table coin_transactions (
  id              bigserial primary key,
  team_id         uuid not null references teams(id) on delete restrict,
  type            coin_tx_type not null,
  amount          int  not null check (amount <> 0),               -- signed: spends negative, rewards positive
  balance_after   int  not null check (balance_after >= 0),
  theme_id        smallint references themes(id) on delete restrict,
  hint_id         smallint references hints(id) on delete restrict,
  question_id     smallint references questions(id) on delete restrict,
  submission_id   uuid     references submissions(id) on delete restrict,
  purchase_seq    int,                           -- TIME_PURCHASE: team_questions.time_purchase_count after the buy
  member_id       uuid,
  staff_id        uuid references staff_users(id) on delete restrict,
  created_at      timestamptz not null,
  constraint coin_tx_member_in_team foreign key (member_id, team_id) references team_members(id, team_id) on delete restrict,
  constraint coin_tx_sign check (
        (type in ('THEME_UNLOCK', 'HINT_PURCHASE', 'TIME_PURCHASE') and amount < 0)
     or (type in ('INITIAL_GRANT', 'QUESTION_REWARD') and amount > 0)
     or type = 'ADMIN_ADJUSTMENT'),
  -- each spend/reward names the thing it is for, so it can be made idempotent below
  constraint coin_tx_subject check (
        (type = 'THEME_UNLOCK'    and theme_id is not null)
     or (type = 'HINT_PURCHASE'   and hint_id is not null)
     or (type = 'TIME_PURCHASE'   and question_id is not null and purchase_seq is not null)
     or (type = 'QUESTION_REWARD' and question_id is not null)
     or (type = 'ADMIN_ADJUSTMENT' and staff_id is not null)
     or (type = 'INITIAL_GRANT')),
  constraint coin_tx_purchase_seq_positive check (purchase_seq is null or purchase_seq >= 1)
);
-- "cannot happen twice" guarantees, enforced at the ledger level (no duplicate grant, deduction or reward)
create unique index ctx_initial    on coin_transactions (team_id)                            where type = 'INITIAL_GRANT';
create unique index ctx_theme      on coin_transactions (team_id, theme_id)                  where type = 'THEME_UNLOCK';
create unique index ctx_hint       on coin_transactions (team_id, hint_id)                   where type = 'HINT_PURCHASE';
create unique index ctx_reward     on coin_transactions (team_id, question_id)               where type = 'QUESTION_REWARD';
create unique index ctx_time       on coin_transactions (team_id, question_id, purchase_seq) where type = 'TIME_PURCHASE';
create index ctx_team_idx          on coin_transactions (team_id, id);

-- Append-only: ledger rows are never updated, deleted or truncated (corrections are new ADMIN_ADJUSTMENT rows).
create function app.ledger_immutable() returns trigger language plpgsql as $$
begin raise exception 'coin_transactions is append-only'; end $$;
create trigger coin_tx_no_update before update or delete on coin_transactions
  for each row execute function app.ledger_immutable();
create trigger coin_tx_no_truncate before truncate on coin_transactions
  for each statement execute function app.ledger_immutable();

-- Running-balance chain: balance_after must equal the previous balance + amount (0 before the first row), and the
-- INITIAL_GRANT must equal competition.initial_coins. Concurrent inserts for one team serialise on the team row lock.
create function app.ledger_balance_chain() returns trigger language plpgsql as $$
declare prev int;
begin
  perform 1 from teams where id = new.team_id for update;
  select balance_after into prev from coin_transactions where team_id = new.team_id order by id desc limit 1;
  prev := coalesce(prev, 0);
  if new.balance_after <> prev + new.amount then
    raise exception 'LEDGER_BALANCE_MISMATCH: balance_after % <> % + %', new.balance_after, prev, new.amount
      using errcode = 'P0001';
  end if;
  if new.type = 'INITIAL_GRANT' and new.amount <> (select initial_coins from competition where id = 1) then
    raise exception 'LEDGER_INITIAL_GRANT_MISMATCH' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger coin_tx_balance_chain before insert on coin_transactions
  for each row execute function app.ledger_balance_chain();

-- Follow-up to Patch B / migration 10 — multiple configurable Buy Time options per question.
--
-- The participant UI offers three Buy Time options per question. The earlier single (buy_time_seconds, buy_time_cost,
-- max_time_purchases) triple on `questions` cannot represent that, so the options become a normalised table and the
-- triple is removed. Seconds, prices and caps are CONTENT DATA (seeded as placeholders), not constants in any engine code.

create table question_buy_time_options (
  id             smallint primary key check (id > 0),
  question_id    smallint not null references questions(id) on delete restrict,
  seconds        int      not null check (seconds > 0),
  cost           int      not null check (cost >= 0),
  max_purchases  int      check (max_purchases is null or max_purchases >= 0),   -- per team and question; null = unlimited
  display_order  smallint not null check (display_order > 0),
  unique (question_id, display_order),
  unique (question_id, seconds),          -- two options for the same question never add the same time
  unique (id, question_id)                -- lets purchases prove "this option belongs to this question"
);
create index qbto_question_idx on question_buy_time_options (question_id, display_order);

alter table questions
  drop column buy_time_seconds,
  drop column buy_time_cost,
  drop column max_time_purchases;

-- One row per Buy Time purchase: a snapshot of what was bought and paid, so later content edits never rewrite history.
-- (team_id, question_id, seq) mirrors coin_transactions.purchase_seq and team_questions.time_purchase_count, which makes
-- the future atomic `buy_time` operation idempotent (a retried or replayed purchase is rejected) and detects double clicks.
create table team_time_purchases (
  team_id       uuid     not null references teams(id) on delete restrict,
  question_id   smallint not null,
  seq           int      not null check (seq >= 1),
  option_id     smallint not null,
  seconds_added int      not null check (seconds_added > 0),
  cost_paid     int      not null check (cost_paid >= 0),
  purchased_by  uuid     not null,
  purchased_at  timestamptz not null,
  primary key (team_id, question_id, seq),
  constraint ttp_team_question_fk foreign key (team_id, question_id) references team_questions(team_id, question_id) on delete restrict,
  constraint ttp_option_fk        foreign key (option_id, question_id) references question_buy_time_options(id, question_id) on delete restrict,
  constraint ttp_member_in_team   foreign key (purchased_by, team_id) references team_members(id, team_id) on delete restrict
);
create index ttp_option_idx on team_time_purchases (team_id, question_id, option_id);

-- Database-level guards for the future buy_time operation (the operation itself is Phase 5):
--   * only while the question is ACTIVE, * seq is the next number (no gaps, no replays),
--   * the recorded seconds/cost equal the option's configuration, * the option's per-team cap is not exceeded.
create function app.time_purchase_guard() returns trigger language plpgsql as $$
declare o question_buy_time_options; used int;
begin
  if (select state from team_questions where team_id = new.team_id and question_id = new.question_id) is distinct from 'ACTIVE' then
    raise exception 'BUY_TIME_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if new.seq <> (select count(*) from team_time_purchases where team_id = new.team_id and question_id = new.question_id) + 1 then
    raise exception 'TIME_PURCHASE_SEQ_MISMATCH' using errcode = 'P0001';
  end if;
  select * into o from question_buy_time_options where id = new.option_id and question_id = new.question_id;
  if found then
    if new.seconds_added <> o.seconds or new.cost_paid <> o.cost then
      raise exception 'BUY_TIME_OPTION_MISMATCH' using errcode = 'P0001';
    end if;
    select count(*) into used from team_time_purchases
     where team_id = new.team_id and question_id = new.question_id and option_id = new.option_id;
    if o.max_purchases is not null and used >= o.max_purchases then
      raise exception 'TIME_PURCHASE_LIMIT' using errcode = 'P0001';
    end if;
  end if;   -- an unknown option is rejected by ttp_option_fk
  return new;
end $$;
create trigger team_time_purchases_guard before insert on team_time_purchases
  for each row execute function app.time_purchase_guard();

-- Same security posture as every other table (see migration 9): RLS enabled and forced, no client policies.
alter table question_buy_time_options enable row level security;
alter table question_buy_time_options force  row level security;
alter table team_time_purchases       enable row level security;
alter table team_time_purchases       force  row level security;
revoke all on question_buy_time_options, team_time_purchases from public, anon, authenticated;
grant select, insert, update, delete on question_buy_time_options, team_time_purchases to service_role;
revoke update, delete on team_time_purchases from service_role;   -- purchase history is append-only

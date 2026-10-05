-- Generated from docs/DATA_MODEL.md at Milestone 0 (for reviewers; the real migrations come in Milestone 2).
create extension if not exists citext; create extension if not exists pgcrypto;
do $$ begin create role anon nologin; create role authenticated nologin; create role service_role nologin; exception when duplicate_object then null; end $$;
create type competition_status as enum ('SETUP','RUNNING','PAUSED','ENDED');
create type team_status        as enum ('NOT_STARTED','RUNNING','FINAL_SUBMITTED','ENDED','DISQUALIFIED');
create type question_state     as enum ('LOCKED','AVAILABLE','ACTIVE','PENDING_APPROVAL','APPROVED','TIMED_OUT');
create type submission_status  as enum ('PENDING','APPROVED','REJECTED');
create type staff_role         as enum ('SUPER_ADMIN','ADMIN');
create type session_kind       as enum ('STAFF','MEMBER');
create type difficulty         as enum ('EASY','MEDIUM','HARD');
create type coin_tx_type       as enum ('INITIAL_GRANT','THEME_UNLOCK','HINT_PURCHASE',
                                        'TIME_PURCHASE','QUESTION_REWARD','ADMIN_ADJUSTMENT');

create schema if not exists app;

create function app.now() returns timestamptz language sql stable as $$
  select case
    when current_setting('app.allow_test_clock', true) = 'on'
     and nullif(current_setting('app.test_now', true), '') is not null
    then current_setting('app.test_now')::timestamptz
    else clock_timestamp()
  end
$$;

create table competition (
  id                          smallint primary key default 1 check (id = 1),
  status                      competition_status not null default 'SETUP',
  ultimate_seconds            int  not null default 14400,   -- 4 h
  initial_coins               int  not null default 500,
  points_per_completed_theme  int  not null default 500,
  points_per_solved_question  int  not null default 100,
  penalty_per_minute          int  not null default 5,
  disqualified_score          int  not null default -1201,
  opened_at                   timestamptz,                   -- SETUP -> RUNNING
  paused_at                   timestamptz,                   -- set while PAUSED
  ended_at                    timestamptz,
  state_version               bigint not null default 0,
  updated_at                  timestamptz not null default now()
);

create table staff_users (
  id            uuid primary key default gen_random_uuid(),
  username      citext not null unique,
  display_name  text   not null,
  password_hash text   not null,                 -- argon2id (or bcrypt fallback)
  role          staff_role not null,
  is_active     boolean not null default true,
  created_by    uuid references staff_users(id),
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);
-- exactly one Super Admin can ever exist
create unique index staff_one_super_admin on staff_users ((role)) where role = 'SUPER_ADMIN';

create table teams (
  id                     uuid primary key default gen_random_uuid(),
  team_code              text   not null unique,        -- "Team ID" in the brief, e.g. T17
  name                   text   not null,
  login_id               citext not null unique,        -- "Team Login ID"
  password_hash          text   not null,
  admin_id               uuid   not null references staff_users(id),
  status                 team_status not null default 'NOT_STARTED',
  coins                  int    not null check (coins >= 0),   -- cache of the ledger
  started_at             timestamptz,
  ends_at                timestamptz,                    -- started_at + ultimate_seconds (+ pause shifts)
  ended_at               timestamptz,                    -- set on FINAL_SUBMITTED / ENDED / DISQUALIFIED
  final_submitted_at     timestamptz,
  final_submitted_by     uuid,                           -- team_members.id
  score_override         int,                            -- Disqualify only: -1201 (competition.disqualified_score); wins over every computed score
  score_reset_at         timestamptz,                    -- last UFM Reset (audit/display); NULL if never reset
  score_reset_baseline   int,                            -- raw score at that instant; official score = raw - baseline afterwards
  final_score            int,                            -- cache, see compute_team_score()
  final_completed_themes int,
  final_solved_questions int,
  final_minutes_taken    int,
  state_version          bigint not null default 0,      -- bumped by every team-affecting transaction
  created_by             uuid references staff_users(id),
  created_at             timestamptz not null default now(),
  check ((status = 'NOT_STARTED') = (started_at is null)),
  check (ends_at is null or ends_at > started_at),
  check ((score_reset_at is null) = (score_reset_baseline is null)),
  check (score_override is null or status = 'DISQUALIFIED')   -- only a disqualification pins the score
);
create index teams_admin_idx  on teams (admin_id);
create index teams_status_idx on teams (status);
create index teams_due_idx    on teams (ends_at) where status = 'RUNNING';   -- sweeper

create table team_members (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null references teams(id) on delete restrict,
  slot          smallint not null check (slot between 1 and 4),
  admission_no  text not null unique,                    -- globally unique across all teams
  created_at    timestamptz not null default now(),
  unique (team_id, slot)
);

create table sessions (
  id             uuid primary key default gen_random_uuid(),
  token_hash     bytea not null unique,                  -- sha256 of the cookie value
  kind           session_kind not null,
  staff_id       uuid references staff_users(id),
  team_id        uuid references teams(id),
  member_id      uuid references team_members(id),
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  revoke_reason  text check (revoke_reason in
                   ('LOGOUT','SUPERSEDED','FULLSCREEN_EXIT','ADMIN_DISABLED','EXPIRED')),
  ip             inet,
  user_agent     text,
  check ((kind = 'STAFF'  and staff_id is not null and member_id is null)
      or (kind = 'MEMBER' and member_id is not null and team_id is not null and staff_id is null))
);
-- at most one live session per member; a new login revokes the old one in the same transaction
create unique index sessions_one_live_member on sessions (member_id)
  where kind = 'MEMBER' and revoked_at is null;
create index sessions_team_idx on sessions (team_id) where revoked_at is null;

create table themes (
  id            smallint primary key check (id between 1 and 12),
  code          char(1) not null unique,                 -- 'A'..'L' (admin matrix columns)
  name          text not null,
  description   text not null,
  topics        text[] not null default '{}',
  difficulty    difficulty not null,
  unlock_cost   int not null check (unlock_cost >= 0),
  display_order smallint not null
);

create table questions (
  id                  smallint primary key,              -- 1..60
  theme_id            smallint not null references themes(id),
  ordinal             smallint not null check (ordinal between 1 and 5),
  body_md             text not null,                     -- Markdown + KaTeX (decision DEC-15)
  difficulty          difficulty not null,
  reward_coins        int not null check (reward_coins >= 0),
  time_limit_seconds  int not null check (time_limit_seconds > 0),
  buy_time_seconds    int not null check (buy_time_seconds > 0),
  buy_time_cost       int not null check (buy_time_cost >= 0),
  max_time_purchases  int,                               -- null = unlimited
  unique (theme_id, ordinal)
);

-- reviewer-only material, kept in a separate table so it can never ride along in a participant query
create table question_keys (
  question_id       smallint primary key references questions(id),
  reference_answer  text not null,
  solution_notes    text
);

create table hints (
  id           smallint primary key,
  question_id  smallint not null references questions(id),
  tier         smallint not null check (tier in (1,2)),
  body_md      text not null,
  cost         int not null check (cost >= 0),
  unique (question_id, tier)
);

create table team_themes (               -- a row exists iff the theme is unlocked
  team_id      uuid not null references teams(id),
  theme_id     smallint not null references themes(id),
  unlocked_by  uuid not null references team_members(id),
  unlocked_at  timestamptz not null,
  cost_paid    int not null,
  primary key (team_id, theme_id)
);

create table team_questions (            -- 5 rows created at unlock; Q1 AVAILABLE (no timer until a participant enters it -> start_question), Q2..Q5 LOCKED
  team_id                 uuid not null references teams(id),
  question_id             smallint not null references questions(id),
  theme_id                smallint not null references themes(id),     -- denormalised for indexes
  ordinal                 smallint not null,
  state                   question_state not null default 'LOCKED',
  timer_deadline          timestamptz,            -- set iff ACTIVE (AVAILABLE and LOCKED have no timer)
  timer_remaining_seconds int,                    -- set iff PENDING_APPROVAL (timer frozen)
  extra_seconds           int not null default 0, -- total purchased, informational
  time_purchase_count     int not null default 0,
  activated_at            timestamptz,            -- set when the question becomes ACTIVE (the timer start), not at theme unlock
  approved_at             timestamptz,
  timed_out_at            timestamptz,
  primary key (team_id, question_id),
  check ((state = 'ACTIVE')           = (timer_deadline is not null)),
  check ((state = 'PENDING_APPROVAL') = (timer_remaining_seconds is not null)),
  check (timer_remaining_seconds is null or timer_remaining_seconds >= 0)
);
create index tq_team_state_idx on team_questions (team_id, state);
create index tq_due_idx        on team_questions (timer_deadline) where state = 'ACTIVE';  -- sweeper

create table answer_drafts (             -- one shared draft per team+question
  team_id      uuid not null references teams(id),
  question_id  smallint not null references questions(id),
  answer       text not null default '',
  explanation  text not null default '',
  version      int  not null default 0,  -- optimistic concurrency (see API_SPEC saveDraft)
  updated_by   uuid references team_members(id),
  updated_at   timestamptz not null default now(),
  primary key (team_id, question_id),
  check (length(answer) <= 10000 and length(explanation) <= 10000)
);

create table hint_purchases (
  team_id       uuid not null references teams(id),
  hint_id       smallint not null references hints(id),
  purchased_by  uuid not null references team_members(id),
  cost_paid     int not null,
  purchased_at  timestamptz not null,
  primary key (team_id, hint_id)         -- a team can never pay twice for the same hint
);

-- Tier 2 requires Tier 1 of the same question (second guard; buy_hint checks first, under the team lock)
create function app.hint_tier_order() returns trigger language plpgsql as $$
begin
  if (select tier from hints where id = new.hint_id) = 2
     and not exists (select 1
                       from hint_purchases p
                       join hints h1 on h1.id = p.hint_id and h1.tier = 1
                      where p.team_id = new.team_id
                        and h1.question_id = (select question_id from hints where id = new.hint_id)) then
    raise exception 'HINT_TIER1_REQUIRED' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger hint_purchases_tier_order before insert on hint_purchases
  for each row execute function app.hint_tier_order();

create table submissions (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null references teams(id),
  question_id   smallint not null references questions(id),
  member_id     uuid not null references team_members(id),
  answer        text not null check (length(answer) between 1 and 10000),
  explanation   text not null check (length(explanation) <= 10000),
  status        submission_status not null default 'PENDING',
  submitted_at  timestamptz not null,
  reviewed_by   uuid references staff_users(id),
  reviewed_at   timestamptz,
  review_note   text,                    -- optional, decision DEC-07
  reward_awarded int,
  check ((status = 'PENDING') = (reviewed_at is null))
);
-- only ONE pending submission per team+question, enforced by the database
create unique index submissions_one_pending on submissions (team_id, question_id) where status = 'PENDING';
create index submissions_queue_idx on submissions (submitted_at) where status = 'PENDING';
create index submissions_team_idx  on submissions (team_id, question_id, submitted_at);

create table coin_transactions (
  id              bigserial primary key,
  team_id         uuid not null references teams(id),
  type            coin_tx_type not null,
  amount          int  not null,                 -- signed: spends negative, rewards positive
  balance_after   int  not null check (balance_after >= 0),
  theme_id        smallint references themes(id),
  hint_id         smallint references hints(id),
  question_id     smallint references questions(id),
  submission_id   uuid     references submissions(id),
  purchase_seq    int,                           -- TIME_PURCHASE: team_questions.time_purchase_count after the buy
  member_id       uuid references team_members(id),
  staff_id        uuid references staff_users(id),
  created_at      timestamptz not null
);
-- "cannot happen twice" guarantees, enforced at the ledger level
create unique index ctx_initial    on coin_transactions (team_id)                       where type = 'INITIAL_GRANT';
create unique index ctx_theme      on coin_transactions (team_id, theme_id)             where type = 'THEME_UNLOCK';
create unique index ctx_hint       on coin_transactions (team_id, hint_id)              where type = 'HINT_PURCHASE';
create unique index ctx_reward     on coin_transactions (team_id, question_id)          where type = 'QUESTION_REWARD';
create unique index ctx_time       on coin_transactions (team_id, question_id, purchase_seq) where type = 'TIME_PURCHASE';
create index ctx_team_idx          on coin_transactions (team_id, id);

create table request_log (
  team_id       uuid not null,                   -- or the staff id for staff operations
  idem_key      uuid not null,                   -- client-generated Idempotency-Key
  operation     text not null,
  response      jsonb not null,
  created_at    timestamptz not null default now(),
  primary key (team_id, idem_key)
);

create table audit_events (
  id              bigserial primary key,
  occurred_at     timestamptz not null default now(),
  actor_kind      text not null check (actor_kind in ('STAFF','MEMBER','SYSTEM')),
  staff_id        uuid,
  member_id       uuid,
  team_id         uuid,
  event_type      text not null,                 -- see catalogue in STATE_MACHINE.md §8
  entity_type     text,
  entity_id       text,
  payload         jsonb not null default '{}',   -- before/after values, amounts, reasons
  request_id      uuid,
  ip              inet
);
create index audit_team_idx on audit_events (team_id, id);
create index audit_type_idx on audit_events (event_type, id);

create function app.audit_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit_events is append-only'; end $$;
create trigger audit_no_update before update or delete on audit_events
  for each row execute function app.audit_immutable();
create trigger audit_no_truncate before truncate on audit_events
  for each statement execute function app.audit_immutable();
revoke update, delete, truncate on audit_events from public, anon, authenticated, service_role;

create table leaderboard_snapshot (      -- single row, refreshed at most every 60 s
  id           smallint primary key default 1 check (id = 1),
  computed_at  timestamptz not null,
  rows         jsonb not null              -- [{rank, team_id, team_name, score, status}]
);

create table auth_throttle (             -- login rate limiting; keyed per account, NOT per IP
  key           text primary key,        -- 'team:<login_id>' | 'staff:<username>'
  window_start  timestamptz not null,
  attempts      int not null,
  locked_until  timestamptz
);

create table ufm_challenges (            -- server-side second step for destructive admin actions
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references staff_users(id),
  team_id     uuid not null references teams(id),
  action      text not null check (action in ('RESET_SCORE','DISQUALIFY')),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

-- progress per team+theme
create view team_theme_progress as
select team_id, theme_id,
       count(*) filter (where state = 'APPROVED')   as approved_count,
       bool_or(state = 'TIMED_OUT')                 as has_timed_out,
       count(*) filter (where state = 'APPROVED') = 5 as completed
from team_questions group by team_id, theme_id;

-- presence
create view member_presence as
select m.id as member_id, m.team_id,
       exists (select 1 from sessions s
               where s.member_id = m.id and s.revoked_at is null
                 and s.last_seen_at > app.now() - interval '75 seconds') as online
from team_members m;

# DATA_MODEL.md — Maths Club Concetto 26

Status: **proposal for review (Milestone 0).** The DDL below is precise enough to review constraints and indexes; the runnable migrations are written in Milestone 2. Names here are canonical and are reused by `STATE_MACHINE.md`, `API_SPEC.md` and `REALTIME_SPEC.md`.

Design rules that shape every table:

1. **Postgres is the only source of truth.** Timers, coins, score and question state are all derived from rows, never from client input.
2. **Time is stored as timestamps, not counters.** A running timer is a `timestamptz` deadline; a paused timer is a frozen `int` of seconds remaining.
3. **Money is a ledger plus a cached balance.** `teams.coins` is a cache; `coin_transactions` is the audit trail. They must always reconcile (test `INV-01`).
4. **Duplicate protection is a database constraint, not application code.** Double unlock, double hint purchase and double reward are each made impossible by a unique index.
5. **History is immutable.** Submissions, coin transactions and audit events are never updated or deleted (review fields on a submission are the only permitted update).

---

## 1. Enums

```sql
create type competition_status as enum ('SETUP','RUNNING','PAUSED','ENDED');
create type team_status        as enum ('NOT_STARTED','RUNNING','FINAL_SUBMITTED','ENDED','DISQUALIFIED');
create type question_state     as enum ('LOCKED','AVAILABLE','ACTIVE','PENDING_APPROVAL','APPROVED','TIMED_OUT');
create type submission_status  as enum ('PENDING','APPROVED','REJECTED');
create type staff_role         as enum ('SUPER_ADMIN','ADMIN');
create type session_kind       as enum ('STAFF','MEMBER');
create type difficulty         as enum ('EASY','MEDIUM','HARD');
create type coin_tx_type       as enum ('INITIAL_GRANT','THEME_UNLOCK','HINT_PURCHASE',
                                        'TIME_PURCHASE','QUESTION_REWARD','ADMIN_ADJUSTMENT');
```

`team_status` differs from the brief in two deliberate ways: `SETUP` is renamed `NOT_STARTED` (to avoid confusion with `competition_status.SETUP`), and `DISQUALIFIED` is added so UFM results are explicit instead of being inferred from a score of -1201.

## 2. Time source

All engine code reads time through one function so tests can control it.

```sql
create schema if not exists app;

create function app.now() returns timestamptz language sql stable as $$
  select case
    when current_setting('app.allow_test_clock', true) = 'on'
     and nullif(current_setting('app.test_now', true), '') is not null
    then current_setting('app.test_now')::timestamptz
    else clock_timestamp()
  end
$$;
```

`app.allow_test_clock` is set with `ALTER DATABASE ... SET` **only on the local/test database**. Production never sets it, and the browser has no direct database access, so it cannot be abused. `clock_timestamp()` (not `now()`) is used so a request that waited on a row lock gets the time *after* it acquired the lock.

## 3. Tables

### 3.1 `competition` (singleton)

```sql
create table competition (
  id                          smallint primary key default 1 check (id = 1),
  status                      competition_status not null default 'SETUP',
  ultimate_seconds            int  not null default 14400,   -- LOCKED (B15): 4 h = 14,400 s = 240 min; was 7,200 until B14. Each team snapshots it in teams.timer_seconds when it starts
  ultimate_minutes            int  generated always as (ultimate_seconds / 60) stored,
  initial_coins               int  not null default 500,
  points_per_completed_theme  int  not null default 500,
  points_per_solved_question  int  not null default 100,
  penalty_per_minute          int  not null default 5,
  reset_floor_score           int  not null default -1200,   -- UFM floor (reset-adjusted score >= -1200)
  disqualified_score          int  not null default -1201,   -- = reset_floor_score - 1
  opened_at                   timestamptz,                   -- SETUP -> RUNNING
  paused_at                   timestamptz,                   -- set while PAUSED
  ended_at                    timestamptz,
  state_version               bigint not null default 0,
  updated_at                  timestamptz not null default now()
);
```

Scoring constants live here (not in code) so the formula is auditable and cannot drift between SQL and TypeScript. `lib/scoring` in TypeScript only *displays*; a parity test (`SC-05`) compares it to the SQL function.

### 3.2 `staff_users`

```sql
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
```

### 3.3 `teams`

```sql
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
  score_override         int,                            -- Disqualify only: -1201 (competition.disqualified_score); wins over every computed score **[B16: `score_override` is no longer written (no Disqualify); the official score is 0 when `ufm_penalized_at` is set. See SCORING_AND_LEADERBOARD.md.]**
  score_reset_at         timestamptz,                    -- last UFM Reset (audit/display); NULL if never reset **[B16: `score_reset_at` is unused; UFM is `ufm_penalized_at` / `ufm_penalized_by`. See SCORING_AND_LEADERBOARD.md.]**
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
```

### 3.4 `team_members`

```sql
create table team_members (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null references teams(id) on delete restrict,
  slot          smallint not null check (slot between 1 and 4),
  admission_no  text not null unique,                    -- globally unique across all teams
  created_at    timestamptz not null default now(),
  unique (team_id, slot)
);
```

A team has 1–4 members (decision `DEC-13`). `admission_no` is normalised (trimmed, upper-cased) before insert and before lookup.

### 3.5 `sessions`

One table for all three roles. Opaque random tokens are used instead of JWTs so a session can be **revoked instantly** (fullscreen exit, admin disabled, superseded by a new login).

```sql
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
```

Online/offline is derived: a member is **online** if they have a non-revoked session with `last_seen_at > app.now() - interval '75 seconds'` (heartbeat every 25 s). See view `member_presence`.

### 3.6 Content: `themes`, `questions`, `question_keys`, `hints`

```sql
create table themes (
  id            smallint primary key check (id between 1 and 10),
  code          char(1) not null unique check (code between 'A' and 'J'),   -- 'A'..'J' (admin matrix columns)
  name          text not null,
  description   text not null,
  topics        text[] not null default '{}',
  difficulty    difficulty not null,
  unlock_cost   int not null check (unlock_cost >= 0),
  display_order smallint not null
);

create table questions (
  id                  smallint primary key check (id between 1 and 50),   -- 1..50
  theme_id            smallint not null references themes(id),
  ordinal             smallint not null check (ordinal between 1 and 5),
  body_md             text not null,                     -- Markdown + KaTeX (decision DEC-15)
  difficulty          difficulty not null,
  reward_coins        int not null check (reward_coins >= 0),
  time_limit_seconds  int not null check (time_limit_seconds > 0),
  unique (theme_id, ordinal)
);

-- reviewer-only material, kept in a separate table so it can never ride along in a participant query.
-- Never returned to a participant in ANY question state, including APPROVED (SEC-07).
create table question_keys (
  question_id       smallint primary key references questions(id),
  reference_answer  text not null,
  solution_notes    text
);

-- Buy Time options (follow-up to Patch B): several configurable options per question (seeded: 120 s / 20, 240 s / 40,
-- 480 s / 80 coins; placeholders, not constants). Purchases keep a snapshot of what was bought and paid.
create table question_buy_time_options (
  id             smallint primary key check (id > 0),
  question_id    smallint not null references questions(id) on delete restrict,
  seconds        int      not null check (seconds > 0),
  cost           int      not null check (cost >= 0),
  max_purchases  int      check (max_purchases is null or max_purchases >= 0),   -- per team and question; null = unlimited
  display_order  smallint not null check (display_order > 0),
  unique (question_id, display_order), unique (question_id, seconds), unique (id, question_id)
);
create table team_time_purchases (       -- append-only; (team_id, question_id, seq) mirrors coin_transactions.purchase_seq
  team_id uuid not null references teams(id), question_id smallint not null, seq int not null check (seq >= 1),
  option_id smallint not null, seconds_added int not null check (seconds_added > 0), cost_paid int not null check (cost_paid >= 0),
  purchased_by uuid not null, purchased_at timestamptz not null,
  primary key (team_id, question_id, seq)  -- + composite FKs to team_questions, the option (same question) and the member (same team)
);

create table hints (
  id           smallint primary key,
  question_id  smallint not null references questions(id),
  tier         smallint not null check (tier in (1,2)),
  body_md      text not null,
  cost         int not null check (cost >= 0),
  unique (question_id, tier)
);
```

Content is **seeded by a script and treated as read-only at runtime** (no content-editing UI). A migration-time check asserts exactly 10 themes (A–J) × 5 questions (50).

### 3.7 Per-team progress

```sql
create table team_themes (               -- a row exists iff the theme is unlocked
  team_id      uuid not null references teams(id),
  theme_id     smallint not null references themes(id),
  unlocked_by  uuid not null references team_members(id),
  unlocked_at  timestamptz not null,
  cost_paid    int not null,
  primary key (team_id, theme_id)
);

create table team_questions (            -- 5 rows created at unlock; Q1 AVAILABLE (no timer until a participant enters it → start_question), Q2..Q5 LOCKED
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
```

```sql
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
```

### 3.8 `submissions` (immutable history)

```sql
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
  review_note   text,                    -- optional, decision DEC-07; shown to the team, so reviewers must keep it non-sensitive (never the reference answer)
  reward_awarded int,
  check ((status = 'PENDING') = (reviewed_at is null))
);
-- only ONE pending submission per team+question, enforced by the database
create unique index submissions_one_pending on submissions (team_id, question_id) where status = 'PENDING';
create index submissions_queue_idx on submissions (submitted_at) where status = 'PENDING';
create index submissions_team_idx  on submissions (team_id, question_id, submitted_at);
```

A **disapproval keeps the row** with `status='REJECTED'`; the team's *draft* is **kept** (locked UI-2.1 rule). This is what makes dispute resolution possible (`AMB-02`).

### 3.9 `coin_transactions` (ledger)

```sql
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
```

### 3.10 `request_log` (idempotency)

```sql
create table request_log (
  team_id       uuid not null,                   -- or the staff id for staff operations
  idem_key      uuid not null,                   -- client-generated Idempotency-Key
  operation     text not null,
  response      jsonb not null,
  created_at    timestamptz not null default now(),
  primary key (team_id, idem_key)
);
```

Every mutating function begins by trying to insert its key. If the key already exists it **returns the stored response without doing anything**, so a retried request cannot deduct, award, approve, submit or finalise twice. Rows older than 48 h are purged by the sweeper.

### 3.11 `audit_events` (append-only)

```sql
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
```

Audit rows are written **inside the same transaction as the change they describe**, so an event exists if and only if the change committed.

### 3.12 Supporting tables

```sql
create table leaderboard_snapshot (      -- single row, refreshed at most every 60 s **[B16: the leaderboard is a derived read (no snapshot table, no cron refresh), polled every 15 s with jitter. See SCORING_AND_LEADERBOARD.md.]**
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
```

Campus Wi-Fi puts many students behind one public IP, so throttling by IP would lock out the whole venue. Throttling is per account (`SEC-04`).

### 3.13 Patch B reconciliation (runnable migrations)

The authoritative DDL is now `supabase/migrations/*.sql` (applied in filename order, then `supabase/seed.sql`); `docs/evidence/schema.sql` is generated from it (`npm run db:evidence`); see `DATABASE_FOUNDATION.md`. The DDL excerpts above are the Phase 0 design with the locked amendments applied. Patch B changed or added, and nothing else:

* **Locked amendments:** `ultimate_seconds` 14,400 (4 h = 240 min since B15; check `competition_ultimate_locked_14400`, plus generated `ultimate_minutes`; B10–B14 used 7,200 and `competition_ultimate_locked_7200`; `teams.timer_seconds` keeps 7,200 for teams that started under the old rule, strict check `teams_timer_seconds_iff_started`); `reset_floor_score` −1200 and `disqualified_score` −1201 (check: DQ = floor − 1); themes `A`–`J` (ids 1–10), questions 1–50 with `id = (theme_id − 1) × 5 + ordinal`; hints 1–100; `teams.final_minutes_taken` ≥ 0 (B15 dropped the upper bound of 120: a 4 h team can exceed it).
* **Referential integrity:** every FK is explicit `ON DELETE RESTRICT` (history is never cascaded away). Member-bearing columns (`unlocked_by`, `updated_by`, `purchased_by`, `submissions.member_id`, `coin_transactions.member_id`, `sessions.member_id`, `teams.final_submitted_by`) use composite FKs `(member_id, team_id) → team_members(id, team_id)`, so a member can only act for their own team. `team_questions` has composite FKs to `questions(id, theme_id)` and to `team_themes(team_id, theme_id)` (rows exist only for unlocked themes).
* **State invariants:** `team_questions` — `AVAILABLE` only for Q1 (INV-04), `LOCKED`/`AVAILABLE` have no `activated_at`, `APPROVED`/`TIMED_OUT` carry their timestamps, trigger `QUESTION_PREVIOUS_NOT_APPROVED` (QN+1 cannot start before QN is approved). `teams` — `FINAL_SUBMITTED` ⇔ `final_submitted_at`; terminal status ⇔ `ended_at`; `DISQUALIFIED` ⇔ `score_override = −1201`. `submissions` — a decision needs `reviewed_by` and `reviewed_at`; `reward_awarded` only on `APPROVED`. `sessions` — expiry after creation; `revoked_at` ⇔ `revoke_reason`.
* **Ledger:** `coin_transactions` is append-only (update/delete/truncate rejected), signs are checked per type, each spend/reward names its subject, a before-insert trigger enforces the running balance (`balance_after = previous + amount`) and `INITIAL_GRANT = competition.initial_coins`; the read-only checker `app.invariant_coin_balance_mismatch` finds any drift between `teams.coins` and the ledger.
* **Buy Time options (follow-up):** `questions` no longer carries `buy_time_seconds` / `buy_time_cost` / `max_time_purchases`. `question_buy_time_options` holds any number of options per question (`seconds`, `cost`, nullable `max_purchases`, `display_order`), and `team_time_purchases` records each purchase with the seconds and price actually applied. A before-insert trigger enforces: question `ACTIVE`, `seq` = previous count + 1 (no gaps or replays), recorded seconds/cost equal the option's, and the option's per-team cap. The `buy_time` operation itself is Phase 5.
* **Sessions (decision A2, kept):** one `sessions` table; `member_sessions` (adds the M1–M4 slot), `admin_sessions` and `team_sessions` (team run state from `teams`) are read-only views. `member_presence` now reports the `presence_state` enum (`OFFLINE`/`ONLINE`).
* **Timestamps:** `updated_at` (with a touch trigger) on `competition`, `staff_users`, `teams`, `team_members`, `sessions`; `created_at` added where missing.
* **Security:** RLS enabled and forced on every table, no policies, all privileges revoked from `anon`/`authenticated`/`PUBLIC`; the service role holds explicit grants and cannot update/delete the audit trail or the ledger. Authorisation by team ownership (participant → own team, admin → `teams.admin_id`, super admin → all) is enforced by the server-side engine functions of Phase 5, never by the browser.
* **Not changed:** the draft is **kept** on disapproval (locked UI-2.1 rule), so the schema has no draft-clearing step; `answer_drafts` is independent of `submissions`.

## 4. Derived objects

```sql
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
```

`compute_team_score(team_id)` is the **only** place the official score is calculated: **[B16: Replaced by `app.compute_score` / `app.team_scores`; minutes are elapsed, not `120 − floor(remaining)`. See SCORING_AND_LEADERBOARD.md.]**

```
completed_themes  = count(team_theme_progress.completed)
solved_questions  = count(team_questions where state = 'APPROVED')
ref_time          = least(app.now(), coalesce(teams.ended_at, 'infinity'),
                          case when competition.status='PAUSED' then competition.paused_at end)
remaining_seconds = greatest(0, teams.ends_at - ref_time)           -- NOT_STARTED: ultimate_seconds
minutes_taken     = 120 - floor(remaining_seconds / 60)             -- clamped to [0, 120]
raw_score         = completed_themes*500 + solved_questions*100 + teams.coins - minutes_taken*5
adjusted_score    = case when teams.score_reset_baseline is null then raw_score
                         else greatest(-1200, raw_score - teams.score_reset_baseline) end
effective_score   = coalesce(teams.score_override, adjusted_score)   -- override = Disqualify only (-1201)
```

Notes:

* **Reset is a baseline, not a pin.** `reset_score` stores `score_reset_baseline = raw_score` at that instant, so `effective_score` is exactly 0 then and moves normally afterwards: `raw 850 → Reset → 0 → earn 100 → 100`. The time penalty, purchases and rewards all keep affecting the raw score as before. A second Reset stores the then-current raw score as the new baseline.
* **Floor (locked rule).** The reset-adjusted score may never fall below −1200 (the minimum natural score), and Disqualify is always exactly −1201, so a non-disqualified or reset team can never rank below a disqualified team.
* **Disqualify** sets `score_override = -1201` and wins over everything; any baseline is retained for history.
* The constants come from the `competition` row, not literals. `floor` of remaining time (`DEC-16`) means 3:59:30 remaining counts as 1 minute taken. When a team reaches a terminal state, `ref_time` is frozen at `ended_at`, so the score stops changing with the clock; the cached `final_*` values store `effective_score`. **[B16: Minutes taken = round(elapsed / 60), half up (DEC-16 changed). See SCORING_AND_LEADERBOARD.md.]**

## 5. Invariants (each has a test in `TEST_PLAN.md`)

| ID | Invariant |
|----|-----------|
| INV-01 | `teams.coins = Σ coin_transactions.amount` for that team, always. |
| INV-02 | `teams.coins >= 0` (check constraint). |
| INV-03 | At most one `PENDING` submission per (team, question). |
| INV-04 | A question is `ACTIVE` only if all lower ordinals in its theme are `APPROVED`. A question is `AVAILABLE` only if it is ordinal 1 (later questions go `LOCKED → ACTIVE` when the previous one is approved). |
| INV-05 | A `team_questions` row exists only for unlocked themes; each unlock creates exactly 5 rows. |
| INV-06 | `ACTIVE` ⇔ `timer_deadline` set; `PENDING_APPROVAL` ⇔ `timer_remaining_seconds` set. |
| INV-07 | A team in a terminal status (`FINAL_SUBMITTED`/`ENDED`/`DISQUALIFIED`) never changes coins or question state again, except a permitted late review (`DEC-03`). |
| INV-08 | One `QUESTION_REWARD`, one `THEME_UNLOCK` per (team, theme), one `HINT_PURCHASE` per (team, hint) — enforced by unique indexes. |
| INV-09 | Exactly one `SUPER_ADMIN` row can exist. |
| INV-10 | `audit_events` rows are never updated or deleted. |
| INV-11 | A team owns a Tier 2 hint of a question only if it owns that question's Tier 1 hint. |
| INV-12 | A team's official score is `score_override` if set (only for `DISQUALIFIED` teams), else `raw − baseline` floored at −1200 if it has been reset, else `raw`; `score_reset_at` and `score_reset_baseline` are both set or both null. **[B16: Official score: 0 if penalised, else `score_override`, else the gameplay score. See SCORING_AND_LEADERBOARD.md.]** |

## 6. Row-level security posture

* `ALTER TABLE … ENABLE ROW LEVEL SECURITY; ALTER TABLE … FORCE ROW LEVEL SECURITY;` on **every** table, with **no policies** for `anon` or `authenticated`. Browsers hold no Supabase credentials that can read tables.
* The Next.js server uses the **service-role key** (server environment only) to call engine functions. Authorization is enforced in the function layer (every function takes the authenticated principal and re-checks ownership: team id, assigned admin id, role).
* All engine functions are `SECURITY DEFINER`, `SET search_path = ''`, and `EXECUTE` is revoked from `public`, `anon` and `authenticated` and granted to `service_role` only.
* The only client-facing RLS policy is on `realtime.messages`, to authorise **private broadcast channels** (see `REALTIME_SPEC.md` §3). If the spike (`RISK-12`) fails, channels fall back to public ping-only channels and no policy is needed.

## 7. Indexes and expected sizes

At full scale (100 teams): `team_questions` ≈ 6,000 rows, `submissions` ≈ 20k, `coin_transactions` ≈ 5k, `audit_events` ≈ 100k, `sessions` ≈ a few thousand. This is tiny; the indexes above exist for lock-free sweeper scans and the admin queue, not because of volume. The load test (`LT-*`) measures contention, not data size.

## 8. Seed layout

```
supabase/seed/
  content/            themes.json  questions.json  hints.json  keys.json   -- real content, safe in prod
  demo/               demo_admins.ts  demo_teams.ts                         -- refuses to run if APP_ENV=production
  provision/          superadmin.ts   -- reads credentials from env/prompt, hashes, inserts; never stored in Git
```

Commands: `npm run seed:content` (idempotent, allowed everywhere), `npm run seed:demo` (hard-fails against a production database), `npm run provision:superadmin` (interactive, one-time).

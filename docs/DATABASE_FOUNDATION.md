# Database foundation (Patch B)

What exists: ordered PostgreSQL/Supabase migrations, a deterministic development seed, database tests, and a generated
reviewer copy of the schema. What does **not** exist: any competition engine operation, authentication, realtime,
admin UI, or new participant UI. The tables are ready for those later phases; nothing here decides game rules in
TypeScript.

## Layout

```
supabase/migrations/   10 ordered migrations (extensions+enums+clock … security/RLS, buy-time options)
supabase/seed.sql      configuration + content only: 1 competition, 10 themes A–J, 50 questions, 150 buy-time options, 100 hints, placeholder keys
supabase/tests/        plain-SQL tests (assert / rejects()); run by scripts/db-verify.mjs
scripts/db-verify.mjs  scratch-database runner (npm run db:verify)
scripts/db-evidence.mjs generates docs/evidence/schema.sql from the migrations (npm run db:evidence)
tests/unit/db-foundation.test.ts  static guards that run in `npm test` (no database needed)
```

## Commands

```
npm run check                       # format, lint, typecheck, unit/component tests (incl. db-foundation static guards), hygiene
DB_VERIFY_URL=postgres://user@127.0.0.1:5432/postgres npm run db:verify
npm run db:evidence                 # after changing a migration; `npm test` fails if docs/evidence/schema.sql is stale
```

`db:verify` needs `psql` and a PostgreSQL 15+ server where it may create a database. It creates a random scratch
database, applies every migration in order, applies the seed **twice** (idempotency), runs `supabase/tests/*.test.sql`, and
drops the database. It refuses non-local hosts unless `DB_VERIFY_ALLOW_REMOTE=1`. Never point it at production.

Applying to Supabase later: `supabase db push` (or run the migrations in order); a local `supabase db reset` runs
`supabase/seed.sql`. The seed never creates staff accounts, teams or credentials.

## Locked values encoded in the schema

| Rule                         | Where                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Ultimate Team Timer 2 h      | `competition.ultimate_seconds = 7200` (check `competition_ultimate_locked_7200`), generated `ultimate_minutes = 120`       |
| Scoring minutes              | `120 − floor(remaining_seconds / 60)`, clamped 0–120 (domain rule for the later engine); `teams.final_minutes_taken` 0–120 |
| 10 themes × 5 questions = 50 | `themes.id 1–10`, `code A–J`; `questions.id 1–50 = (theme−1)×5 + ordinal`; seed assertions; no K/L                         |
| Q1 `AVAILABLE` after unlock  | `team_questions` (only Q1 may be `AVAILABLE`; no `activated_at`/deadline until `ACTIVE`)                                   |
| QN+1 only after QN approved  | trigger `QUESTION_PREVIOUS_NOT_APPROVED`                                                                                   |
| One pending submission       | unique partial index `submissions_one_pending`; rejected rows are kept                                                     |
| Buy Time options             | `question_buy_time_options` (configurable seconds/cost/cap per question), `team_time_purchases` + guard trigger            |
| Tier 2 needs Tier 1          | trigger `HINT_TIER1_REQUIRED`, one purchase per (team, hint)                                                               |
| 500 starting coins, ledger   | `competition.initial_coins`, immutable `coin_transactions` with balance-chain trigger and per-subject unique indexes       |
| UFM                          | `score_reset_baseline/at` paired; floor `reset_floor_score = −1200`; DQ `score_override = −1201`, only when `DISQUALIFIED` |
| Rejected draft is kept       | `answer_drafts` is independent of `submissions`; nothing clears it on rejection (locked UI-2.1 rule)                       |
| Roles                        | one `SUPER_ADMIN` (unique index); `ADMIN` rows need a creator; PARTICIPANT = member of a team (M1–M4 = `slot`)             |

## Security foundation

Row level security is enabled **and forced** on every table with **no policies**, and every privilege is revoked from
`anon`, `authenticated` and `PUBLIC`, so a browser holding Supabase keys can read nothing. The server uses the service role
(never exposed to the browser; no secrets are committed) and, from Phase 5, SECURITY DEFINER engine functions that
enforce ownership: participant → own team, admin → teams with `teams.admin_id` = self, super admin → all. The service
role cannot update or delete the audit trail or the coin ledger.

## Deviations and decisions

- **Sessions:** the approved design (decision A2) has one `sessions` table. `member_sessions`, `admin_sessions` and
  `team_sessions` exist as read-only views over it (the option chosen for this patch). The team's authoritative timer lives on `teams`.
- **The timer is locked in the database** (`ultimate_seconds = 7200`). Tests that need other times use the controllable
  clock `app.now()`, not a different duration. Relax the check deliberately if that is ever wanted.
- **Buy Time options:** the question UI offers three options (+2/+4/+8 min for 20/40/80 coins). They live in
  `question_buy_time_options` (`seconds`, `cost`, nullable `max_purchases`, `display_order`), not in the engine and not on `questions`.
  `team_time_purchases` records each purchase (option, seconds and price applied, member), and a trigger guards the future
  `buy_time` operation: question `ACTIVE`, `seq` = previous count + 1, recorded seconds/cost equal the option's, and the option's cap.
- Seed prices and rewards are placeholder content data (unlock 100, reward 50, hints 40/80, buy-time options 120 s/20, 240 s/40, 480 s/80).

## Known limitations (later phases)

- Not implemented: every engine operation (`start_team_competition`, `unlock_theme`, `start_question`, `buy_hint`,
  `buy_time`, `submit`, approve/disapprove, `final_submit`, reset/disqualify), `compute_team_score`, the sweeper, the leaderboard
  refresh, authentication, realtime and its `realtime.messages` policy.
- Verified on plain PostgreSQL 16 only. Supabase-specific behaviour (platform-created roles, default privileges,
  Data API exposure of the `public` schema, the `realtime` schema) has not been exercised.
- The participant home and question page still show the static mock timer from the layout image (03:46:54), which is longer
  than the 2-hour timer. It is a UI mock value removed when the real timer is wired in; it was left untouched on purpose.

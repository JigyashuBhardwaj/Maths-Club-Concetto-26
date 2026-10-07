# Database foundation (Patch B)

What exists: ordered PostgreSQL/Supabase migrations, a deterministic development seed, database tests, and a generated
reviewer copy of the schema. Migration 11 (Patch B9) adds the authentication and session functions and migration 12 (Patch B10) the
competition runtime (both below). What does **not** exist: the game operations, realtime, admin UI, or new participant UI. The tables are ready for those later phases; nothing here decides game rules in
TypeScript.

## Layout

```
supabase/migrations/   13 ordered migrations (extensions+enums+clock … security/RLS, buy-time options, auth functions, runtime engine, provisioning)
supabase/seed.sql      configuration + content only: 1 competition, 10 themes A–J, 50 questions, 150 buy-time options, 100 hints, placeholder keys
supabase/tests/        plain-SQL tests (assert / rejects()); run by scripts/db-verify.mjs
supabase/tests/concurrency/  multi-connection tests (*.concurrency.mjs, parallel psql sessions); run by scripts/db-verify.mjs
scripts/db-verify.mjs  scratch-database runner (npm run db:verify)
scripts/provision-superadmin.mjs  one-off interactive Super Admin creation (npm run provision:superadmin)
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

## Authentication functions (migration 11, Patch B9)

All are executable by `service_role` only: each has an explicit `REVOKE ALL … FROM PUBLIC, anon, authenticated` and
`GRANT EXECUTE … TO service_role` (no reliance on default privileges; proven from the catalog in `70_auth.test.sql`).
Failures are returned as `{"ok": false, "code": …}` rather than raised, so throttle and audit rows commit.

| Function                                                                                                        | Purpose                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public.participant_login(login_id, password, admission_no, token_hash, ip, user_agent)`                        | throttle check → team + bcrypt check → admission belongs to the team → competition `RUNNING`/`PAUSED` → supersede the member's live session → insert session (12 h) → clear throttle → audit `MEMBER_LOGIN`. Never touches the team timer |
| `public.staff_login(username, password, token_hash, ip, user_agent)`                                            | same pattern for `ADMIN` / `SUPER_ADMIN`; inactive accounts get the generic failure; audit `STAFF_LOGIN`                                                                                                                                  |
| `public.resolve_session(token_hash)`                                                                            | returns the principal; revokes expired sessions (`EXPIRED`) and sessions of disabled staff (`ADMIN_DISABLED`); sets `last_seen_at = app.now()`                                                                                            |
| `public.revoke_session(token_hash)`                                                                             | idempotent logout (`LOGOUT`), audits only a real revoke                                                                                                                                                                                   |
| `app.provision_superadmin(username, display_name, password)`                                                    | creates the single `SUPER_ADMIN`, hashing in the database; raises `SUPER_ADMIN_EXISTS` if one exists                                                                                                                                      |
| `app.hash_password`, `app.verify_password`, `app.auth_dummy_hash`, `app.auth_throttle_retry_after/_fail/_clear` | helpers (bcrypt cost 12 via pgcrypto; per-account throttle)                                                                                                                                                                               |

The clock is `app.now()` throughout, so tests move time with the existing test clock. `70_auth.test.sql` puts the
competition into `RUNNING`/`PAUSED`/`SETUP`/`ENDED` directly in test setup; the production status operation arrived with
migration 12.

## Competition runtime (migration 12, Patch B10)

Same privilege model as above (explicit revoke from PUBLIC/anon/authenticated, grant to `service_role`, pinned
`search_path`). Rejections are **raised** as `P0001` with the stable error code as the message (JSON `DETAIL` for details),
which rolls the transaction back; only successes are stored for idempotency. `request_log` gained one column,
`request_fingerprint`, binding a key to its operation, actor and parameter.

| Function                                                                                             | Purpose                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public.set_competition_status(staff_id, action, idempotency_key)`                                   | `open`/`pause`/`resume`/`end`; active SUPER_ADMIN only; legal-transition table, idempotent no-op for the current status; `resume` shifts team `ends_at` and ACTIVE question deadlines by the paused duration; `end` ends RUNNING teams; bumps `competition.state_version` and every team's `state_version`; audits `COMPETITION_STATUS_CHANGED` |
| `public.start_team_competition(team_id, member_id, idempotency_key)`                                 | member ∈ team → `app.lock_team` → replay check → gates → one `UPDATE` sets `RUNNING`, `started_at = app.now()`, `ends_at = started_at + 7200 s`, `state_version + 1` → audit `TEAM_STARTED`. Already `RUNNING` returns the existing state untouched                                                                                             |
| `public.get_team_state(team_id, member_id)`                                                          | the authoritative snapshot (a read; no lock): status, competition status, `started_at`, `ends_at`, `remaining_seconds` (floor, clamped at 0, frozen at `paused_at`/`ended_at`), `expired`, `state_version`, coins, theme/question progress. No hashes, tokens or admission numbers                                                              |
| `app.lock_team(team_id)`                                                                             | THE locking primitive: competition `FOR SHARE`, then team `FOR UPDATE` (order competition → team everywhere)                                                                                                                                                                                                                                    |
| `app.idem_lookup` / `app.idem_store`                                                                 | request idempotency on `request_log`                                                                                                                                                                                                                                                                                                            |
| `app.team_state_json`, `app.competition_json`, `app.epoch_ms`, `app.fail`, `app.require_super_admin` | shared builders and guards                                                                                                                                                                                                                                                                                                                      |
| `app.expire_team(team_id, reason, ended_at, staff_id)`                                               | minimal RUNNING → ENDED (`ended_at = least(ends_at, …)`); no scoring yet                                                                                                                                                                                                                                                                        |

Tests: `80_runtime.test.sql` (transitions, timer, idempotency, audit, versions, pause/resume/end, privileges) and
`concurrency/start_team.concurrency.mjs` (four members entering at once, a retry storm with one key, a start racing a
pause — real parallel sessions that hold the team lock for a second so the others genuinely queue).

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

- Not implemented: the game operations (`unlock_theme`, `start_question`, `buy_hint`, `buy_time`, `submit`,
  approve/disapprove, `final_submit`, reset/disqualify), `compute_team_score` (so `final_*` stay NULL), the sweeper and lazy
  expiry (an expired `RUNNING` team stays `RUNNING` and is reported with `remaining_seconds = 0, expired = true`), the
  leaderboard refresh, the login UI and route guards, realtime and its `realtime.messages` policy, and the `request_log` purge job.
- Unknown-account throttle rows (`auth_throttle`) are kept until a purge job exists (a later patch).
- Verified on plain PostgreSQL 16 and 18 (Linux). Supabase-specific behaviour (platform-created roles, default privileges,
  Data API exposure of the `public` schema, the `realtime` schema) has not been exercised.
- The participant home and question page still show the static mock timer from the layout image (03:46:54), which is longer
  than the 2-hour timer. It is a UI mock value removed when the real timer is wired in; it was left untouched on purpose.

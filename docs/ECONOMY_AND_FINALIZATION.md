# ECONOMY_AND_FINALIZATION.md — Patch B15

Hints, Buy Time, Final Submit, the 4-hour Ultimate Team Timer and the persisted end of a team's run. This is the single
reference for B15; the older documents carry short pointers to it.

## 1. What B15 delivers

| Area                  | Behaviour                                                                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ultimate Team Timer   | A team that starts now gets `competition.ultimate_seconds = 14 400` (4 h). The allowance is **copied onto the team** (`teams.timer_seconds`) when it starts and never edited afterwards.                                          |
| Teams already started | Keep their allowance: `timer_seconds = 7200`, original `started_at` and `ends_at`. Nothing is extended. (Production: TEST_2 and TEST_3 stay on 2 h.)                                                                              |
| End of the timer      | At zero the team is persisted as `ENDED` with `ended_at = ends_at` (the scheduled end, not the time something noticed). Done lazily on every read and every refused action, and by a scheduled sweep as a safety net (section 5). |
| Hints                 | Real purchases of Hint 1 and Hint 2. Team-wide, charged once at `hints.cost`. Tier 2 needs Tier 1. Allowed while the question is `ACTIVE`, `PENDING_APPROVAL` or `APPROVED`.                                                      |
| Buy Time              | Real purchases of a time pack for **one question**. Adds `question_buy_time_options.seconds` to that question's deadline and charges `…cost`. Never writes `teams.ends_at`.                                                       |
| Final Submit          | The team ends its own run. Same terminal freeze as the timer reaching zero, status `FINAL_SUBMITTED`.                                                                                                                             |
| Data-driven           | Prices, rewards and durations are read from the tables. No price, reward or timer length is hard-coded in `src/` apart from the one shared default `TEAM_TIMER_SECONDS` (a test guards this).                                     |

Not in B15 (B16 owns them): scoring, final minutes, leaderboard ranking, Admin penalties, the Reset/UFM score. B15
only **preserves** `started_at`, `ends_at`, `ended_at`, `final_submitted_at`, `final_submitted_by`, `timer_seconds` and
`competition.ultimate_seconds` so B16 can compute from them. Also untouched: the B16 question "240 vs per-team
allowance" (what 240 means for a 2 h team); B15 does not decide it.

## 2. Data

Migration `20261006000016_timer_14400_and_finalization.sql`

- `competition.ultimate_seconds` default and value 14 400; the lock check is renamed `competition_ultimate_locked_14400`.
- `teams.timer_seconds int`, backfilled to **7200 for started teams only**, NULL for teams that have not started. Strict check
  `teams_timer_seconds_iff_started`: `timer_seconds` is set exactly when `started_at` is set, and is positive. Anything that
  starts a team must therefore set both (B16 and later patches included).
- `teams.final_minutes_taken >= 0` (the old upper bound of 120 cannot hold for a 4 h team).
- `start_team_competition` stores `timer_seconds` and `ends_at = started_at + timer_seconds`.
- `app.team_state_json` adds `team.duration_seconds = coalesce(timer_seconds, ultimate_seconds)`, `team.expired` and `team.frozen`.
- `finalize_team_if_due(team)` and `expire_due_teams(limit)` (section 5).
- `state_version` is bumped for `NOT_STARTED` teams (their snapshot's `duration_seconds` changed), plus one `SYSTEM` audit row
  `TIMER_CONFIG_CHANGED`. The bump touches `teams.updated_at` through the existing `teams_touch` trigger; **started teams are
  not written to**, except for the `timer_seconds` backfill, which also touches their `updated_at`.

Migration `20261006000017_economy_and_final_submit.sql`

- `app.question_json` gains `hints[]` and `buy_time`.
- `buy_hint`, `buy_time`, `final_submit` (section 3).
- `disapprove_submission` re-declared with one change: a returned question of a frozen team gets `question clock + frozen
remaining` instead of `now + frozen remaining`.

`supabase/seed.sql` (development and CI only): hint prices 20 / 40, to match the production price decision.

Production hint prices are **not** changed by a migration. `B15-hint-prices.sql` is a separate script, delivered next to the patch and not part of it,
that a human runs on production after review (it sets `hints.cost` by tier). Nothing in this repository runs it.

## 3. Operations

All three follow the engine pattern of `unlock_theme`: member check → idempotency key → `app.lock_team` → replay → `app.assert_playable`
→ `app.settle_questions` → validation → balance → one transaction of coins + ledger + purchase row + `state_version` + audit →
`idem_store`. Every refusal raises, which rolls back everything: there is never a partial charge.

### `buy_hint(team, member, question, tier, key)`

`POST /api/p/questions/:questionId/hints` body `{ "tier": 1 | 2 }` (strict).

- Price = `hints.cost` read under the team lock; stored on the purchase row as `cost_paid`.
- Owned already → success with `already_owned: true`, no charge, no ledger row, no version bump.
- Errors: `VALIDATION_FAILED`, `COMPETITION_NOT_RUNNING`, `COMPETITION_PAUSED`, `TEAM_NOT_STARTED`, `TEAM_ENDED`, `ALREADY_SUBMITTED`,
  `NOT_FOUND`, `THEME_LOCKED`, `QUESTION_NOT_ACTIVE` (locked or available), `QUESTION_TIMED_OUT`, `HINT_TIER1_REQUIRED`,
  `INSUFFICIENT_COINS {have, need}`.
- The hint text reaches a team only after it owns it (`question.hints[].body_md`).

### `buy_time(team, member, question, option, expected_purchase_count, key)`

`POST /api/p/questions/:questionId/time` body `{ "optionId": n, "expectedPurchaseCount": n }` (strict).

- Only an `ACTIVE` question. `expectedPurchaseCount` must equal the question's current count, else `STALE_PURCHASE_COUNT {count}` and
  nothing is charged: two members pressing together buy once.
- Adds the option's stored seconds to `team_questions.timer_deadline`; **`teams.ends_at` is not written**. The question's
  playable time is still bounded by the team's end (`app.question_clock`), so seconds beyond it cannot be used; the dialog warns about it.
- Per-option cap `max_purchases` per team and question: `TIME_PURCHASE_LIMIT`.
- Errors: as above plus `QUESTION_NOT_ACTIVE` (pending approval / approved / locked), `QUESTION_TIMED_OUT`, `STALE_PURCHASE_COUNT`,
  `TIME_PURCHASE_LIMIT`, `INSUFFICIENT_COINS`, `NOT_FOUND` for an option of another question.

### `final_submit(team, member, confirm, key)`

`POST /api/p/final-submit` body `{ "confirm": true }` (strict).

- One `UPDATE` under the team lock: `status = FINAL_SUBMITTED`, `ended_at = now`, `final_submitted_at = now`, `final_submitted_by`.
- From then on every clock reads `ended_at`; every participant mutation fails with `ALREADY_SUBMITTED`; reading still works.
  It survives logout and login because it is only database state.
- Answers already waiting for review stay reviewable: approval pays once, the next question does not open.
- A team whose timer ran out first gets `TEAM_ENDED`. During a pause: `COMPETITION_PAUSED`.
- No score, minutes or penalty is computed (B16).

## 4. Freeze rules (timer end and Final Submit)

|                              | Timer reached zero                              | Final Submit                |
| ---------------------------- | ----------------------------------------------- | --------------------------- |
| Stored status                | `ENDED` (written by the first read or sweep)    | `FINAL_SUBMITTED`           |
| `ended_at`                   | `ends_at`                                       | the moment of submission    |
| `team.frozen`                | `true` (also in the window before it is stored) | `true`                      |
| Remaining time               | 0                                               | constant                    |
| Answers, hints, time, unlock | refused `TEAM_ENDED`                            | refused `ALREADY_SUBMITTED` |
| Pending answers              | still reviewable                                | still reviewable            |
| Coins and ledger             | untouched                                       | untouched                   |

## 5. Persisting the end of the timer

Lazy finalization is the **primary** correctness path; the scheduled sweep only makes stored state converge for a team nobody opens again.

1. **Reads.** `GET /api/p/state` and the server-side page loaders call `get_team_state`. When the snapshot says
   `expired && status = RUNNING` they call `finalize_team_if_due` and read again. A failing finalize falls back to the first snapshot,
   which already says `frozen`, so the screen is correct either way.
2. **Refused actions.** A mutation past the end raises `TEAM_ENDED` and rolls back. The handler then calls `finalize_team_if_due` in a
   separate transaction (it never raises) and returns the same `TEAM_ENDED` response.
3. **Sweep.** `GET /api/cron/expire-teams` calls `expire_due_teams(200)`, which ends every due `RUNNING` team with `FOR UPDATE SKIP LOCKED`
   (never queues behind live traffic) while the competition is `RUNNING`. During a pause nothing is due.

`finalize_team_if_due` and the sweep end a team at its own `ends_at`, time out `ACTIVE` questions whose deadline is not later than that
end, leave questions with a later deadline `ACTIVE` (shown frozen), and do not touch coins, the ledger or submissions. Both are idempotent.

### The cron route

- `GET /api/cron/expire-teams`, header `Authorization: Bearer <CRON_SECRET>`. The secret must be at least 32 characters and is compared in
  constant time. Missing, malformed or wrong → `401` **before any database call**. No secret configured → every request is `401` (fail closed).
- Other methods → `405` with `Allow: GET`. No cookie, no Origin check, no body: nothing request-supplied reaches the database.
- Response `200 { ok, data: { finalized: n } }`, `Cache-Control: no-store`; a database failure is a generic `503`.
- `vercel.json` schedules it once a day (`17 3 * * *`), the only frequency the Hobby plan allows. On the **Pro** plan change it to every minute
  (`* * * * *`). Correctness never depends on the schedule because of lazy finalization.
- **Vercel setup:** define `CRON_SECRET` (32+ random characters) in the project's environment; Vercel then sends it as the bearer token.
- `pg_cron` is **not** used or assumed.

## 6. Participant API additions

- `GET /api/p/state` → `team.duration_seconds`, `team.frozen`.
- `GET /api/p/questions/:id` and the purchase results carry
  `hints: [{ tier, cost, owned, purchasable, body_md? }]` and
  `buy_time: { purchase_count, extra_seconds, can_buy, options: [{ id, seconds, cost, max_purchases, purchased, remaining_purchases }] }`
  (options only while the question is `ACTIVE`).
- Results: `buy_hint` → `{ already_owned, tier, hint: { tier, body_md }, question, state }`; `buy_time` → `{ purchase: { seq, option_id, seconds, cost }, question, state }`;
  `final_submit` → the frozen snapshot itself. All three mark an idempotent replay with `Idempotent-Replay: true`.
- New error codes: `HINT_TIER1_REQUIRED` (409), `STALE_PURCHASE_COUNT` (409, `details.count`), `TIME_PURCHASE_LIMIT` (409).

## 7. Interface

- Hint 1 / Hint 2 buttons: price from the server; after purchase they open the text for free. Hint 2 reads "after Hint 1" until Hint 1 is owned.
- Buy time: a dialog lists the packs the server sent, asks "Are you sure?", warns when a pack can only be used in part, and on a stale count or any other
  refusal returns to the list with a fixed-wording message. One idempotency key per intent, kept across a lost connection, dropped on a definitive answer.
- Final Submit: the home ticket opens a confirmation (irreversible, lists answers still under review); afterwards the ticket reads `SUBMITTED`.
- A frozen team sees "Your team's time is up." or "Your team has made its final submission."; buttons that spend are disabled. The question
  countdown never shows more than the team has left.
- Nothing is persisted in the browser: no `localStorage`, no `sessionStorage`.

## 8. Tests that prove it

| Layer                | File(s)                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL                  | `supabase/tests/120_timer_14400_finalization`, `130_hints_and_buy_time`, `140_final_submit_freeze` (and the adapted 10, 20, 60, 80, 90, 100) |
| Concurrency          | `supabase/tests/concurrency/team_economy.concurrency.mjs` (12 scenarios); `start_team` and `team_play` adapted to 14 400                     |
| Upgrade              | `supabase/tests/upgrade/b15_upgrade.upgrade.mjs`: migrates a database holding pre-B15 teams and proves they keep 7200                        |
| Unit                 | `economy-contracts`, `economy-handlers`, `economy-client`, `cron-route`, `runtime-handlers` (lazy finalize), `gameplay-derive`               |
| Component            | `tests/component/economy.test.tsx` and the adapted home / question tests                                                                     |
| Browser (Playwright) | `economy.spec`, `final-submit.spec`, `timer-end.spec`, `cron.spec` (own project, runs last)                                                  |

The Playwright suite runs against an in-memory stand-in of the database (`tests/e2e/support/fake-gameplay.mjs`) that mirrors the SQL rule for rule;
the SQL itself is proven by the database suites. A rule changed in one must be changed in the other.

## 9. Open points handed to later patches

- **B16:** scoring and the leaderboard (including how a 2 h team is compared with 4 h teams), `final_minutes_taken`, and the question "240 vs per-team allowance".
- Any code that sets `started_at` must also set `timer_seconds` (the strict check refuses otherwise).
- On Vercel Hobby the sweep runs daily only; use Pro for per-minute convergence if stored `ENDED` must follow the clock closely without anyone reading.

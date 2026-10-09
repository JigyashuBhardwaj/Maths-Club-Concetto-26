# TEST_PLAN.md — Maths Club Concetto 26

Status: **proposal for review (Milestone 0).** No test code exists yet. (Only the schema's constraints were smoke-tested once by hand; see `REVIEW.md` §10.) When tests exist, every patch states exactly which were run and their real output (brief §42).

## 1. Strategy

The engine is in Postgres, so the most valuable tests run **against a real Postgres** with the controllable clock `app.now()` (see `DATA_MODEL.md` §2). That lets us test "2 hours later" and "question timed out 1 second ago" deterministically, without sleeping.

| Layer | Tool | What it covers | Where it runs |
|-------|------|----------------|---------------|
| **DB** | SQL scripts / pgTAP, driven by Vitest | Engine functions, constraints, invariants, concurrency (parallel connections), test clock | Local Supabase (Docker) or a throwaway cloud dev project with `app.allow_test_clock='on'` |
| **U** (unit) | Vitest | Validation schemas, error-code mapping, countdown/skew maths, display-score parity | Node |
| **API** | Vitest + fetch against the running app | AuthN/AuthZ, idempotency, status codes, tamper attempts | Local app + local DB |
| **E2E** | Playwright (multi-context) | Real user flows with 2–5 browsers at once, refresh/crash recovery, fullscreen, realtime visibility | Local, then Vercel preview + staging DB |
| **LOAD** | k6 (HTTP) + Node script (WebSocket/Realtime) | Capacity, latency, error rate, reconnect storm | Staging environment identical in plan/compute to production |

Test data is created by the tests themselves (never the demo seed in production).

## 2. Invariant tests (run after **every** DB/API test and after every load run)

| ID | Check |
|----|-------|
| INV-01 | For every team: `teams.coins = Σ coin_transactions.amount` |
| INV-02 | No negative balance, no duplicate `THEME_UNLOCK`/`HINT_PURCHASE`/`QUESTION_REWARD` rows |
| INV-03 | ≤ 1 `PENDING` submission per (team, question) |
| INV-04 | Every `ACTIVE`/`PENDING`/`APPROVED` question has all lower ordinals `APPROVED`; every `AVAILABLE` question is ordinal 1 |
| INV-05 | Each unlocked theme has exactly 5 `team_questions` rows; none for locked themes |
| INV-06 | Timer columns consistent with state (`ACTIVE`⇔deadline, `PENDING`⇔remaining) |
| INV-07 | Terminal teams: no coin/question change after `ended_at` (except permitted late review) |
| INV-09 | Exactly one Super Admin |
| INV-10 | Update/delete on `audit_events` fails |
| INV-11 | A team owns Tier 2 of a question only if it owns Tier 1 |
| INV-12 | Official score = override (Disqualified only) else baseline-adjusted (floored at −1200) else raw; reset columns both set or both null **[B16: Changed in B16. See SCORING_AND_LEADERBOARD.md.]** |

A single `check_invariants()` SQL function runs all of them and is called by tests, by the load-test teardown, and as a pre-event check.

## 3. Test matrix (mapped to brief §37)

### 3.1 Authentication (AU)

| ID | Scenario | Layer |
|----|----------|-------|
| AU-01 | Valid participant login (team ID + password + member admission no.) | API |
| AU-02 | Invalid password / unknown team / admission number of a different team → same generic error, similar latency | API |
| AU-03 | Staff login valid/invalid; disabled admin rejected | API |
| AU-04 | Role guards: participant → admin route = 403; admin → super route = 403; unauthenticated = 401 | API |
| AU-05 | Member identity: two members of one team logged in → actions attributed to the right `member_id` | DB/API |
| AU-06 | Session recovery: refresh keeps the session; logout revokes; second login supersedes the first (old cookie then 401) | API/E2E |
| AU-07 | Login throttling per account; a different account from the same IP is unaffected | API |
| AU-08 | Cannot log in while competition is `SETUP`; can while `RUNNING`/`PAUSED` | API |

### 3.2 Competition engine (CE)

| ID | Scenario | Layer |
|----|----------|-------|
| CE-01 | The first *Enter competition* (after rules + fullscreen acknowledgement) starts the team timer; `ends_at = started_at + timer_seconds` (**B15: 14,400 s**; a team started before B15 keeps 7,200) | DB |
| CE-02 | Second member entering later sees the already-reduced timer; second start call does not restart it | DB/E2E |
| CE-03 | Timer is server-authoritative: manipulated client clock changes nothing (API contains no time input) | API/E2E |
| CE-04 | Team timer keeps running while a question is `PENDING_APPROVAL` | DB |
| CE-05 | Question timer freezes at submit (`timer_remaining_seconds`) | DB |
| CE-06 | Disapproval resumes the question timer from the frozen value and keeps the draft | DB |
| CE-07 | Approval awards the fixed reward, activates the next question with a fresh timer | DB |
| CE-08 | Question deadline passes → `TIMED_OUT`; later questions stay `LOCKED`; theme shows failed | DB |
| CE-09 | Team timer reaches 0 → team `ENDED`, `ended_at = ends_at`, all mutations rejected, score frozen | DB |
| CE-10 | Final submit freezes everything; second call → `ALREADY_SUBMITTED` | DB |
| CE-11 | Global pause freezes all clocks; resume shifts deadlines by exactly the paused duration | DB |
| CE-12 | Sweeper ends idle expired teams without any user request; `ended_at` equals scheduled end. **B15:** `expire_due_teams` via the Vercel Cron route (bearer `CRON_SECRET`), not `pg_cron` | DB/API/E2E |
| CE-13 | Submit with an answer already `PENDING` → `SUBMISSION_PENDING` | DB |
| CE-16 | Logging in (any number of members, any number of times) never starts or changes the team timer; `team.status` stays `NOT_STARTED` | DB/E2E |
| CE-17 | Unlocking a theme leaves Q1 `AVAILABLE` with `timer_deadline IS NULL`; Q2–Q5 `LOCKED`; no question timer starts | DB |
| CE-18 | Entering Q1 (`start_question`) moves it `AVAILABLE → ACTIVE` with `deadline = now + time_limit`; a second call (same or other member) returns the same deadline; `LOCKED`/`TIMED_OUT` → `QUESTION_NOT_AVAILABLE`; the body is returned only once `ACTIVE` | DB |
| CE-19 | Two themes with an `ACTIVE` question each run independent timers: submitting, approving, disapproving or timing out one leaves the other's deadline unchanged; both shift equally on a global pause | DB |
| CE-20 | Approval starts the next question's timer at the approval instant; a team that has ended starts nothing | DB |
| CE-21 | Two members enter Q1 simultaneously (parallel connections) → activated exactly once, both receive the identical deadline, one `QUESTION_STARTED` audit row | DB |
| CE-22 | **B15.** A team starting now stores `timer_seconds = 14400`; teams started earlier keep 7200, their original `started_at`/`ends_at`, and are not extended by the migration (upgrade test) | DB |
| CE-23 | **B15.** `finalize_team_if_due` / `expire_due_teams` end a due team at its own `ends_at`, time out only questions due by then, never touch coins or the ledger, are idempotent, and do nothing while the competition is paused | DB |
| CE-24 | **B15.** Lazy finalization: a read of an expired team persists `ENDED`; a refused action returns `TEAM_ENDED` and the end is still persisted by the follow-up finalize | API/E2E |
| CE-25 | **B15.** Hints: team-wide, charged once from `hints.cost`, Tier 2 needs Tier 1, allowed on `ACTIVE`/`PENDING_APPROVAL`/`APPROVED`, refused otherwise; `INSUFFICIENT_COINS` charges nothing; replay of the same key charges nothing | DB/API/E2E |
| CE-26 | **B15.** Buy Time: moves only the question deadline, never `teams.ends_at`; `STALE_PURCHASE_COUNT` for the second of two simultaneous buyers; `TIME_PURCHASE_LIMIT`; exactly-once under 16-team concurrency | DB/concurrency/E2E |
| CE-27 | **B15.** Final Submit and timer end freeze the same things: every participant mutation refused, reads allowed, remaining time constant, pending answers still reviewable (pay once, no next question), persists across logout/login | DB/API/E2E |
| CE-28 | **B15.** `GET /api/cron/expire-teams`: 401 before any database call without the exact secret, fail-closed without `CRON_SECRET`, 405 for other methods, `{finalized: n}` only | unit/E2E |
| CE-14 | Can work on theme B while theme A question is pending | DB/E2E |
| CE-15 | Different members work on different themes simultaneously | E2E |

### 3.3 Coins (CO)

| ID | Scenario |
|----|----------|
| CO-01 | New team has exactly 500 (ledger `INITIAL_GRANT`) |
| CO-02 | Unlock theme: deduct, ledger row, all members see unlocked |
| CO-03 | Buy hint: deduct once, whole team gets it; second member's buy is free/no-op |
| CO-04 | Buy time: deduct, deadline extended, `ends_at` unchanged |
| CO-05 | Buy time after deadline → rejected, no charge |
| CO-06 | Reward credited once per question even if approve is retried |
| CO-07 | Insufficient balance → `INSUFFICIENT_COINS`, balance unchanged |
| CO-08 | Duplicate request (same key) → single effect, identical response |
| CO-09 | Simultaneous purchases by 4 members totalling more than the balance → exactly the affordable ones succeed, balance never negative (parallel DB connections) |
| CO-10 | Two members click *Buy time* together → one succeeds, other `STALE_PURCHASE_COUNT` |
| CO-11 | Tier 2 without Tier 1 → `HINT_TIER1_REQUIRED`, no charge; Tier 1 then Tier 2 succeeds; the database trigger rejects a direct Tier 2 insert; hints cannot be bought for an `AVAILABLE` question |

### 3.4 Realtime (RT)

| ID | Scenario |
|----|----------|
| RT-01 | M1 unlocks a theme → M2–M4 show it unlocked and the new balance (≤ 2 s) |
| RT-02 | Coin changes propagate to all members |
| RT-03 | Approval propagates to all four members |
| RT-04 | Admin sees a new pending submission without refresh |
| RT-05 | Admin sees member online/offline change (join, close tab, kill network) |
| RT-06 | Leaderboard updates within ~60 s of a score change **[B16: the leaderboard is a derived read (no snapshot table, no cron refresh), polled every 15 s with jitter. See SCORING_AND_LEADERBOARD.md.]** |
| RT-07 | Realtime disabled entirely (block WebSocket) → UI still converges via poll within 15 s |
| RT-08 | Missed/duplicated/out-of-order pings do not corrupt UI (version rule) |

### 3.5 Recovery (RC)

| ID | Scenario |
|----|----------|
| RC-01 | Refresh mid-question restores timers, draft, state |
| RC-02 | Close and reopen browser → login → same state; draft text restored from the server copy |
| RC-03 | Network down 60 s while typing → local backup kept; on reconnect draft saved; no loss |
| RC-04 | Member logs out/in → state identical |
| RC-05 | Fullscreen exit → draft flushed before the session is revoked; relogin restores |
| RC-06 | Server-confirmed progress survives a Vercel redeploy during a session |

### 3.6 Admin (AD)

| ID | Scenario |
|----|----------|
| AD-01 | Admin sees only assigned teams; direct URL to another team → 404/403 |
| AD-02 | Approve → cell turns green, reward applied, next question `ACTIVE` with a fresh timer |
| AD-03 | Disapprove → returns to active, draft kept, rejected row retained |
| AD-04 | Reset score and disqualify each need the two-step confirmation; direct call without a challenge fails |
| AD-05 | UFM writes an audit event with the previous score |
| AD-06 | Every event in the catalogue (`STATE_MACHINE` §8) appears in the audit log with the right actor |
| AD-07 | Create team: validation (password match, duplicates of team ID/login/admission numbers); auto-assigned to creator; 500 coins |
| AD-08 | Two admins (or admin + Super Admin) review one submission → one succeeds, other `SUBMISSION_NOT_PENDING` |
| AD-09 | Super Admin creates/disables admins; disabled admin's sessions die immediately |
| AD-10 | UFM Reset: score reads 0, `team.status` stays `RUNNING`, timers keep running, the team can still unlock/submit and be reviewed; audit holds previous score, raw score and baseline **[B16: Replaced by supabase/tests/160_ufm_penalty.test.sql. See SCORING_AND_LEADERBOARD.md.]** |
| AD-11 | UFM Disqualify: score reads −1201, status `DISQUALIFIED`, every later mutation rejected; a Reset followed by a Disqualify ends at −1201 **[B16: Not built; replaced by the penalty (160). See SCORING_AND_LEADERBOARD.md.]** |

### 3.7 Scoring (SC)

| ID | Scenario |
|----|----------|
| SC-01 | Formula: `themes×500 + solved×100 + coins − minutes×5` on hand-computed fixtures |
| SC-02 | Minutes taken uses the floor of remaining minutes; boundaries 0:00, 0:59, 1:00, 120:00 |
| SC-03 | Score freezes at `ended_at` for final-submitted and ended teams |
| SC-04 | Disqualify override is exactly −1201; the minimum natural score (−1200) is above −1201 **[B16: Not applicable: no Disqualify override. See SCORING_AND_LEADERBOARD.md.]** |
| SC-07 | Reset baseline: score 850 → Reset → 0 → earn 100 (approval) → 100; the time penalty and purchases keep applying after the Reset |
| SC-08 | Reset floor: a reset team whose raw score falls far below its baseline never scores below −1200 |
| SC-09 | Second Reset re-zeroes from the then-current raw score; Reset then Disqualify → −1201 and the baseline is retained **[B16: Not applicable: no Reset. See SCORING_AND_LEADERBOARD.md.]** |
| SC-05 | TypeScript display formula equals the SQL function on 1,000 random states (parity test) |
| SC-06 | Not-started teams excluded from the leaderboard; tie-break order stable |

### 3.8 Security (SE)

| ID | Attack |
|----|--------|
| SE-01 | Team A requests team B's state/question/draft → 403/404 |
| SE-02 | Admin A opens/acts on team of admin B → 403/404 |
| SE-03 | Participant calls admin or super endpoints → 403 |
| SE-04 | Role escalation by editing cookie/body fields → ignored/401 |
| SE-05 | Duplicate submission under parallel requests → one row |
| SE-06 | Tampered score/coins/time in request bodies → ignored (fields not accepted); server value unchanged |
| SE-07 | Locked-question body not retrievable by id guessing; hints of unowned tiers return no text |
| SE-08 | `anon` key cannot `select` any table or execute any engine function (script-verified) |
| SE-09 | XSS payloads in answer/explanation/team name render inert in admin UI |
| SE-10 | CSRF: cross-origin POST rejected by Origin check |
| SE-11 | Audit table rejects UPDATE/DELETE even with the service role |
| SE-13 | No participant response, for any question state (including `APPROVED` "Previous"), contains `reference_answer` or `solution_notes`; the approved view contains only the team's own answer, explanation, status and reviewer note |
| SE-14 | An `AVAILABLE` question's body is not returned by any participant endpoint until `enter` has activated it |
| SE-12 | Secret scan of repo and build output finds nothing |

### 3.9 Concurrency (CC) — parallel DB connections / `Promise.all`

CC-01 two unlocks of the same theme · CC-02 four buys of one hint · CC-03 four buy-times with `expectedPurchaseCount` · CC-04 submit vs timeout at the deadline instant · CC-05 approve vs disapprove on one submission · CC-06 final submit ×4 · CC-07 sweeper vs student request on an expiring team · CC-08 resume-from-pause vs purchase · CC-09 two members enter Q1 together (`CE-21`) · CC-10 Reset vs Disqualify at one instant.

Each repeats 200× with randomised interleavings; all must end with `check_invariants()` clean.

## 4. End-to-end scenarios (Playwright)

| ID | Flow |
|----|------|
| E2E-01 | Full happy path: login → rules → fullscreen → enter → unlock → start Q1 → solve 5 → theme complete → final submit → score matches fixture |
| E2E-02 | Four members, two themes in parallel, shared coins and unlocks visible everywhere |
| E2E-03 | Reject then resubmit, timer resumes |
| E2E-04 | Question times out; theme turns greyscale; other theme still playable |
| E2E-05 | Team timer expiry (test clock) ends the team for all members |
| E2E-06 | Kill network 60 s then restore; no lost draft, state converges |
| E2E-07 | Fullscreen exit logs out one member, others unaffected, admin alerted |
| E2E-08 | Admin matrix and review flow; UFM two-step |
| E2E-09 | Responsive/a11y smoke: keyboard-only through unlock + submit; reduced-motion respected |
| E2E-10 | Unlock a theme → no timer anywhere; opening Q1 starts its timer (no Start button in the UI); a teammate opening it afterwards sees the same deadline |
| E2E-11 | Previous approved question shows only the team's own answer, explanation, state and reviewer note — never the reference answer |
| E2E-12 | **B15.** `economy.spec`: hints and Buy Time through the API and the dialogs; `final-submit.spec`: the irreversible action and its freeze; `timer-end.spec`: 4 h, kept 2 h, ENDED at zero; `cron.spec` (own project, runs last): the sweep |

## 5. Load tests (brief §38) — nothing is claimed until these are run

**Environment:** staging with the same Supabase plan, compute size and region as production (Pro or higher — Free's 200-connection Realtime cap makes a valid test impossible), same Vercel plan. Target 300 users minimum, 400 preferred. Each virtual user belongs to one of 100 teams of 4 (so shared-state contention is realistic, not 300 independent games).

| ID | Scenario (brief §38) | Pass criteria (proposed) |
|----|----------------------|--------------------------|
| LT-01 | Simultaneous login of 400 | p95 < 2 s, 0 failures, no throttle false-positives from shared IP |
| LT-02 | Simultaneous dashboard (`/api/p/state`) load | p95 < 400 ms |
| LT-03 | 400 simultaneous Realtime sockets + presence | 100% connect, presence consistent, no drops over 30 min |
| LT-04 | Autosave traffic (all typing, 3 s debounce, 30 min) | p95 < 400 ms, 0 lost drafts |
| LT-05 | Simultaneous coin purchases (hot teams, parallel) | 0 invariant violations, p95 < 600 ms |
| LT-06 | Simultaneous submissions | 0 duplicates, p95 < 600 ms |
| LT-07 | Many admin reviews (20 admins reviewing continuously) | p95 < 600 ms, queue never stalls |
| LT-08 | Leaderboard refresh under 400 clients | DB reads ≈ constant, p95 < 300 ms (CDN hit) |
| LT-09 | Reconnect storm: drop all sockets at once, reconnect with jitter | recovers < 60 s, no error spike > 1% |
| LT-10 | Soak: LT-02+04+05 combined for 60 min | stable memory/latency; invariants clean at end |

**Report (template):** latency (p50/p95/p99) per endpoint · error rate by code · DB CPU, connections, slow queries (`pg_stat_statements`) · Realtime connection/message counts vs plan limits · Vercel function duration/cold starts/errors · bottlenecks found · recommended changes · invariant check result · exact commit/environment tested. Thresholds above are proposals to be agreed before the run.

## 6. Exit criteria per milestone

| Milestone | Must be green before the patch is offered |
|-----------|-------------------------------------------|
| M1 Foundation | lint, typecheck, unit smoke, CI, secret scan |
| M2 Database | migrations apply from empty; invariant function; constraint tests (INV, SC-01–04, CO-01) |
| M3 Auth | AU-*, SE-03/04, SE-08 |
| M4 Engine | CE-*, CO-*, CC-*, SC-*, INV after each |
| M5 Realtime | RT-*, SP-01…04 spike results documented |
| M6/M7 UI | E2E-01…09 on the relevant screens; a11y smoke |
| M9 Hardening | RC-*, AD-06, SE-* all |
| M10 Testing | all of the above + LT-01…10 report |
| M12 Freeze | full E2E + LT-10 on the exact production commit; checklist in `DEPLOYMENT.md` §9 |

## 7. Not tested / accepted gaps

Fullscreen cannot be proven secure (it is a rule mechanism). Behaviour on iOS Safari is out of scope (fullscreen API is unavailable there); the event requires laptops/desktops on current Chrome/Edge/Firefox — to be confirmed (`RISK-07`).

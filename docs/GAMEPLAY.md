# Gameplay engine — the first vertical slice (Patch B13)

Participant gameplay is **server-authoritative**: the database decides every state, balance, deadline and reward, and the browser only asks and then shows what the server answers. This patch replaces the demo behaviour of the home and question pages with that engine. It uses the B9/B10 architecture unchanged (SECURITY DEFINER functions called with the service role, `app.lock_team`, `request_log` idempotency, `audit_events`, `state_version`, the error envelope) and adds no new realtime or infrastructure.

## The flow

| Step                      | What happens                                                                                                                                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login                     | Creates a session only. It does **not** start the team timer.                                                                                                                                                                                                                 |
| Enter competition         | The first member to press the button (`POST /api/p/start`, idempotent) starts the team timer: `ends_at = started_at + 7200 s` for everyone. Later entries return the same times.                                                                                              |
| Theme unlock              | `POST /api/p/themes/:id/unlock`. **Team-wide**: one `team_themes` row for `team_id + theme_id`; the cost comes from the theme and is charged once. Two members unlocking together give one unlock and one `409 THEME_ALREADY_UNLOCKED`. Q1 becomes `AVAILABLE`, timer `NULL`. |
| Enter Q1                  | The question page calls `POST /api/p/questions/:id/enter` when it opens (there is no Start button). `AVAILABLE → ACTIVE` once; the deadline is `now + time limit`, and every member, retry and refresh gets the same deadline.                                                |
| Draft                     | One shared draft per team and question, saved on the server with compare-and-set on `expectedVersion` (`STALE_DRAFT` if a teammate saved first).                                                                                                                              |
| Submit                    | `POST /api/p/questions/:id/submit`, idempotent. Records the submitting member, `ACTIVE → PENDING_APPROVAL`, freezes the question timer (the team timer keeps running). One pending submission per team and question.                                                          |
| Approve (controlled path) | `POST /api/admin/submissions/:id/approve` (the Admin of the team, or the Super Admin). `PENDING_APPROVAL → APPROVED`, the fixed reward is paid **once**, the next question becomes `ACTIVE` with its own deadline.                                                            |
| Disapprove                | `POST /api/admin/submissions/:id/disapprove`. The rejected row is kept, the draft is kept, the question returns to `ACTIVE` with its frozen remaining time.                                                                                                                   |

Question states: `LOCKED`, `AVAILABLE`, `ACTIVE`, `PENDING_APPROVAL`, `APPROVED`, `TIMED_OUT`. Q2–Q5 stay `LOCKED` until the previous question is approved. Different themes may have `ACTIVE` questions at the same time; timers belong to the team and the question, not to a member.

## Review path

Approve and Disapprove are the endpoints above. Since Patch B14 the Admin reaches them from **My Teams** (team → theme → question → submission, see `ADMIN_MATRIX.md`); the temporary B13 `/admin/review` page and `GET /api/admin/queue` were removed.

## Where things live

| Layer               | Files                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database            | `supabase/migrations/20261006000014_gameplay_engine.sql` (see `DATABASE_FOUNDATION.md`)                                                                                                                                        |
| Contracts           | `src/lib/contracts/gameplay.ts` (request and whitelist result schemas), `runtime.ts` (snapshot)                                                                                                                                |
| Routes and handlers | `src/lib/gameplay/handlers.ts`, `routes.ts`, `src/app/api/p/**`, `src/app/api/admin/submissions/**`                                                                                                                            |
| Browser             | `src/lib/gameplay/client.ts` (calls), `derive.ts` (clock offset, remaining time, effective state), `messages.ts`; `src/components/game/*` (provider, entry gate, banner); `src/components/question/*`; `src/components/home/*` |
| Test backend (E2E)  | `tests/e2e/support/fake-gameplay.mjs`, an in-memory mirror of the SQL rules for the browser tests                                                                                                                              |

## Security rules

- The team and member come **only** from the session. Request bodies are strict: a forged `team_id`, `coins`, `state`, `reward` or `cost` is a `400`, never trusted.
- A participant sees only their own team. Another team's themes, drafts and submissions are not reachable by any id.
- A `LOCKED` question never leaves the server (the snapshot lists no questions for a locked theme). An `AVAILABLE` question returns metadata only; the body is delivered after the team has entered it.
- `reference_answer` and `solution_notes` are not selected by any participant function and no result schema has a field for them.
- The service-role key stays on the server; no auth state or competition answer is kept in `localStorage`/`sessionStorage`. The only thing the browser holds is the text being typed.

## Time

- Every deadline is an absolute server instant. The browser aligns its clock to `server_now` of each response and counts down locally, but it never submits a time.
- The team timer stops counting while the competition is `PAUSED`; question deadlines are shifted on `resume` by the paused duration.
- **Lazy expiry.** A rejected request is rolled back, so reads **derive** `TIMED_OUT` for an overdue `ACTIVE` question without writing, and every successful mutation persists it first (`app.settle_questions`). See `STATE_MACHINE.md`.

## Synchronisation

The database is the source of truth. The participant layout loads the snapshot on the server and a provider refreshes it by polling `GET /api/p/state` about every 5 seconds (with jitter), on focus and after every action; a response older than the one on screen (`state_version`) is ignored. The question page re-reads its own question after state changes. A failed poll shows a "Reconnecting…" banner and the next success clears it. Realtime push (`REALTIME_SPEC.md`) is not shipped in this patch.

## Concurrency and idempotency

All mutations take the B10 team lock (competition `FOR SHARE`, then the team row `FOR UPDATE`), check `request_log` for a replay, run the gates, and only then write. A key is bound to its operation, actor and parameters (`IDEMPOTENCY_KEY_REUSED` otherwise); only successes are stored.

| Scenario                           | Result                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Two members unlock the same theme  | one unlock, one deduction, the other gets `THEME_ALREADY_UNLOCKED`                                   |
| Two members enter Q1               | one activation, one deadline                                                                         |
| A retried `start_question`         | replay, same deadline, no second audit row                                                           |
| A retried `submit_answer`          | replay, one submission                                                                               |
| Submit races the question deadline | decided by the lock: either `PENDING_APPROVAL` or `QUESTION_TIMED_OUT`, never both                   |
| Approval and reward                | the reward ledger row is unique per team and question; a second approval is `SUBMISSION_NOT_PENDING` |
| Team timer and question timer      | independent: neither writes the other                                                                |
| Refresh or reconnect               | reads only; nothing is created                                                                       |

## Tests

- SQL: `supabase/tests/100_gameplay.test.sql` and `supabase/tests/concurrency/team_play.concurrency.mjs` (real parallel sessions), run by `npm run db:verify`.
- Unit: `gameplay-contracts`, `gameplay-handlers`, `gameplay-derive`, `gameplay-client`, plus the updated envelope, foundation and runtime tests.
- Component: `tests/component/home.test.tsx`, `question-page.test.tsx`.
- E2E: `tests/e2e/gameplay.spec.ts` plays one team with **two separate browser contexts** (entry, timer start, team-wide unlock seen by the second member, Q1 entry and the same deadline, draft surviving a refresh, submit → pending, controlled approval, reward once, Q2 active, the client unable to override the server, no reference answer anywhere). `participant-home.spec.ts` and `question-page.spec.ts` were reworked from the demo values to the server-backed ones. The browser tests use an in-memory stand-in for Supabase (`tests/e2e/support/fake-postgrest.mjs`), whose gameplay rules mirror the SQL; the SQL itself is proven by the database tests above.

## Not in this patch

The rest of the Admin product (UFM, question keys; the My Teams matrix is Patch B14), hints, Buy Time, the full coin economy, Final Submit, final scoring, UFM, the participant leaderboard, presence, fullscreen enforcement, realtime push and load testing.

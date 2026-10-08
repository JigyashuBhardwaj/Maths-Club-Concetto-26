# ARCHITECTURE.md — Maths Club Concetto 26

Status: **proposal for review (Milestone 0).** Priority order from the brief: reliability > correctness > data integrity > security > performance > UX > visual extras.

---

## 1. The one-paragraph architecture

A Next.js (App Router, TypeScript) application on Vercel serves the UI and a thin JSON API. **All competition rules live in Postgres functions** on Supabase: each of the critical operations (unlock, start question, buy, submit, approve, final submit, …) is one database transaction that locks the team row, checks every rule, writes the change, writes the audit row and emits a realtime "something changed" ping. The browser never decides anything about time, coins, score or state; it renders what the server says and re-fetches the authoritative snapshot whenever it is pinged (and on a slow poll as a safety net). Supabase Realtime is used only as a **notification channel**, never as the data channel and never as the source of truth.

## 2. System context

```
 ┌────────────────────────────── Browser (participant / admin / super admin) ──────────────────────────────┐
 │  Next.js client components                                                                              │
 │   • renders snapshot from GET /api/p/state        • countdown = server deadline − (local clock + skew)  │
 │   • sends mutations with Idempotency-Key          • Realtime ping → re-fetch snapshot (+ 15 s poll)     │
 └───────────────┬───────────────────────────────────────────────────────────────────▲─────────────────────┘
                 │ HTTPS (cookie session)                                            │ WebSocket (ping + presence only)
                 ▼                                                                   │
 ┌──────────────────────────┐   service-role (server only)    ┌──────────────────────┴──────────────────────┐
 │ Vercel: Next.js server   │ ──────────────────────────────▶ │ Supabase                                    │
 │  • route handlers (/api) │   supabase-js .rpc('fn', args)  │  Postgres: schema, constraints, engine fns │
 │  • session check         │                                 │  Realtime: broadcast + presence             │
 │  • zod validation        │ ◀────────────────────────────── │  pg_cron: sweeper, leaderboard refresh      │
 │  • thin: no game rules   │         JSON result             └─────────────────────────────────────────────┘
 └──────────────────────────┘
```

## 3. Key decisions (ADR summary)

| # | Decision | Why | Alternative rejected |
|---|----------|-----|----------------------|
| A1 | **Engine as PL/pgSQL functions**, called through `supabase-js .rpc()` | One round trip per operation, real transactions with row locks, no connection held across network calls, rules testable against a real database | Multi-statement transactions from TypeScript (more round trips, easier to leave a gap between "check" and "write") |
| A2 | **Custom session auth for all three roles** (opaque token in an `HttpOnly` cookie, `sessions` table) | Login is *team ID + password + admission number*, which Supabase Auth does not model; opaque tokens can be revoked instantly (fullscreen exit, disabled admin, superseded login) | Supabase Auth (awkward for shared team accounts); JWT-only sessions (cannot revoke) |
| A3 | **Realtime = ping + presence only**; clients re-fetch the snapshot | Messages carry no sensitive data, so a leaked or guessed channel reveals nothing; a missed message is repaired by the next poll; no per-subscriber RLS cost | `postgres_changes` (per-subscriber authorisation work, scales poorly, couples UI to table shapes) |
| A4 | **Pings are emitted from inside the transaction** (`realtime.send`) | An event exists iff the change committed; a serverless function dying after commit cannot lose an event | Publishing from the API route after the RPC returns (can be lost) |
| A5 | **Timers are timestamps** (`ends_at`, `timer_deadline`) computed from DB time; paused timers are frozen integers | Survives crashes, refreshes and server restarts; no ticking job needed; global pause is a single shift | Per-second server counters / client countdowns |
| A6 | **Lazy expiry + `pg_cron` sweeper** | Correct the instant anyone looks, and still correct when nobody is online | Sweeper only (race windows); lazy only (leaderboard stale for idle teams) |
| A7 | **Leaderboard is a cached snapshot row** refreshed ≤ every 60 s | 300 browsers never trigger 300 aggregate queries | Per-request aggregate; per-change recompute |
| A8 | **Per-team Realtime channels** (4 members each) | Presence fan-out stays at 4², not 300² | One global presence channel (≈ 90,000 messages at login) |
| A9 | **Idempotency-Key on every mutation**, enforced by `request_log` | Retries after network loss cannot double-spend or double-approve | Hoping the client doesn't retry |
| A10 | **Co-locate Vercel functions and Supabase** in the same region (proposed: Mumbai / `ap-south-1`, Vercel `bom1`) | Users are in India; each API call is one DB hop | Default US regions (+200 ms per call) |
| A11 | **Content seeded, read-only at runtime** | No content-editing surface to defend or break during the event | Admin content CMS |

Decisions A1, A2 and A3 are the ones most worth challenging in review; they are listed as `DEC-20`, `DEC-21`, `DEC-23` in `REVIEW.md`.

## 4. Responsibilities

| Layer | Owns | Must not |
|-------|------|----------|
| Browser | Rendering, local countdown display, draft typing, fullscreen detection, retry with the same idempotency key | Hold authority over time, coins, score, state, or role |
| Next.js server | Session cookie → principal, input validation (zod), rate limiting, calling engine functions, shaping responses, secrets | Contain game rules; talk to the DB with more than one call per operation |
| Postgres | Rules, state machines, ledger, constraints, authorisation re-checks, audit, ping emission, sweeper | Trust any identifier it was not given by an authenticated server call |
| Realtime | "Something changed" pings, per-team presence | Carry state or secrets |

## 5. Anatomy of one mutation (example: buy a hint)

```
Browser                     Next.js route               Postgres (buy_hint)                       Realtime
  │ POST /api/p/…/hints/1/buy  │                              │                                      │
  │ Idempotency-Key: K         │                              │                                      │
  ├───────────────────────────▶│ 1 cookie → session → principal(team, member)                        │
  │                            │ 2 zod-validate path + body                                          │
  │                            │ 3 rpc('buy_hint', {team, member, hint, K})                          │
  │                            ├─────────────────────────────▶│ insert request_log(K) ─ exists? → return stored
  │                            │                              │ lock team row                        │
  │                            │                              │ gate: competition, team, expiry      │
  │                            │                              │ hint already owned? → no charge      │
  │                            │                              │ coins ≥ cost? deduct, ledger, insert │
  │                            │                              │ audit row, state_version++           │
  │                            │                              │ realtime.send(team:{id}) ───────────▶│ ping to 4 members
  │                            │◀─────────────────────────────┤ commit; JSON result                  │
  │◀───────────────────────────┤ 200 {ok, state_version, …}   │                                      │
  │ (teammates receive ping → GET /api/p/state → UI updates)                                          │
```

On a network failure the browser repeats the request with the same key and gets the stored response. If the browser never learns the result it simply re-fetches state.

## 6. Time architecture

* **Authoritative clock:** `app.now()` (database time). The browser's clock is never consulted for a decision.
* **Ultimate timer:** `teams.ends_at = started_at + teams.timer_seconds` (**B15: 14,400 s = 4 h for a team that starts now; a team that started earlier keeps its 7,200 s**; shifted by global pauses). It starts when a participant enters the competition after the rules and fullscreen acknowledgements — **not at login** — and is never touched by buy-time, submission, approval or logout. At zero the team is persisted as `ENDED` lazily (every read and refused action) and by a scheduled sweep as a safety net (`GET /api/cron/expire-teams`, Vercel Cron; no `pg_cron`). See `ECONOMY_AND_FINALIZATION.md`.
* **Question timer:** `team_questions.timer_deadline` while `ACTIVE`; `timer_remaining_seconds` while `PENDING_APPROVAL`; both `NULL` otherwise (including `AVAILABLE`). It starts when the question becomes `ACTIVE` — Q1 when a participant enters it (server-side `start_question`, no Start button), later questions on approval of the previous one — **not** when the theme is unlocked. Each `ACTIVE` question has its own deadline, so a team can have several timers running at once (one per theme at most).
* **Display:** every API response includes `server_now` (ms). The client computes `skew = server_now − (local_now at response midpoint)` and shows `deadline − (local_now + skew)`. Each re-fetch re-corrects the skew, so drift cannot accumulate. If the tab is throttled in the background, the display self-corrects on the next frame because it is computed from absolute time, not decremented.
* **Expiry** is enforced in three independent places (preamble lazy check, sweeper, and the `CHECK`-guarded state columns), so no single missed job can let a student act after time.

Full formulas and the pause algorithm are in `STATE_MACHINE.md` §1.3 and §2.

## 7. Concurrency model

* One **team row lock** serialises everything that can change a team's coins or progress. At most 4 members + 1 admin contend on a given lock, so waits are milliseconds.
* Lock order is fixed (`teams` → `team_questions` by id) so deadlocks are impossible by construction.
* The sweeper uses `FOR UPDATE SKIP LOCKED` and never blocks a student request.
* Duplicate protection is **layered**: idempotency key → status checks under lock → unique indexes. Any one layer failing is still safe.

## 8. Capacity model (target 300 concurrent, test at 350–400)

Rough steady-state request rates (300 participants + ~10 staff). These are design estimates to be **verified by load test**, not claims.

| Source | Rate |
|--------|------|
| Heartbeat (25 s) | ~12 req/s |
| Autosave (debounced 3 s, only while typing; worst case everyone typing) | 10–100 req/s |
| Realtime-triggered state re-fetch | bursty, ≤ 20 req/s |
| Fallback poll (15 s, only when the socket is down) | ≤ 20 req/s |
| Leaderboard (60 s ping, CDN-cached 15–30 s) | ~5 req/s |
| Logins at event start | ≤ 10 req/s for ~1–2 min |
| Purchases / submissions / reviews | < 5 req/s sustained |

The database work behind each request is a handful of indexed single-team operations on tables with only thousands of rows. **CPU is not the expected bottleneck; connection limits and Realtime limits are.** Verified at the time of writing from Supabase's published Realtime limits:

| Plan | Concurrent Realtime connections | Messages/s | Presence msgs/s |
|------|--------------------------------|-----------|-----------------|
| Free | **200** | 100 | 20 |
| Pro | **500** | 500 | 50 |
| Team | 10,000 | 2,500 | 1,000 |

Therefore: **the Free plan cannot meet the 300-user target.** Pro (500) is the minimum, and the load test at 400 sessions + staff leaves ~25% headroom. Staging must also be on Pro to test honestly (`RISK-01`). The architecture degrades gracefully if Realtime is unavailable: the 15 s poll keeps the product fully usable.

Database connections: the server talks to Postgres through PostgREST (`supabase-js .rpc`), which pools internally, so serverless fan-out does not exhaust Postgres connections. Compute size should be upgraded above the default for the event (to be sized by the load test). A `db` adapter interface keeps a direct-pooler alternative open if benchmarks favour it.

## 9. Failure modes (brief §47)

| Question | Answer |
|----------|--------|
| Two members do it simultaneously | Team row lock + idempotent checks; second request gets a precise error and no side effect |
| Network dies | State is whatever the server last committed; client queues the draft locally, retries with the same key |
| Browser crashes | Re-login (supersedes old session), `GET /api/p/state` restores everything, including the shared draft |
| Request sent twice | `Idempotency-Key` returns the stored response |
| Two admins act simultaneously | Team lock; second gets `SUBMISSION_NOT_PENDING` |
| Timer hits zero during a request | Preamble expires the team first; request fails `TEAM_ENDED` |
| User manipulates the browser | No client value is trusted; all inputs re-validated; IDs re-authorised against the session |
| Realtime disconnects | Presence flips offline after 75 s; UI polls every 15 s; reconnect triggers one re-fetch |
| Database request fails | API returns a retryable 503; client retries with the same key; no partial writes (transaction) |
| Venue network blocks WebSockets | Poll-only mode (everything works, ≤ 15 s latency); detected automatically |
| Vercel or Supabase outage | Timers keep running on the server clock; see runbook in `DEPLOYMENT.md` (pause + time-adjustment tools) |

## 10. Proposed project structure

Close to the brief's suggestion, with these deliberate deviations:

```
app/
  (auth)/login/                    one entry screen, three roles
  participant/                     home, theme, question, final
  admin/                           dashboard, teams, review, add team
  super-admin/
  api/                             route handlers (see API_SPEC.md)
components/ui/ competition/ participant/ admin/ shared/
lib/
  auth/            session cookie, principal resolution, throttling, password hashing
  contracts/       zod schemas + TypeScript types shared by server and client   ← added
  engine/          thin typed wrappers around rpc() calls, error-code mapping   ← replaces most of competition/ timers/
  realtime/        channel helpers, ping subscription, presence, polling fallback
  scoring/         DISPLAY-ONLY formula + parity test against SQL
  clock/           server-skew corrected countdown hook (display only)           ← renamed from timers/
  validation/
design-system/     MASTER.md + pages/*.md (after UI references arrive)
supabase/
  migrations/      numbered, forward-only
  seed/            content/ demo/ provision/
  tests/           SQL-level engine tests (pgTAP or script-driven)               ← added
scripts/           seed, provision, load-test helpers
tests/ unit/ integration/ e2e/ load/
docs/
```

**Why `lib/engine` replaces `lib/competition` + `lib/timers`:** with rules in SQL, the TypeScript layer has nothing to decide; keeping a parallel TypeScript implementation would create two sources of truth. **Why `lib/contracts`:** UI and backend are developed side by side (brief §43); a shared zod/type contract lets two people (or sessions) work on a feature without guessing request shapes.

## 11. Technology

* Next.js App Router + TypeScript (strict), Route Handlers for the API (not Server Actions — handlers give explicit control of headers, retries and status codes), Tailwind, shadcn/ui where it saves time.
* `supabase-js` (server, service role) for RPC; `@supabase/supabase-js` realtime client in the browser with a short-lived token (see `REALTIME_SPEC.md`).
* `zod` validation; `@node-rs/argon2` (or `bcryptjs` fallback) for password hashing.
* KaTeX for rendering mathematical notation in question text (`DEC-15`).
* Vitest (unit/integration), Playwright (E2E), k6 (HTTP load) plus a small Node script for Realtime load.
* Exact versions are pinned in Milestone 1 after inspecting the official repository's existing setup (`REVIEW.md` §Questions, item 1).

Not introduced: microservices, Kubernetes, Redis, a separate backend, a CMS.

## 12. Explicit non-goals (for this competition)

Equation editor; automatic answer grading; per-question chat or collaboration cursors; mobile-native apps; multi-event/multi-tenant support; runtime content editing; anti-cheat beyond the specified fullscreen rule (fullscreen is a rule mechanism, not a security boundary).

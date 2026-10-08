# API_SPEC.md — Maths Club Concetto 26

Status: **proposal for review (Milestone 0).** Contract-first: the zod schemas in `lib/contracts` are generated from this document in Milestone 1 so UI and backend work against the same shapes.

## 1. Conventions

* **Transport:** Next.js Route Handlers under `/api`, JSON over HTTPS. No Server Actions for mutations (handlers give explicit control of status codes, headers and retries).
* **Authentication:** `__Host-session` cookie (`HttpOnly; Secure; SameSite=Lax; Path=/`). The server hashes the cookie value, looks up `sessions`, and builds a **principal**: `{role, staff_id | (team_id, member_id)}`. Path parameters are never trusted: each handler re-authorises the object against the principal (a team can only touch its own `team_id`; an admin only teams where `teams.admin_id = staff_id`).
* **CSRF:** `SameSite=Lax` plus a mandatory `Origin` header check on every non-GET request.
* **Idempotency:** every `POST/PUT` that changes state **requires** `Idempotency-Key: <uuid v4>` (client generates one per user intent and reuses it on retry). Missing key → `400 VALIDATION_FAILED`.
* **Envelope**

```json
// success
{ "ok": true,  "data": { ... }, "server_now": 1760000000000, "state_version": 42 }
// failure
{ "ok": false, "error": { "code": "INSUFFICIENT_COINS", "message": "Not enough Maths Coins.", "details": { "have": 20, "need": 25 } }, "server_now": 1760000000000 }
```

* **Times** are epoch milliseconds in JSON. **Durations** are integer seconds.
* **HTTP status mapping:** 200 success / idempotent replay; 400 validation; 401 unauthenticated; 403 forbidden / wrong role / wrong team; 404 not found (also used instead of 403 when revealing existence would leak data); 409 state conflict (rules rejected the action); 423 competition paused/not open; 429 rate limited; 503 retryable infrastructure error.

## 2. Error codes

| Code | HTTP | Meaning |
|------|------|---------|
| UNAUTHENTICATED | 401 | No/invalid/revoked session |
| FORBIDDEN | 403 | Role or ownership check failed |
| VALIDATION_FAILED | 400 | Bad input, missing idempotency key |
| RATE_LIMITED | 429 | Per-account throttle |
| COMPETITION_NOT_RUNNING | 423 | Status `SETUP` or `ENDED` |
| COMPETITION_PAUSED | 423 | Global pause |
| COMPETITION_NOT_READY | 409 | `open` refused: no team yet, or the content is not exactly 10 themes × 50 questions with exactly 5 questions in every theme; `details: {teams, themes, questions, themes_not_five}` |
| INVALID_COMPETITION_TRANSITION | 409 | The action is not legal from the current status; `details: {from, action}` |
| IDEMPOTENCY_KEY_REUSED | 409 | The same `Idempotency-Key` was already used for a different operation, member or parameter |
| USERNAME_TAKEN | 409 | **B12.** An Admin with that username (case-insensitive) already exists |
| TEAM_CODE_TAKEN | 409 | **B12.** A team with that Team ID already exists |
| LOGIN_ID_TAKEN | 409 | **B12.** A team with that Login ID (case-insensitive) already exists |
| ADMISSION_NO_TAKEN | 409 | **B12.** An admission number already belongs to a team; `details: {slot}` names the member (1–4) |
| TEAM_NOT_STARTED / TEAM_ENDED | 409 | Terminal or not-yet-started team |
| ALREADY_SUBMITTED | 409 | "Team already submitted." |
| THEME_ALREADY_UNLOCKED | 409 | No charge made |
| THEME_LOCKED | 409 | Theme not unlocked |
| INSUFFICIENT_COINS | 409 | `details: {have, need}` |
| QUESTION_NOT_ACTIVE | 409 | Wrong state for the action |
| QUESTION_NOT_AVAILABLE | 409 | Entering a question that cannot be activated (locked, timed out) |
| HINT_TIER1_REQUIRED | 409 | Tier 2 hint requested before Tier 1 is owned; no charge |
| QUESTION_TIMED_OUT | 409 | Deadline passed (B13: also returned when a submit or draft loses to the deadline) |
| SUBMISSION_PENDING | 409 | One submission already awaiting review |
| STALE_PURCHASE_COUNT | 409 | Another member bought time first; refresh and retry |
| STALE_DRAFT | 409 | Teammate saved a newer draft; `details` carries it |
| TIME_PURCHASE_LIMIT | 409 | the chosen option's `max_purchases` reached |
| SUBMISSION_NOT_PENDING | 409 | Already reviewed |
| CONFIRMATION_REQUIRED | 409 | UFM second step missing/expired |
| NOT_FOUND | 404 | Unknown id or not visible to the caller |

An **idempotent replay** returns the original response (same status, same body) with header `Idempotent-Replay: true`.

**As implemented (B10):** only successful responses are stored (`request_log`, scoped to the team for participant calls and to the staff id for staff calls). A stored response is the response of the *first* call, so a replayed `POST /api/p/start` carries the original `remaining_seconds`; call `GET /api/p/state` for the current value. A rejected request stores nothing and may be retried with the same key. A key is bound to one operation, one actor and its parameters: reusing it for anything else is `409 IDEMPOTENCY_KEY_REUSED`. A request that is *naturally* idempotent (a second member entering an already-running team, or asking for the status the competition already has) succeeds with the existing state and does **not** mutate competition or team state, write an audit event or bump a `state_version`. Its successful response is nevertheless stored under its key for replay like any other success, so a later retry with the same key returns that stored response; the `request_log` row itself is bookkeeping and is not considered a competition-state mutation.

## 3. Authentication endpoints

| Method & path | Body | Result | Notes |
|---------------|------|--------|-------|
| `POST /api/auth/participant/login` | `{teamLoginId, password, admissionNo}` (strict: unknown fields → 400) | `data: {role:'PARTICIPANT', member:{id,slot}, team:{id,code,name,status}, session:{expires_at}}` + cookie | Verifies password hash **and** that `admissionNo` belongs to that team. Same generic error for any mismatch (`Invalid credentials`). Revokes the member's previous live session (`SUPERSEDED`). Does **not** start the timer. Allowed only while competition is `RUNNING` or `PAUSED` |
| `POST /api/auth/staff/login` | `{username, password}` (strict) | `data: {role:'ADMIN'\|'SUPER_ADMIN', staff:{id,name}, session:{expires_at}}` + cookie | Rejects `is_active=false` with the same generic error. Does not supersede other sessions of the same account |
| `POST /api/auth/logout` | — | `data:{}` + cookie cleared | Revokes the session (`LOGOUT`). Idempotent: always 200, also without a cookie or with a dead one |
| `GET /api/auth/me` | — | the same `data` as login (principal summary) | Used on app load and to detect revoked sessions. Resolves the session and updates `last_seen_at`. 401 (and the cookie is cleared) if missing, malformed, expired, revoked or the staff account was disabled |
| `POST /api/auth/violation/fullscreen-exit` | `{draft?:{questionId,answer,explanation,version}}` | `data:{}` | Participant only. Saves the draft if supplied, revokes the session (`FULLSCREEN_EXIT`), audits, pings `admin:{id}`. Also callable via `navigator.sendBeacon` |
| `GET /api/auth/realtime-token` | — | `data:{token, expires_at}` | Short-lived JWT for the Realtime socket (`REALTIME_SPEC` §3.1) |

All login endpoints are throttled **per account** (§8). Failed and successful logins are audited.

**Implemented in Patch B9: `participant/login`, `staff/login`, `logout`, `me`.** `fullscreen-exit` and `realtime-token` are later phases.

Details of the implemented endpoints:

* **Request rules:** every `POST` needs `Origin` equal to `APP_ORIGIN` (else `403 FORBIDDEN`), `Content-Type: application/json` and a body ≤ 2 KB. Bodies are validated with strict zod schemas: unknown or missing fields → `400 VALIDATION_FAILED` whose `details.fields` lists field *names* only (values are never echoed). `password` is 1–72 bytes (bcrypt limit), `teamLoginId` ≤ 64, `admissionNo` ≤ 32 characters.
* **Generic failure:** unknown team, wrong password, unknown admission number, an admission number of another team, unknown username, wrong staff password and an inactive staff account all return the identical `401 UNAUTHENTICATED` with message `Invalid credentials`. The specific reason is recorded only in the audit log.
* **Throttle:** `429 RATE_LIMITED` with a `Retry-After` header and `details.retry_after_seconds` (§8).
* **Competition gate:** participant login is checked only after the credentials are valid, so it cannot be used to probe accounts: `SETUP` or `ENDED` → `423 COMPETITION_NOT_RUNNING`; `RUNNING` and `PAUSED` are allowed.
* **Cookie:** `Set-Cookie: __Host-session=<token>; Max-Age=43200; Path=/; Secure; HttpOnly; SameSite=Lax`. No `Domain`. Logout and a failed `/me` send the same cookie with `Max-Age=0`. All auth responses carry `Cache-Control: no-store`.
* **Errors:** a database failure is `503 SERVICE_UNAVAILABLE` with a generic message; the session cookie is kept so a retry can succeed.
* **Never returned:** passwords, password hashes, session tokens (other than in the cookie), admission numbers.

## 4. Participant endpoints (`role = PARTICIPANT`, team taken from the session)

| Method & path | Body | Engine function | Notes |
|---------------|------|-----------------|-------|
| `GET /api/p/state` | — | `get_team_state` | The authoritative snapshot (§7; **B10 implements the subset listed there**). Cheap; this is what pings and polls call. A pure read: it never changes a timer, not even for an expired team |
| `POST /api/p/start` | — (an empty body or `{}`; anything else → 400) | `start_team_competition` | "Enter competition". Called only after the member has acknowledged the rules and completed the fullscreen acknowledgement — never by login. Idempotent: second member gets the existing times. Requires `Idempotency-Key`. B10: `data` is the §7 snapshot plus `started_now` (true only for the request that started the clock). Needs the competition to be `RUNNING`: `SETUP`/`ENDED` → `423 COMPETITION_NOT_RUNNING`, `PAUSED` → `423 COMPETITION_PAUSED`; team `FINAL_SUBMITTED` → `409 ALREADY_SUBMITTED`, `ENDED`/`DISQUALIFIED` → `409 TEAM_ENDED`. A team that is already `RUNNING` just gets its existing state, whatever the competition status |
| `GET /api/p/questions/:questionId` | — | `get_question_for_team` | **Implemented in B13** (hint texts are not part of it yet; `data: {server_now, state_version, question}`). Returns body, owned hint texts, shared draft, last rejection note. `409 THEME_LOCKED` / `QUESTION_NOT_ACTIVE` for `LOCKED` questions. For an `AVAILABLE` question returns metadata only (reward, time allowed, hint costs) and **withholds the body** until it has been activated by entering it (`DEC-26`). For `APPROVED` questions returns the body plus the **team's own** approved answer and explanation, its status and the reviewer's non-sensitive note, read-only (`DEC-10`); it **never** includes `reference_answer` or `solution_notes`, in any state |
| `POST /api/p/questions/:questionId/enter` | — | `start_question` | **Implemented in B13** (requires `Idempotency-Key`; `data: {started_now, question}`; `started_now` is true only for the request that started the timer). Called by the client when the participant **opens** the question page; there is no Start button. Activates an `AVAILABLE` question (`AVAILABLE → ACTIVE`, timer starts) and returns the authoritative `deadline` and the body. Idempotent and race-safe: if two members enter together the question is activated once and both get the same deadline; for an already-`ACTIVE`/`PENDING_APPROVAL`/`APPROVED` question it simply returns the current state. Only Q1 of an unlocked theme can be `AVAILABLE` |
| `POST /api/p/themes/:themeId/unlock` | — (empty body or `{}`) | `unlock_theme` | **Implemented in B13.** Team-wide and atomic: stored against `team_id` + `theme_id`, the cost is read from the theme (never the client) and charged once; two members unlocking together yield one unlock (`200`) and one `409 THEME_ALREADY_UNLOCKED` with no second charge. Requires `Idempotency-Key`. `data` is the §7 snapshot plus `theme_id`. `409 INSUFFICIENT_COINS {have, need}`; the theme's Q1 becomes `AVAILABLE` with no timer |
| `POST /api/p/questions/:questionId/hints/:tier/buy` | — | `buy_hint` | tier ∈ {1,2}; replay of an owned hint returns `already_owned:true`, no charge; Tier 2 before Tier 1 → `409 HINT_TIER1_REQUIRED`, no charge |
| `POST /api/p/questions/:questionId/time/buy` | `{optionId, expectedPurchaseCount}` | `buy_time` | `optionId` is one of the question's `buy_time_options`; seconds and price come from that row, never from the client |
| `PUT /api/p/questions/:questionId/draft` | `{answer, explanation, expectedVersion}` | `save_draft` | Debounced autosave. Returns new `version`. `STALE_DRAFT` returns the server copy. **B13:** compare-and-set on `expectedVersion` (0 = no draft yet), no `Idempotency-Key` (a retry with the same text is a no-op) and no audit row; only an `ACTIVE` question accepts a draft |
| `POST /api/p/questions/:questionId/submit` | `{answer, explanation}` | `submit_answer` | Server validates lengths again; answer required. **B13:** requires `Idempotency-Key`; records the submitting member; `ACTIVE → PENDING_APPROVAL` and the question timer is frozen (the team timer keeps running); one pending submission per team/question (`409 SUBMISSION_PENDING`); a submit that loses to the deadline gets `409 QUESTION_TIMED_OUT`; a retry with the same key is a replay |
| `POST /api/p/final-submit` | `{confirm:true}` | `final_submit` | `ALREADY_SUBMITTED` for the losing caller |
| `POST /api/p/heartbeat` | — | updates `sessions.last_seen_at` | Every 25 s; returns `server_now` and `state_version` (so a heartbeat doubles as a cheap "did anything change?" check) |
| `GET /api/leaderboard` | — | reads `leaderboard_snapshot` | All roles. CDN-cacheable (`s-maxage=20`). **B12 implements only the staff variant** (`get_leaderboard`): Admin and Super Admin, `data: {rows:[{rank, team_id, score}]}` over every team, not cached; a participant gets `403` until the participant variant is built. See `PROVISIONING.md` |

`submit` and `draft` bodies are limited to 20 KB in the brief; **B13 enforces 24 KB** (two 10 000-character fields in JSON can exceed 20 KB, and the database enforces the 10 000-character bound per field). The API **never** returns another team's data, other teams' answers, a locked question's body, or any `question_keys` content.

## 5. Admin endpoints (`role = ADMIN` or `SUPER_ADMIN`)

An admin is authorised for a team iff `teams.admin_id = principal.staff_id`. The Super Admin is authorised for every team (`DEC-06`).

| Method & path | Body | Engine function | Notes |
|---------------|------|-----------------|-------|
| `GET /api/admin/teams` | — | `list_admin_teams` | Assigned teams with status, score, members online, per-theme cell states, pending count (the matrix). **B12 implements the ownership foundation:** `data: {teams:[{id, team_code, name, login_id, status, member_count, created_at}]}` for the caller's own teams; ADMIN only (a Super Admin gets `403`); presence, scores and the matrix come later |
| `GET /api/admin/teams/:teamId` | — | `get_admin_team` | One team in detail: theme/question grid, history |
| `GET /api/admin/queue` | `?cursor` | `list_pending_submissions` | Oldest-first pending submissions for this admin's teams | **B13 implements a thin testing subset** (no cursor, at most 100): `data: {server_now, submissions:[{id, team_code, team_name, theme_code, ordinal, question_id, body_md, answer, explanation, submitted_by_slot, submitted_at}]}`; an Admin sees the teams they own, a Super Admin every team; no `question_keys`. Used by the temporary page `/admin/review` |
| `GET /api/admin/submissions/:id` | — | `get_submission_for_review` | Includes the question body **and** `question_keys` (reference answer, notes) — reviewers only |
| `POST /api/admin/submissions/:id/approve` | — | `approve_submission` | Reward is fixed by the question, not chosen. **Implemented in B13** as the minimal controlled review path (Admin for own teams, Super Admin for all; requires `Idempotency-Key`): pays the reward exactly once, sets `APPROVED` and activates the next question with its own deadline; `data: {submission, reward_awarded, next_question_activated}`; a second approval is `409 SUBMISSION_NOT_PENDING`. The full review queue and detail routes below are later patches (B13 adds only the thin `GET /api/admin/queue`) |
| `POST /api/admin/submissions/:id/disapprove` | `{note?}` | `disapprove_submission` | Keeps the rejected row; keeps the draft. **Implemented in B13** (the question returns to `ACTIVE` with its frozen remaining time) |
| `POST /api/admin/teams` | `{teamCode, name, loginId, password, confirmPassword, admissionNos[1..4]}` | `create_team` | Server checks password match, strength, uniqueness of `teamCode`, `loginId`, every `admissionNo`; assigns to caller; grants 500 coins as an `INITIAL_GRANT` ledger row. **Implemented in B12.** ADMIN only; `Idempotency-Key` required; exactly four admission numbers (M1–M4); strict body (no `adminId`/`coins`); `data: {team:{id, team_code, name, login_id, status, coins, member_count, created_at}}`; `Idempotent-Replay: true` on a replay; `409 TEAM_CODE_TAKEN / LOGIN_ID_TAKEN / ADMISSION_NO_TAKEN`. See `PROVISIONING.md` |
| `POST /api/admin/teams/:teamId/password` | `{newPassword}` | `reset_team_password` | Added (not in brief): needed when a team forgets credentials mid-event; audited |
| `POST /api/admin/teams/:teamId/ufm/prepare` | `{action:'RESET_SCORE'\|'DISQUALIFY'}` | creates `ufm_challenges` row | Step 1; returns `{challengeId, expires_at}` (60 s) |
| `POST /api/admin/teams/:teamId/ufm/confirm` | `{challengeId}` | `reset_score` / `disqualify_team` | Step 2. The UI also shows its own two-step dialog; this makes the server enforce it. `RESET_SCORE` makes the score 0 from now on (baseline) and the team **continues**; `DISQUALIFY` sets −1201 and **freezes** the team |

## 6. Super Admin endpoints (`role = SUPER_ADMIN`)

| Method & path | Body | Engine function | Notes |
|---------------|------|-----------------|-------|
| `POST /api/super/admins` | `{username, password, confirmPassword}` | `create_admin` | There is **no** public registration route anywhere. **Implemented in B12:** Super Admin only; `Idempotency-Key` required; role is always ADMIN and the account is active; `display_name` is set to the username (no `displayName` field); `data: {admin:{id, username, role, is_active, created_at}}`; `409 USERNAME_TAKEN` |
| `PATCH /api/super/admins/:id` | `{isActive}` | `set_admin_active` | Disabling revokes that admin's sessions and reassigns nothing automatically; the UI prompts to reassign (`DEC-24`) |
| `POST /api/super/teams/:teamId/reassign` | `{adminId}` | `reassign_team` | Audited |
| `POST /api/super/competition/status` | `{action:'open'\|'pause'\|'resume'\|'end', confirm:true}` (strict) | `set_competition_status` | **Implemented in B10.** Super Admin only (an Admin gets `403`). Requires `Idempotency-Key`. `data: {changed, action, from, to, paused_seconds?, teams_shifted?, teams_ended?, teams_total?, competition:{status, opened_at, paused_at, ended_at, state_version}}`. Legal: `open` from `SETUP`, `pause` from `RUNNING`, `resume` from `PAUSED`, `end` from `RUNNING`/`PAUSED`; asking for the status the competition already has is a no-op (`changed:false`); anything else is `409 INVALID_COMPETITION_TRANSITION`. See `STATE_MACHINE.md` §2 |
| `POST /api/super/teams/:teamId/adjust-time` | `{seconds, reason}` | `adjust_team_time` | Emergency remedy for outages (proposed, `DEC-25`); audited |
| `GET /api/super/overview` | — | aggregate | All teams, admins, queue depth, review latency |
| `GET /api/super/audit` | `?teamId&type&from&to&cursor` | read `audit_events` | Read-only |

## 7. Snapshot shape — `GET /api/p/state`

```jsonc
{
  "server_now": 1760000000000,
  "state_version": 42,
  "competition": { "status": "RUNNING" },
  "me":   { "member_id": "…", "slot": 2, "team_id": "…", "team_code": "T17", "team_name": "…" },
  "team": { "status": "RUNNING", "coins": 435, "started_at": 1759990000000, "ends_at": 1760004400000,
            "final_submitted_at": null },
  "score": { "completed_themes": 1, "solved_questions": 7, "minutes_taken": 22, "display_score": 1013 },
  "teammates": [ { "slot": 1, "online": true }, { "slot": 2, "online": true } ],
  "themes": [
    { "id": 1, "code": "A", "name": "…", "description": "…", "topics": ["…"], "difficulty": "MEDIUM",
      "unlock_cost": 25, "status": "IN_PROGRESS",           // LOCKED | IN_PROGRESS | COMPLETED | FAILED
      "questions": [                                         // [] while LOCKED: no question data leaves the server
        { "id": 3, "ordinal": 1, "state": "APPROVED" },
        { "id": 4, "ordinal": 2, "state": "ACTIVE", "deadline": 1759991800000, "reward_coins": 40,
          "time_purchase_count": 0,
          "buy_time_options": [ { "id": 10, "seconds": 120, "cost": 20, "max_purchases": null }, { "id": 11, "seconds": 240, "cost": 40, "max_purchases": null } ],
          "hints": [ { "tier": 1, "owned": true, "cost": 15 }, { "tier": 2, "owned": false, "cost": 30, "purchasable": true } ] },
        { "id": 5, "ordinal": 3, "state": "LOCKED" }
      ] }
  ]
}
```

**Implemented in B10 (`get_team_state`):** `server_now`, `state_version`, `competition.status`, `me`, `team` (`status`, `coins`, `started_at`, `ends_at`, `ended_at`, `final_submitted_at`, and the additions `duration_seconds`, `remaining_seconds`, `expired`) and `themes` as `{id, code, status, questions}` where `questions` holds only `{id, ordinal, state, deadline?}` for unlocked themes. Not yet present: `score`, `teammates`, theme names/descriptions/topics/costs, rewards, buy-time options and hints. `remaining_seconds` is `max(0, floor(ends_at − ref_time))` with `ref_time = least(now, ended_at, paused_at while PAUSED)`, computed by the database; a team that has not started reports the full `duration_seconds` (7200) and `null` timestamps. `state_version` increases whenever anything in the snapshot changes, including the competition status. The server never accepts a time, a balance or a remaining value from a client.

**Extended in B13 (`app.team_state_json`):** each theme also carries `name`, `description`, `topics`, `difficulty` and `unlock_cost` (a locked theme still has `questions: []`), and each question of an unlocked theme carries `reward_coins`, `time_limit_seconds` and, while `ACTIVE`, `deadline` and `remaining_seconds` (a `PENDING_APPROVAL` question reports its frozen `remaining_seconds` and no deadline). Question bodies are never part of the snapshot. Clients refresh this snapshot by polling (about every 5 s); realtime push is specified in `REALTIME_SPEC.md` but not shipped in B13.

Question `state` is one of `LOCKED | AVAILABLE | ACTIVE | PENDING_APPROVAL | APPROVED | TIMED_OUT`. An `AVAILABLE` question carries `{ "state": "AVAILABLE", "time_limit_seconds": 600, "reward_coins": 40 }` and no `deadline`. Several questions, in different themes, may be `ACTIVE` at once; each carries its own `deadline`. A hint is `purchasable` only if the question state allows it, the hint is not owned, and (for Tier 2) Tier 1 is owned. After a UFM Reset the snapshot shows `team.status = "RUNNING"` and `score.display_score` reads 0 at that instant, then moves normally as the team earns points (the server applies `score_reset_baseline`; the client never does).

`display_score` is computed by the server (the same SQL function as the official score). It is **display only**: finalisation recomputes it in the database and the client value is never accepted as input anywhere.

## 8. Rate limiting and abuse controls

| Control | Value (tunable) |
|---------|-----------------|
| Login attempts | 8 failures per account per 10 min, then a lock of 30 s, doubling per further failure up to 5 min (`auth_throttle`; B9). A locked attempt is refused without checking the password and does not extend the lock; a successful login clears the counter. Unknown accounts are throttled identically. The admin/Super Admin "clear" action is not built yet. Keyed per `team:<loginId>` / `staff:<username>` — **never by IP alone**, because a campus NAT would lock out the whole venue |
| Soft per-IP login ceiling | 600 / 10 min (only to stop scripted floods from one machine). **Not implemented in B9**: the client IP is recorded in audit rows only |
| Authenticated mutation | 30 / min per principal (autosave and heartbeat exempt, with their own caps: draft 1 per 1.5 s, heartbeat 1 per 10 s) |
| Request body | 20 KB max on answer/draft; 2 KB elsewhere |
| Passwords | min 10 chars for staff; admin-created team passwords min 8 and not equal to team ID/login ID |

## 9. TypeScript surface (`lib/engine`)

One typed function per engine operation, named as in the brief: `startCompetition`, `unlockTheme`, `startQuestion`, `buyHint`, `buyTime`, `submitAnswer`, `approveSubmission`, `disapproveSubmission`, `finalSubmit`, `resetScore`, `disqualifyTeam`, plus `saveDraft` and `setCompetitionStatus`. Each takes `(principal, input, idempotencyKey)`, calls the matching SQL function, and maps SQL exceptions (`raise exception using errcode = 'P0001', message = 'INSUFFICIENT_COINS'`, …) to the error codes in §2. No game rule is implemented in TypeScript.

## 10. Versioning and compatibility

The API is internal and deployed atomically with the UI, so no URL versioning. Response additions are backward compatible; renames require a contract-schema change reviewed in a patch of their own (brief §41: "never hide architectural changes in a huge patch").

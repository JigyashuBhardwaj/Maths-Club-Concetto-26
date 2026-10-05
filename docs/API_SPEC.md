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
| TEAM_NOT_STARTED / TEAM_ENDED | 409 | Terminal or not-yet-started team |
| ALREADY_SUBMITTED | 409 | "Team already submitted." |
| THEME_ALREADY_UNLOCKED | 409 | No charge made |
| THEME_LOCKED | 409 | Theme not unlocked |
| INSUFFICIENT_COINS | 409 | `details: {have, need}` |
| QUESTION_NOT_ACTIVE | 409 | Wrong state for the action |
| QUESTION_NOT_AVAILABLE | 409 | Entering a question that cannot be activated (locked, timed out) |
| HINT_TIER1_REQUIRED | 409 | Tier 2 hint requested before Tier 1 is owned; no charge |
| QUESTION_TIMED_OUT | 409 | Deadline passed |
| SUBMISSION_PENDING | 409 | One submission already awaiting review |
| STALE_PURCHASE_COUNT | 409 | Another member bought time first; refresh and retry |
| STALE_DRAFT | 409 | Teammate saved a newer draft; `details` carries it |
| TIME_PURCHASE_LIMIT | 409 | `max_time_purchases` reached |
| SUBMISSION_NOT_PENDING | 409 | Already reviewed |
| CONFIRMATION_REQUIRED | 409 | UFM second step missing/expired |
| NOT_FOUND | 404 | Unknown id or not visible to the caller |

An **idempotent replay** returns the original response (same status, same body) with header `Idempotent-Replay: true`.

## 3. Authentication endpoints

| Method & path | Body | Result | Notes |
|---------------|------|--------|-------|
| `POST /api/auth/participant/login` | `{teamLoginId, password, admissionNo}` | `data: {role:'PARTICIPANT', member:{id,slot}, team:{id,code,name,status}}` + cookie | Verifies password hash **and** that `admissionNo` belongs to that team. Same generic error for any mismatch (`Invalid credentials`). Revokes the member's previous live session (`SUPERSEDED`). Does **not** start the timer. Allowed only while competition is `RUNNING` or `PAUSED` |
| `POST /api/auth/staff/login` | `{username, password}` | `data: {role:'ADMIN'\|'SUPER_ADMIN', staff:{id,name}}` + cookie | Rejects `is_active=false` |
| `POST /api/auth/logout` | — | `data:{}` | Revokes session (`LOGOUT`) |
| `GET /api/auth/me` | — | principal summary | Used on app load and to detect revoked sessions |
| `POST /api/auth/violation/fullscreen-exit` | `{draft?:{questionId,answer,explanation,version}}` | `data:{}` | Participant only. Saves the draft if supplied, revokes the session (`FULLSCREEN_EXIT`), audits, pings `admin:{id}`. Also callable via `navigator.sendBeacon` |
| `GET /api/auth/realtime-token` | — | `data:{token, expires_at}` | Short-lived JWT for the Realtime socket (`REALTIME_SPEC` §3.1) |

All login endpoints are throttled **per account** (§8). Failed and successful logins are audited.

## 4. Participant endpoints (`role = PARTICIPANT`, team taken from the session)

| Method & path | Body | Engine function | Notes |
|---------------|------|-----------------|-------|
| `GET /api/p/state` | — | `get_team_state` | The authoritative snapshot (§7). Cheap; this is what pings and polls call |
| `POST /api/p/start` | — | `start_team_competition` | "Enter competition". Called only after the member has acknowledged the rules and completed the fullscreen acknowledgement — never by login. Idempotent: second member gets the existing times |
| `GET /api/p/questions/:questionId` | — | `get_question_for_team` | Returns body, owned hint texts, shared draft, last rejection note. `409 THEME_LOCKED` / `QUESTION_NOT_ACTIVE` for `LOCKED` questions. For an `AVAILABLE` question returns metadata only (reward, time allowed, hint costs) and **withholds the body** until it has been activated by entering it (`DEC-26`). For `APPROVED` questions returns the body plus the **team's own** approved answer and explanation, its status and the reviewer's non-sensitive note, read-only (`DEC-10`); it **never** includes `reference_answer` or `solution_notes`, in any state |
| `POST /api/p/questions/:questionId/enter` | — | `start_question` | Called by the client when the participant **opens** the question page; there is no Start button. Activates an `AVAILABLE` question (`AVAILABLE → ACTIVE`, timer starts) and returns the authoritative `deadline` and the body. Idempotent and race-safe: if two members enter together the question is activated once and both get the same deadline; for an already-`ACTIVE`/`PENDING_APPROVAL`/`APPROVED` question it simply returns the current state. Only Q1 of an unlocked theme can be `AVAILABLE` |
| `POST /api/p/themes/:themeId/unlock` | — | `unlock_theme` | |
| `POST /api/p/questions/:questionId/hints/:tier/buy` | — | `buy_hint` | tier ∈ {1,2}; replay of an owned hint returns `already_owned:true`, no charge; Tier 2 before Tier 1 → `409 HINT_TIER1_REQUIRED`, no charge |
| `POST /api/p/questions/:questionId/time/buy` | `{expectedPurchaseCount}` | `buy_time` | |
| `PUT /api/p/questions/:questionId/draft` | `{answer, explanation, expectedVersion}` | `save_draft` | Debounced autosave. Returns new `version`. `STALE_DRAFT` returns the server copy |
| `POST /api/p/questions/:questionId/submit` | `{answer, explanation}` | `submit_answer` | Server validates lengths again; answer required |
| `POST /api/p/final-submit` | `{confirm:true}` | `final_submit` | `ALREADY_SUBMITTED` for the losing caller |
| `POST /api/p/heartbeat` | — | updates `sessions.last_seen_at` | Every 25 s; returns `server_now` and `state_version` (so a heartbeat doubles as a cheap "did anything change?" check) |
| `GET /api/leaderboard` | — | reads `leaderboard_snapshot` | All roles. CDN-cacheable (`s-maxage=20`) |

`submit` and `draft` bodies are limited to 20 KB. The API **never** returns another team's data, other teams' answers, a locked question's body, or any `question_keys` content.

## 5. Admin endpoints (`role = ADMIN` or `SUPER_ADMIN`)

An admin is authorised for a team iff `teams.admin_id = principal.staff_id`. The Super Admin is authorised for every team (`DEC-06`).

| Method & path | Body | Engine function | Notes |
|---------------|------|-----------------|-------|
| `GET /api/admin/teams` | — | `list_admin_teams` | Assigned teams with status, score, members online, per-theme cell states, pending count (the matrix) |
| `GET /api/admin/teams/:teamId` | — | `get_admin_team` | One team in detail: theme/question grid, history |
| `GET /api/admin/queue` | `?cursor` | `list_pending_submissions` | Oldest-first pending submissions for this admin's teams |
| `GET /api/admin/submissions/:id` | — | `get_submission_for_review` | Includes the question body **and** `question_keys` (reference answer, notes) — reviewers only |
| `POST /api/admin/submissions/:id/approve` | — | `approve_submission` | Reward is fixed by the question, not chosen |
| `POST /api/admin/submissions/:id/disapprove` | `{note?}` | `disapprove_submission` | Keeps the rejected row; clears the draft |
| `POST /api/admin/teams` | `{teamCode, name, loginId, password, confirmPassword, admissionNos[1..4]}` | `create_team` | Server checks password match, strength, uniqueness of `teamCode`, `loginId`, every `admissionNo`; assigns to caller; grants 500 coins as an `INITIAL_GRANT` ledger row |
| `POST /api/admin/teams/:teamId/password` | `{newPassword}` | `reset_team_password` | Added (not in brief): needed when a team forgets credentials mid-event; audited |
| `POST /api/admin/teams/:teamId/ufm/prepare` | `{action:'RESET_SCORE'\|'DISQUALIFY'}` | creates `ufm_challenges` row | Step 1; returns `{challengeId, expires_at}` (60 s) |
| `POST /api/admin/teams/:teamId/ufm/confirm` | `{challengeId}` | `reset_score` / `disqualify_team` | Step 2. The UI also shows its own two-step dialog; this makes the server enforce it. `RESET_SCORE` makes the score 0 from now on (baseline) and the team **continues**; `DISQUALIFY` sets −1201 and **freezes** the team |

## 6. Super Admin endpoints (`role = SUPER_ADMIN`)

| Method & path | Body | Engine function | Notes |
|---------------|------|-----------------|-------|
| `POST /api/super/admins` | `{username, displayName, password}` | `create_admin` | There is **no** public registration route anywhere |
| `PATCH /api/super/admins/:id` | `{isActive}` | `set_admin_active` | Disabling revokes that admin's sessions and reassigns nothing automatically; the UI prompts to reassign (`DEC-24`) |
| `POST /api/super/teams/:teamId/reassign` | `{adminId}` | `reassign_team` | Audited |
| `POST /api/super/competition/status` | `{action:'open'\|'pause'\|'resume'\|'end', confirm:true}` | `set_competition_status` | |
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
          "time_purchase_count": 0, "buy_time_cost": 10, "buy_time_seconds": 120, "max_time_purchases": null,
          "hints": [ { "tier": 1, "owned": true, "cost": 15 }, { "tier": 2, "owned": false, "cost": 30, "purchasable": true } ] },
        { "id": 5, "ordinal": 3, "state": "LOCKED" }
      ] }
  ]
}
```

Question `state` is one of `LOCKED | AVAILABLE | ACTIVE | PENDING_APPROVAL | APPROVED | TIMED_OUT`. An `AVAILABLE` question carries `{ "state": "AVAILABLE", "time_limit_seconds": 600, "reward_coins": 40 }` and no `deadline`. Several questions, in different themes, may be `ACTIVE` at once; each carries its own `deadline`. A hint is `purchasable` only if the question state allows it, the hint is not owned, and (for Tier 2) Tier 1 is owned. After a UFM Reset the snapshot shows `team.status = "RUNNING"` and `score.display_score` reads 0 at that instant, then moves normally as the team earns points (the server applies `score_reset_baseline`; the client never does).

`display_score` is computed by the server (the same SQL function as the official score). It is **display only**: finalisation recomputes it in the database and the client value is never accepted as input anywhere.

## 8. Rate limiting and abuse controls

| Control | Value (tunable) |
|---------|-----------------|
| Login attempts | 8 per account per 10 min, then exponential delay (30 s → 5 min); admin/Super Admin can clear. Keyed per `team:<loginId>` / `staff:<username>` — **never by IP alone**, because a campus NAT would lock out the whole venue |
| Soft per-IP login ceiling | 600 / 10 min (only to stop scripted floods from one machine) |
| Authenticated mutation | 30 / min per principal (autosave and heartbeat exempt, with their own caps: draft 1 per 1.5 s, heartbeat 1 per 10 s) |
| Request body | 20 KB max on answer/draft; 2 KB elsewhere |
| Passwords | min 10 chars for staff; admin-created team passwords min 8 and not equal to team ID/login ID |

## 9. TypeScript surface (`lib/engine`)

One typed function per engine operation, named as in the brief: `startCompetition`, `unlockTheme`, `startQuestion`, `buyHint`, `buyTime`, `submitAnswer`, `approveSubmission`, `disapproveSubmission`, `finalSubmit`, `resetScore`, `disqualifyTeam`, plus `saveDraft` and `setCompetitionStatus`. Each takes `(principal, input, idempotencyKey)`, calls the matching SQL function, and maps SQL exceptions (`raise exception using errcode = 'P0001', message = 'INSUFFICIENT_COINS'`, …) to the error codes in §2. No game rule is implemented in TypeScript.

## 10. Versioning and compatibility

The API is internal and deployed atomically with the UI, so no URL versioning. Response additions are backward compatible; renames require a contract-schema change reviewed in a patch of their own (brief §41: "never hide architectural changes in a huge patch").

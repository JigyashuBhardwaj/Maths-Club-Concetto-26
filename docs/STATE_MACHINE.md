# STATE_MACHINE.md — Maths Club Concetto 26

Every transition below is implemented **once**, inside a Postgres function (`SECURITY DEFINER`), and nowhere else. The frontend renders state; it never decides state. Table and column names refer to `DATA_MODEL.md`.

---

## 1. Global rules for every state-changing operation

### 1.1 The common preamble (`lock_team_for_action`)

Every operation that touches a team runs these steps first, in this order:

1. **Idempotency**: insert `(principal_id, idem_key)` into `request_log`. If it already exists, return the stored response and stop.
2. **Lock**: `SELECT … FROM teams WHERE id = $team FOR UPDATE`. All writers for one team are serialised by this lock (at most 4 members plus 1 admin, so contention is trivial).
3. **Competition gate**: read `competition.status`. Participant operations require `RUNNING`; otherwise return `COMPETITION_NOT_RUNNING` or `COMPETITION_PAUSED`.
4. **Team gate**: the team must be `RUNNING` (except `start_team_competition`, which requires `NOT_STARTED`).
5. **Lazy expiry**: if `app.now() >= teams.ends_at`, run `expire_team()` (§5.4) in the same transaction and return `TEAM_ENDED`.
6. **Question expiry**: for this team's `ACTIVE` rows with `timer_deadline <= app.now()`, set `state='TIMED_OUT'`, `timed_out_at = timer_deadline`, `timer_deadline = NULL`.
7. Only then run the operation's own checks.

**Lock order** is always `competition` (read, no lock) → `teams` row → `team_questions` rows (by `question_id` ascending) → insert rows. Admin operations find the team through the submission, lock the **team first**, then re-read the submission. Because every path locks the team first, deadlocks cannot occur.

### 1.2 The common epilogue

Before commit: increment `teams.state_version`, write the `audit_events` row(s), and emit the realtime ping with `realtime.send()` (so the event exists only if the transaction commits — see `REALTIME_SPEC.md` §2).

### 1.3 Time references

```
team_ref_time(team) =
    least( app.now(),
           coalesce(team.ended_at, 'infinity'),
           case when competition.status = 'PAUSED' then competition.paused_at end )

team_remaining   = greatest(0, team.ends_at - team_ref_time)
question_remaining(q) =
    ACTIVE            -> greatest(0, q.timer_deadline - team_ref_time)
    PENDING_APPROVAL  -> q.timer_remaining_seconds
    other             -> 0     (LOCKED / AVAILABLE have no running timer; the UI shows
                                    questions.time_limit_seconds as the time allowed once started)
```

Two consequences: while the competition is `PAUSED` every clock reads the instant it paused, and once a team is terminal every clock reads `ended_at`. No background job has to "stop" anything.

---

## 2. Competition (global)

```
        open                pause               resume
 SETUP ───────▶ RUNNING ───────────▶ PAUSED ───────────▶ RUNNING
                  │                                         │
                  └──────────────── end ────────────────────┴──────▶ ENDED
```

| From | Event (Super Admin only) | Guard | Effects |
|------|--------------------------|-------|---------|
| SETUP | `open` | at least 1 team, 12 themes × 5 questions present | `status='RUNNING'`, `opened_at=now`; audit; ping `global` |
| RUNNING | `pause` | — | `status='PAUSED'`, `paused_at=now`; audit; ping |
| PAUSED | `resume` | — | `delta = now - paused_at`; for every `RUNNING` team `ends_at += delta`; for every `ACTIVE` question `timer_deadline += delta`; `status='RUNNING'`, `paused_at=NULL`; audit with `delta`; ping |
| RUNNING/PAUSED | `end` | confirmation | `status='ENDED'`; every `RUNNING` team is ended via `expire_team(reason='COMPETITION_ENDED')`; audit; ping |

While `PAUSED`: all participant mutations return `COMPETITION_PAUSED`; admin review is blocked too (brief §27); staff reads still work; the sweeper does nothing.

`SETUP` is the pre-event state: staff can log in and create teams, participants cannot enter (`DEC-02`).

---

## 3. Team

```
 NOT_STARTED ──start_team_competition──▶ RUNNING ──final_submit──────▶ FINAL_SUBMITTED
                                            │  ▲
                                            │  └── UFM Reset score (score becomes 0, status unchanged, team continues)
                                            │
                                            ├──timer reaches 0 / competition end──▶ ENDED
                                            │
                                            └──UFM Disqualify (score = −1201)─────▶ DISQUALIFIED
```

| From | Event | Actor | Guard | Effects |
|------|-------|-------|-------|---------|
| NOT_STARTED | `start_team_competition` | the first member to **enter the competition interface**: the client calls it only after the member has acknowledged the rules and completed the fullscreen acknowledgement. Login never calls it | competition `RUNNING` | `status='RUNNING'`, `started_at=now`, `ends_at=now+14400s`; coins already 500 from creation; audit `TEAM_STARTED`. Exactly-once: guarded by the status check under the team lock, so two members entering together start the clock once; later members, re-logins and re-entering fullscreen never restart it. |
| RUNNING | `final_submit` | any member | none pending-blocking (see `DEC-03`) | §5.8 |
| RUNNING | auto-end | system (lazy or sweeper) | `now >= ends_at` | §5.4 |
| RUNNING | `disqualify_team` | assigned admin / super admin | two-step confirmation | `status='DISQUALIFIED'`, `ended_at=now`, `score_override=-1201`. The team is frozen and every later mutation is rejected. |
| RUNNING | `reset_score` | assigned admin / super admin | two-step confirmation | `score_reset_at=now`, `score_reset_baseline = raw score now`, so the official score becomes 0 and later points count from 0. **`status` stays `RUNNING`: the team continues** (timers, coins, questions, submissions and reviews are untouched). A repeat Reset re-zeroes from the then-current raw score. See `DEC-04` |
| any terminal | anything else | — | — | rejected with `ALREADY_SUBMITTED` / `TEAM_ENDED` |

Terminal states are final. There is no transition out of them (brief §17: "final submission must not be reversible"). A Super Admin "revert UFM" tool (clearing a Reset baseline, un-disqualifying a team) is proposed as an emergency remedy in `DEC-04` and is **not** part of the default scope.

---

## 4. Question (per team)

```
   unlock theme (Q1 only)        participant enters Q1 → start_question
 LOCKED ───────────────▶ AVAILABLE ───────────────▶ ACTIVE ◀──── approve Q(n-1)  (Qn: LOCKED ──▶ ACTIVE directly)
                        (no timer)                    │  ▲
                                           submit     │  │  disapprove
                                                      ▼  │  (timer resumes)
                                           PENDING_APPROVAL
                                                      │
                                            approve   ▼
                                                  APPROVED

          ACTIVE ──deadline reached──▶ TIMED_OUT   (terminal; later questions of the theme stay LOCKED forever)
```

**A question timer exists only while the question is `ACTIVE`** (running) or `PENDING_APPROVAL` (frozen). `LOCKED` and `AVAILABLE` have no timer: unlocking a theme never starts one. Within a theme the questions are strictly sequential, so at most one question per theme is `ACTIVE`; across themes any number can be `ACTIVE` at the same time, each with its own independent `timer_deadline`. Nothing one question's timer does (submit, approve, disapprove, timeout, buy time) changes another question's timer; only the global pause shifts all of them equally.

| From | Event | Guard | Effects |
|------|-------|-------|---------|
| LOCKED (Q1) | theme unlocked | enough coins, theme not yet unlocked | `AVAILABLE`; no timer, `timer_deadline` stays `NULL` |
| AVAILABLE (Q1) | `start_question`, triggered when a participant enters/opens Q1 (no Start button) | team `RUNNING` | `ACTIVE`, `activated_at=now`, `timer_deadline = now + time_limit_seconds` |
| LOCKED (Qn, n ≥ 2) | Q(n-1) approved | team `RUNNING` | `ACTIVE`, `activated_at=now`, `timer_deadline = now + time_limit_seconds` (the timer starts at approval) |
| ACTIVE | `submit_answer` | no pending submission, answer non-empty, `now < timer_deadline` | insert submission `PENDING`; `timer_remaining_seconds = timer_deadline - now`; `timer_deadline = NULL`; `state='PENDING_APPROVAL'` |
| PENDING_APPROVAL | `approve_submission` | submission still `PENDING` | `state='APPROVED'`, `approved_at=now`, `timer_remaining_seconds=NULL`; reward ledger row; activate next question (or complete theme) |
| PENDING_APPROVAL | `disapprove_submission` | submission still `PENDING` | `state='ACTIVE'`, `timer_deadline = now + timer_remaining_seconds`, `timer_remaining_seconds=NULL`; submission → `REJECTED` (row kept); draft cleared |
| ACTIVE | deadline reached | `timer_deadline <= now` | `state='TIMED_OUT'`, `timed_out_at = timer_deadline`, `timer_deadline=NULL` |
| ACTIVE | `buy_time` | `now < timer_deadline`, purchases left, coins | `timer_deadline += buy_time_seconds` |
| ACTIVE | `buy_hint` | coins, hint not already owned, Tier 1 owned if buying Tier 2 | no state change |

A question that is `PENDING_APPROVAL` cannot time out (its clock is frozen). A `TIMED_OUT` question is permanent: no buy-time, no resubmission (brief §12), and the theme can never be completed (`team_theme_progress.has_timed_out`).

**Theme status shown to students** is derived, not stored: `LOCKED` (no `team_themes` row) → `IN_PROGRESS` (includes a theme whose Q1 is still `AVAILABLE`) → `COMPLETED` (5 approved) or `FAILED` (any timed out) → all greyed once the team is terminal. A question still `AVAILABLE` when the team ends is never started and never times out; its theme simply stays incomplete.

---

## 5. Operations (the brief's eleven atomic functions plus `start_question`)

Names follow the brief; the SQL function name is in parentheses. All start with §1.1 and end with §1.2.

### 5.1 `startCompetition` (`start_team_competition`)
This is the *Enter competition* action. The participant UI calls it only at the end of the entry flow (rules acknowledged → fullscreen acknowledged); the server cannot verify those client steps, so it relies on this being the only call that starts the clock and on login never making it.
1. Lock team. Team must be `NOT_STARTED`; if already `RUNNING` return success with the existing times (idempotent).
2. Set `status='RUNNING'`, `started_at = app.now()`, `ends_at = started_at + ultimate_seconds`.
3. Audit `TEAM_STARTED`. Ping `team:{id}`.

### 5.2 `unlockTheme` (`unlock_theme`)
1. Preamble. Verify the theme exists and has no `team_themes` row (else `THEME_ALREADY_UNLOCKED`, and **no charge**).
2. `teams.coins >= unlock_cost` else `INSUFFICIENT_COINS`.
3. `coins -= cost`; insert `coin_transactions(THEME_UNLOCK, -cost, balance_after, theme_id, member_id)`.
4. Insert `team_themes`; insert 5 `team_questions` rows; Q1 → `AVAILABLE` (**no timer starts**); Q2…Q5 stay `LOCKED`.
5. Audit `THEME_UNLOCKED`. The unique index `ctx_theme` is the final guard if anything above is ever bypassed.

### 5.2a `startQuestion` (`start_question`)
Not on the brief's list; added by the locked rule that a question timer starts when the question becomes `ACTIVE`, not when its theme is unlocked. It is a **server-side, atomic and idempotent operation triggered by entering the question** — the participant UI has no separate Start button. The client calls it when the question page opens (`POST /api/p/questions/:id/enter`); browsing the list of questions does not call it.
1. Preamble. The question must belong to an unlocked theme of this team.
2. If the question is already `ACTIVE`, `PENDING_APPROVAL` or `APPROVED` return success with its current state and deadline (idempotent: a second member entering never restarts or extends the timer, and two members entering together activate it exactly once and receive the same authoritative deadline).
3. The question must be `AVAILABLE` (else `QUESTION_NOT_AVAILABLE`; `LOCKED` and `TIMED_OUT` are rejected).
4. `state='ACTIVE'`, `activated_at=now`, `timer_deadline = now + time_limit_seconds`. It does not touch any other question's timer or the team's `ends_at`.
5. Audit `QUESTION_STARTED`; ping `team:{id}`.
6. The response carries the deadline and the question body. While the question is `AVAILABLE` the body is never returned.

### 5.3 `buyHint` (`buy_hint`)
1. Preamble. The question's theme must be unlocked; the question must be `ACTIVE` or `PENDING_APPROVAL` or `APPROVED` (hints are not purchasable for `LOCKED`, `AVAILABLE` or `TIMED_OUT`).
2. If a `hint_purchases` row exists → return it with `already_owned=true`, **charge nothing** (never pays twice).
3. **Tier order:** buying Tier 2 requires this team to already own Tier 1 of the same question, else `HINT_TIER1_REQUIRED` (no charge). Checked under the team lock; the `hint_purchases` trigger is the second guard.
4. Check coins; deduct; ledger `HINT_PURCHASE`; insert `hint_purchases`.
5. Audit `HINT_PURCHASED`.

### 5.4 Auto-end (`expire_team`) — called lazily from the preamble and by the sweeper
1. Idempotent: if the team is already terminal, return.
2. For `ACTIVE` questions with `timer_deadline <= ends_at`, mark `TIMED_OUT`.
3. `status='ENDED'`, `ended_at = ends_at` (the *scheduled* end, not the time the sweeper ran).
4. Cache `final_*` via `compute_team_score`. Member sessions are **not** revoked: students stay logged in to see their result and log out themselves (brief §18).
5. Audit `TEAM_ENDED(reason=TIMER)`; ping `team:{id}` and `admin:{admin_id}`.

The sweeper (`pg_cron`, every 30 s) runs `expire_due_teams()` which calls `expire_team` for every `RUNNING` team with `ends_at <= now`, using `FOR UPDATE SKIP LOCKED` so it never queues behind live traffic.

### 5.5 `buyTime` (`buy_time`)
Request carries `expected_purchase_count` (the `time_purchase_count` the client saw).
1. Preamble. Question must be `ACTIVE` and `now < timer_deadline` (else `QUESTION_TIMED_OUT` / `QUESTION_NOT_ACTIVE`). Not allowed while `PENDING_APPROVAL` (`DEC-08`).
2. `time_purchase_count == expected_purchase_count` else `STALE_PURCHASE_COUNT` (two members clicking at once cannot silently buy twice).
3. `max_time_purchases` not exceeded. Coins sufficient.
4. `coins -= cost`; ledger `TIME_PURCHASE` with `purchase_seq = count+1`; `timer_deadline += buy_time_seconds`; `extra_seconds += …`; `time_purchase_count += 1`.
5. **The team's `ends_at` is never touched.** Audit `TIME_PURCHASED`.

### 5.6 `submitAnswer` (`submit_answer`)
1. Preamble. Question `ACTIVE` and `now < timer_deadline`. A `PENDING` submission existing → `SUBMISSION_PENDING`.
2. Validate lengths (answer 1–10,000, explanation ≤ 10,000).
3. Insert `submissions(PENDING, member_id, submitted_at=now)`; the partial unique index `submissions_one_pending` makes a duplicate impossible even under a race.
4. Freeze the question timer: `timer_remaining_seconds = timer_deadline - now`, `state='PENDING_APPROVAL'`.
5. Audit `ANSWER_SUBMITTED`. Ping `team:{id}` and `admin:{admin_id}`.

The draft is **not** deleted on submit (it is the submitted text); it is cleared only on disapproval.

### 5.7 `approveSubmission` / `disapproveSubmission`
Common: caller is the assigned admin or the Super Admin (`DEC-06`). Find the team via the submission, **lock the team first**, then re-read the submission; if it is not `PENDING` return `SUBMISSION_NOT_PENDING` (covers two admins clicking at once). Competition must be `RUNNING`. Team may be in a terminal state only for a permitted late review (`DEC-03`).

**Approve**
1. `submissions.status='APPROVED'`, `reviewed_by`, `reviewed_at`, `reward_awarded = questions.reward_coins` (fixed — the admin cannot choose it).
2. `coins += reward`; ledger `QUESTION_REWARD` (unique per team+question).
3. Question → `APPROVED`. If `ordinal < 5` and the team is `RUNNING`: next question → `ACTIVE`, deadline `= now + its time_limit_seconds` (its timer starts now, and only its own timer). If `ordinal = 5`: theme complete (derived).
4. Audit `SUBMISSION_APPROVED`; ping team and admin queue.

**Disapprove**
1. `submissions.status='REJECTED'` (+ optional `review_note`).
2. Question → `ACTIVE`, `timer_deadline = now + timer_remaining_seconds`. If the team is already terminal, the question simply returns to `ACTIVE` but frozen by `ended_at`.
3. Delete the team's `answer_drafts` row for the question.
4. Audit `SUBMISSION_REJECTED`; ping.

### 5.8 `finalSubmit` (`final_submit`)
1. Preamble. If the team is already `FINAL_SUBMITTED` → return the stored result with code `ALREADY_SUBMITTED` ("Team already submitted."); concurrent callers serialise on the team lock, so exactly one wins and the rest receive that code.
2. `status='FINAL_SUBMITTED'`, `ended_at = now`, `final_submitted_at`, `final_submitted_by`.
3. Cache `final_*` from `compute_team_score` (frozen clock).
4. Pending submissions: handled per `DEC-03` (default: stay reviewable; reward and score update on review).
5. Audit `TEAM_FINAL_SUBMITTED`; ping team, admin and `global`.

### 5.9 `resetScore` / `disqualifyTeam` (UFM)
1. Two server-side steps: `prepare` creates a `ufm_challenges` row (60 s expiry, bound to staff+team+action); `confirm` consumes it (`used_at`). A direct call without a fresh challenge fails.
2. Caller is the assigned admin or the Super Admin.
3. Lock team, then by action:
   * **Reset score** — set `score_reset_at = now` and `score_reset_baseline = raw_score(team)` evaluated at `team_ref_time`. The official score is `raw − baseline`, so it reads 0 now and **points earned afterwards count normally** (850 → Reset → 0 → earn 100 → 100; see `DATA_MODEL.md` §4). **Nothing else changes**: `status` stays `RUNNING`, `ended_at` stays `NULL`, timers keep running, coins and question states are untouched, and the team can still unlock, buy, submit and be reviewed. A second Reset re-zeroes from the then-current raw score.
   * **Disqualify** — set `score_override = -1201`, `status='DISQUALIFIED'`, `ended_at=now` if not terminal. The team is frozen: every later mutation is rejected by the terminal-state guard. Any Reset baseline is kept for history; the override wins.
4. Audit `UFM_SCORE_RESET` (payload: previous official score, raw score, new baseline) / `UFM_DISQUALIFIED` (payload: previous official score). Member sessions are **not** revoked in either case; a disqualified team stays logged in to see the outcome.

### 5.10 `saveDraft` (`save_draft`) — not on the brief's list but required by §26
Upsert `answer_drafts` guarded by `expected_version`: if `version != expected_version` return `STALE_DRAFT` with the server copy (the client shows "a teammate edited this"). Allowed only while the question is `ACTIVE`. Does not require the full preamble lock — it locks only the draft row — so autosave traffic never queues behind purchases.

### 5.11 `setCompetitionStatus` (`set_competition_status`)
Implements §2. Locks the `competition` row, then iterates teams in `id` order.

---

## 6. Member and session

```
          login (password + admission_no)               heartbeat stops > 75 s
 (none) ───────────────────────────────▶ ONLINE ───────────────────────────────▶ OFFLINE
                                          │  ▲                                       │
                  fullscreen exit /       │  │ login again                           │ login
                  logout / superseded     ▼  │                                       ▼
                                      SESSION REVOKED ───────────────────────▶  ONLINE
```

| Event | Effects |
|-------|---------|
| Login | verify password hash and that `admission_no` belongs to that team; revoke any live session of that member with reason `SUPERSEDED`; create new session; audit `MEMBER_LOGIN`. Does **not** start the team timer. |
| Heartbeat (25 s) | `sessions.last_seen_at = now` |
| Fullscreen exit | client flushes the draft, then calls `POST /api/auth/violation/fullscreen-exit`; server revokes the session (`FULLSCREEN_EXIT`), audits `FULLSCREEN_EXIT`, pings `admin:{id}`. Team progress is untouched. |
| Disconnect | no event; `member_presence` flips to offline after 75 s without a heartbeat |
| Logout | revoke (`LOGOUT`), audit |

Presence never influences competition state (brief §24).

---

## 7. Race and edge-case table

| Situation | Outcome |
|-----------|---------|
| Two members unlock the same theme simultaneously | Second waits on the team lock, sees the row, gets `THEME_ALREADY_UNLOCKED`, no charge |
| Two members enter the same `AVAILABLE` question together | The first activates it; the second sees it already `ACTIVE`; both receive the same authoritative deadline and the timer starts exactly once |
| Two members enter the competition together | One starts the team timer; the other receives the existing times |
| Admin presses Reset while the team is mid-answer | Team keeps playing; the score reads 0 from that instant and then moves normally; nothing else changes. Reset and Disqualify at the same instant: whichever takes the team lock first, and Disqualify wins in the end (it freezes the team and its override beats any baseline) |
| Member buys Tier 2 while Tier 1 is not owned | `HINT_TIER1_REQUIRED`, no charge |
| Two members buy the same hint | Second returns `already_owned`, no charge |
| Two members click *Buy time* at once | Second gets `STALE_PURCHASE_COUNT`; client refreshes and may buy again deliberately |
| Submit and timeout in the same instant | Whichever acquires the team lock first; if the deadline passed, submit returns `QUESTION_TIMED_OUT` |
| Admin approves while student edits | Draft is irrelevant after submit; edits are rejected while `PENDING_APPROVAL` |
| Two admins review one submission | Second gets `SUBMISSION_NOT_PENDING` |
| Final submit twice / by two members | One wins, others `ALREADY_SUBMITTED` |
| Request retried after a network failure | Same `Idempotency-Key` → stored response, no second effect |
| Browser clock changed | Irrelevant; every decision uses `app.now()` |
| Ultimate timer hits 0 during a request | Preamble expires the team first; the request fails with `TEAM_ENDED` |
| Global pause during a request | Request either committed before the status change or fails with `COMPETITION_PAUSED` (it reads the status under lock) |
| Sweeper and a student request race | Sweeper uses `SKIP LOCKED`; either path calls the idempotent `expire_team` |
| Question times out while the member is offline | Materialised lazily on next access or by the sweeper; `timed_out_at` records the true deadline |

---

## 8. Audit event catalogue

`MEMBER_LOGIN`, `MEMBER_LOGOUT`, `STAFF_LOGIN`, `STAFF_LOGOUT`, `LOGIN_FAILED`, `FULLSCREEN_EXIT`, `TEAM_CREATED`, `ADMIN_CREATED`, `ADMIN_DISABLED`, `TEAM_REASSIGNED`, `COMPETITION_STATUS_CHANGED`, `TEAM_STARTED`, `THEME_UNLOCKED`, `QUESTION_STARTED`, `HINT_PURCHASED`, `TIME_PURCHASED`, `ANSWER_SUBMITTED`, `SUBMISSION_APPROVED`, `SUBMISSION_REJECTED`, `TEAM_FINAL_SUBMITTED`, `TEAM_ENDED`, `UFM_SCORE_RESET`, `UFM_DISQUALIFIED`, `PASSWORD_RESET`.

Each payload carries enough to reconstruct the change: actor, team, entity ids, amounts, `balance_before/after`, and (for status changes) `from`/`to`.

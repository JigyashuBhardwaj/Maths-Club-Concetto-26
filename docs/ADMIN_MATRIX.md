# Admin "My Teams" live control matrix (Patch B14)

`/admin/teams` is the Admin's operating board. It **reformats the existing B12 My Teams surface**; it does not add a second team system. Team creation (`create_team`), `list_admin_teams`, team ownership (`teams.admin_id`), credentials, members, admission numbers and the initial coin grant are untouched, and a team created through the existing Create a team dialog is a new row on the next read.

```
Team ID | M1 | M2 | M3 | M4 | A | B | C | D | E | F | G | H | I | J | Final submit
```

Sticky header and Team ID column, horizontal scroll, every state carries text or a symbol (never colour alone), every cell is a labelled button.

## State model

**Theme cell** (derived by the database from `team_questions`, nothing is stored):

| Cell     | Rule                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------- |
| `RED`    | at least one question of the theme is `PENDING_APPROVAL`                                        |
| `GREEN`  | all five questions are `APPROVED`                                                               |
| `NORMAL` | everything else, including an unlocked or active theme (shows `n/5` once something is approved) |

Several themes of one team and several teams can be red at once. Unlocking a theme never turns it red; only a pending submission does.

**Question (inside the cell dialog):** `GREEN` = approved, `RED` = a submission waits for the Admin, `WHITE` = anything else (locked, open, in progress, timed out), with the raw state as a caption. A theme the team has not unlocked reports five locked questions.

**Final Submit:** green `✓ Submitted` when `teams.status = FINAL_SUBMITTED`, otherwise a dash. B14 reads the existing state; there is no final-submit engine yet.

## Review path

My Teams → cell → five questions → red question → the submission (answer, explanation, who and when, the question text, the reward Approve will pay) → **Approve** / **Disapprove**. Both buttons call the existing authenticated B13 endpoints (`POST /api/admin/submissions/:id/approve|disapprove`); there is no parallel implementation and the page holds no game state. The reference answer is never sent to the browser (the Admin compares with the official answer they hold separately). The temporary `/admin/review` page, its navigation entry and `GET /api/admin/queue` were removed.

On **disapprove** the B13 semantics are unchanged: the rejected row is kept, the team's draft is kept, the question returns to `ACTIVE` with its frozen remaining time and the team may correct and resubmit. (The UI document says the answer box "clears"; B13 deliberately keeps the draft, and B14 does not rewrite that state machine.)

## Approval → reward → next question (unchanged B13 transaction)

`approve_submission` runs under the team lock in one transaction: submission `APPROVED`, question `APPROVED`, `teams.coins += questions.reward_coins`, **one** `QUESTION_REWARD` row in the immutable ledger (a unique index on team + question is the backstop), the next question `ACTIVE` with its own deadline, `state_version` bumped, audit row. A retry with the same `Idempotency-Key` is a replay; a different key finds nothing pending (`SUBMISSION_NOT_PENDING`, 409) and pays nothing. The dialog keeps one key per decision until the server answers definitively, so a double click or a retry after a lost response is a replay. Proven against real PostgreSQL in `110_admin_matrix.test.sql` and `concurrency/team_play.concurrency.mjs`.

## Configurable reward

The reward is question-level data: `questions.reward_coins` (already in the schema from the content migration), seeded to **50** for all 50 questions. `approve_submission` reads that column and nothing else; no amount is written in any function, handler or component. A later difficulty-based scheme is a data change. The SQL test changes one question to 75, approves, and checks the ledger, the balance and `submissions.reward_awarded` all say 75. B14 adds no dynamic difficulty rewards.

## Presence (M1–M4)

Authenticated and online are different. A member is **IN** when they have a live (not revoked, not expired) session whose `last_seen_at` is newer than `app.presence_timeout_seconds()` = **75 seconds**.

- `last_seen_at` is stamped by every authenticated request (`resolve_session`, already existing) and by the participant **heartbeat** `POST /api/p/heartbeat`, sent by the participant layout every **25 s** (also from a hidden tab, and again when the tab becomes visible or the network returns). Two lost beats are tolerated.
- Login creates the session with `last_seen_at = now` → IN. Logout revokes the session → OUT at once. A closed browser or lost network → OUT when the timeout elapses. Any request or beat afterwards → IN again.
- It is per member: the matrix reads one row of `member_presence` per `team_members` row. A team-level "has a session" flag is never used. There is no second session system and no client-held presence.
- The heartbeat authenticates and stamps; it writes nothing else, touches no game state, timer or `state_version`.

## Ownership

Enforced in the database, not in React. `admin_matrix(staff_id)` returns only `teams.admin_id = staff_id`; `admin_team_theme` calls `app.require_owner_admin` (active `ADMIN` that owns the team, otherwise `NOT_FOUND`, indistinguishable from an unknown id). The staff id always comes from the session, never from the request. The Super Admin gets 403 on the matrix endpoints (the board is the Admin's own, exactly like `list_admin_teams`). `approve_submission` / `disapprove_submission` already return `NOT_FOUND` for another Admin's team (B13); the tests cover all four paths (matrix, theme, approve, disapprove) with a second Admin.

## Synchronisation

The database is the source of truth; every answer replaces the board wholesale and an older answer (`server_now`) never replaces a newer one. The board re-reads `GET /api/admin/matrix` every ~3 s (±0.5 s) while the tab is visible, when the tab becomes visible or focused, when the network returns, and immediately after a decision; the open theme dialog re-reads its theme on the same cadence. A failed read keeps the last board and shows "Reconnecting…".

**Realtime is not wired in this patch.** The project has no Realtime client, channel authorisation or token endpoint yet (`REALTIME_SPEC.md` describes them; the spikes SP-01/SP-02 are still open), and B13 shipped polling-only. Polling is the fallback `REALTIME_SPEC.md` mandates and is complete on its own; a Realtime ping would only trigger the same `refresh()`. Worst-case latency: a submission or approval reaches the board within about 3.5 s, a participant sees an approval within about 5.5 s, a login shows IN within about 3.5 s, a logout OUT within about 3.5 s, and silence OUT within 75 s plus one poll.

## Files

Database: `supabase/migrations/20261006000015_admin_matrix.sql`, `supabase/tests/110_admin_matrix.test.sql`.
Server: `src/lib/contracts/matrix.ts`, `src/lib/matrix/{handlers,routes,client,server-data}.ts`, `src/app/api/admin/matrix`, `src/app/api/admin/teams/[teamId]/themes/[themeCode]`, `src/app/api/p/heartbeat`.
Browser: `src/components/admin/{my-teams-matrix,theme-review-dialog}.tsx`, `matrix.css`, `src/app/admin/teams/page.tsx`, the heartbeat in `src/components/game/game-provider.tsx`.
Tests: `tests/unit/matrix-handlers.test.ts`, `tests/component/{my-teams-matrix,game-heartbeat}.test.tsx`, `tests/e2e/my-teams.spec.ts`.

## Not in this patch

Hints, Buy Time, difficulty-based rewards, UFM (Reset Score / Disqualify) and the team-name click, leaderboard changes, fullscreen integrity, role-specific cookies, a final-submit engine, Realtime push. **[B16: UFM (penalty) and the Team ID click were delivered in B16. See SCORING_AND_LEADERBOARD.md.]**

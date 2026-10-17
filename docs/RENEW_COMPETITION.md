# Renew the Competition (Super Admin) — migration 21

The Super Admin can edit the competition content (theme names and descriptions, question texts, the two hints of each question, the
reward of each question, and the rules) and **apply** it. Applying also removes every Admin the Super Admin created, together with
their teams, and re-opens the competition lifecycle for the next edition — all in ONE database transaction.

Specification: `changing content.docx` (the product owner's wording, layout and screenshots). Everything technical — schema,
authorisation, deletion, gameplay behaviour — is the repository's, as the task asked.

## 1. Where the document and the repository disagreed, and what was done

| #   | The document / task says                                                                                                                    | The repository has                                                                                                                                                           | Decision (the safest compatible one)                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A "Renew the competition" button on the Superadmin dashboard; the screenshot circles the empty slot **under "Delete teams" in the sidebar** | The dashboard page has no buttons; its actions are the sidebar entries                                                                                                       | A sidebar entry **"Renew the competition"** after "Delete teams", exactly where the screenshot points (`/superadmin/renew`).                                                                                                                                                                                                                                          |
| 2   | Reward is a _positive_ integer                                                                                                              | `questions.reward_coins` has a DB check `>= 0`                                                                                                                               | The renewal function and the API accept **1 – 999 999** only. The column's check is not touched (it still allows 0 for rows nobody edits).                                                                                                                                                                                                                            |
| 3   | Rules and regulations are editable                                                                                                          | They only existed in the build (`official-content.json` → `official-public.ts`, a no-drift generator test)                                                                   | **One nullable column `competition.rules jsonb`** (1–50 texts). `NULL` = never renewed → the participant app shows the built-in official rules, exactly as before. The generator, the JSON and its test are untouched.                                                                                                                                                |
| 4   | Edited names must reach the game                                                                                                            | The participant UI showed the **compile-time** official theme names (B17) while the database already holds the same names (migration 19)                                     | Ticket labels, the theme dialog heading and the question page title now use the name in the team snapshot (`state.themes[].name`), falling back to the built-in name only until the snapshot arrives. Identical text until a renewal changes it.                                                                                                                      |
| 5   | "No team solving; each has submitted or its overall timer has run out"                                                                      | Teams can be `NOT_STARTED`, `RUNNING` (with a question `ACTIVE`, or `PENDING_APPROVAL` after a submission, or between questions), `FINAL_SUBMITTED`, `ENDED`, `DISQUALIFIED` | See §4: the exact, documented rule.                                                                                                                                                                                                                                                                                                                                   |
| 6   | Delete "the admins created by the Superadmin"                                                                                               | `staff_users.created_by` records the creator; `delete_admins()` deletes admins and their teams                                                                               | Exactly the ADMINs with `created_by = the Super Admin`, through the existing `delete_admins()`. An Admin that was **not** created by the Super Admin (only possible for an account inserted outside the application) is never deleted: the renewal rolls back with `RENEWAL_INCOMPLETE` and the UI tells the person to remove such Admins with "Delete admins" first. |
| 7   | "start the next competition via the existing workflow"                                                                                      | `set_competition_status` allows `open` only from `SETUP`; **`ENDED` is terminal**                                                                                            | A renewal returns the competition to `SETUP` (see §6). Without it a competition that already ended could never be opened again.                                                                                                                                                                                                                                       |
| 8   | "one server-controlled transaction where feasible"                                                                                          | PostgREST runs one RPC in one transaction                                                                                                                                    | `renew_competition` is one PL/pgSQL function: any raise rolls back the deletion, the content and the lifecycle change together.                                                                                                                                                                                                                                       |

## 2. What the migration adds

`supabase/migrations/20261006000021_renew_competition.sql` — append-only; migrations 19 and 20 are not rewritten; no table, foreign
key, index, trigger or policy is added or changed.

- `competition.rules jsonb` (nullable) with a shape check (`NULL`, or a JSON array of 1–50 JSON strings). The check is a `CASE` on purpose: SQL does not promise left-to-right evaluation of `AND`/`OR`, and `jsonb_array_length()` raises on a scalar or an object, so the length is only asked of a value already known to be an array and any malformed value is a plain `CHECK` violation (23514). The element test uses a `strict` jsonpath, because the default lax mode unwraps nested arrays and would let `[["x"]]` through. Nothing is back-filled.
- `public.get_renewal_content(staff_id)` — Super Admin only: the content, its concurrency **token**, and the readiness report.
- `public.renew_competition(staff_id, content, expected_token, idempotency_key)` — the atomic renewal (§3).
- `public.get_competition_rules()` — the rules participants read (`NULL` = built-in).
- Internal helpers in schema `app` (`renewal_content_json`, `renewal_content_token`, `renewal_content_problems`, `renewal_readiness`,
  `renewal_themes`, `renewal_questions`, text/keys checks). All revoked from `public`, `anon` and `authenticated`; the three public
  functions are `SECURITY DEFINER`, pin `search_path`, and are granted to `service_role` only, like every function since migration 11.

Rolling back: nothing depends on the column or functions until the application reads them. To undo before first use,
`drop function` the three public functions and `alter table competition drop column rules` (and drop the helpers). **Do not apply
this migration to production without review** — it was verified only on scratch databases (§8).

## 3. What a renewal does (in order, one transaction)

1. Locks, in the repository's global order: `competition` (FOR UPDATE — every gameplay call, review, team creation and status change takes it FOR SHARE, so none can run meanwhile) → the caller's staff row → every team.
2. The caller must still be an **active SUPER_ADMIN** (`FORBIDDEN` otherwise), whatever the application resolved earlier.
3. Idempotency (`Idempotency-Key`): a repeat of the same request returns the stored answer (`Idempotent-Replay: true`). The same key with another content is `IDEMPOTENCY_KEY_REUSED`.
4. **Validation** (§5) → `VALIDATION_FAILED` with the field paths. Then the **concurrency check**: the `expectedToken` must equal the token of the live content → `CONTENT_CHANGED`.
5. **Preconditions** on live rows (§4) → `RENEWAL_BLOCKED`, with the teams that block.
6. **Deletion** through the existing `delete_admins()` (the B18 pathway: teams, members, sessions, ledger exception, request log, …) for every ADMIN with `created_by = caller`, in chunks of 100 with derived idempotency keys. Afterwards no team and no ADMIN may remain, or `RENEWAL_INCOMPLETE`.
7. **Content**: `UPDATE` of the content columns only — `themes.name/description`, `questions.body_md/reward_coins`, `hints.body_md`, `competition.rules` — only rows that differ. Never an id, code, difficulty, unlock cost, hint price, time limit, buy-time option, topic, starting coins or timer. A final proof compares what the database now holds with what was submitted (`RENEWAL_CONTENT_MISMATCH` rolls back otherwise).
8. **Lifecycle** (§6).
9. One `COMPETITION_RENEWED` audit event (counts and tokens, never content) and the idempotency record.

Result: `{replayed, deleted:{admins,teams}, changed:{themes,questions,hints}, competition:{from,to}, token}`.

## 4. The preconditions ("nobody is solving") — decided here

Read from the live rows with the same clock as every snapshot (`app.team_clock`), after every team row is locked:

| Team state                                                                                                                                   | Blocks?                        |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `NOT_STARTED`, `FINAL_SUBMITTED`, `ENDED`, `DISQUALIFIED`                                                                                    | no                             |
| `RUNNING` and its overall timer has run out (`team_clock >= ends_at`), even if the sweeper has not yet persisted `ENDED`                     | no                             |
| `RUNNING` with time left, a question `ACTIVE` ("actively solving")                                                                           | **yes** — `ACTIVE_QUESTION`    |
| `RUNNING` with time left, no question `ACTIVE`, none `PENDING_APPROVAL` ("its team timer is running": it can start a question at any moment) | **yes** — `TEAM_TIMER_RUNNING` |
| `RUNNING` with time left, no question `ACTIVE`, at least one `PENDING_APPROVAL` ("has submitted and awaits approval")                        | no                             |

The document's sentence is ambiguous in two places and the safest reading was taken: a team that **has not started** is not playing, so it does not block; a team whose
last question is **awaiting approval** has "submitted", as the document says, so it does not block — **but its pending submission is deleted
with the team**. The readiness report therefore counts pending submissions, the **Apply Changes dialog shows that number in a dedicated warning** ("Warning: N submissions still awaiting approval will be permanently discarded together with their teams. They will not be reviewed, scored or paid."; singular/plural handled; "No submissions are awaiting approval, so none will be discarded." when there are none), the audit event records it, and the result of the renewal returns it (`discarded.pending_submissions`). The dialog re-reads the server when it opens so the number is current, and **YES, APPLY CHANGES stays disabled until that read succeeded** (if it fails, nothing can be confirmed). The number can still change between that read and the click; the figure that was really discarded is the one reported afterwards and audited. If a stricter rule is wanted
(approve everything first), change `app.renewal_readiness()` (and its mirror in `tests/e2e/support/fake-gameplay.mjs`).

## 5. Validation (same rules in zod, the editor and the database)

Exactly 10 themes `A`–`J` in order; 5 questions each with ids `X.1`–`X.5`; exactly two hints (`hint1`, `hint2`); non-blank texts without control
characters (TAB, LF and CR are allowed — multiline text, Unicode and punctuation are kept exactly, including leading and trailing spaces); name ≤ 200,
description ≤ 1000, question ≤ 8000, hint ≤ 4000, rule ≤ 2000 characters (code points); reward an integer 1–999 999; 1–50 rules; **no unknown key anywhere**, so no id, price, timer or setting can
ride along. The body is limited to 4 MiB. `src/lib/contracts/renewal.ts` is the zod schema and the editor's checker (`draftProblems`); `app.renewal_content_problems` is the authority. An unpaired UTF-16 surrogate is refused by the zod schema and the editor only (PostgreSQL's `jsonb` input cannot even receive one), so it is a field error and never a server error.

## 6. Lifecycle after a renewal

`competition.status → 'SETUP'` with `opened_at`, `paused_at`, `ended_at` cleared (only when it was not `SETUP` already) and `state_version + 1`. Nothing else is touched: initial coins,
timers, hint prices, unlock costs and buy-time options keep their values. New Admins and teams can be provisioned straight away, and the Super Admin starts the next edition with the existing
"open" action.

**Participants cannot sign in while the competition is `SETUP`** (`COMPETITION_NOT_RUNNING`, "The competition isn't open for sign-in right now."): login is allowed only in `RUNNING` and `PAUSED`. After a renewal the
Super Admin therefore has to open the competition deliberately, once at least one team exists. That is done from the **Competition status** panel at the top of the Superadmin dashboard (`/superadmin`), see §6b.

## 6b. The lifecycle control (Superadmin dashboard)

`src/components/lifecycle/competition-control.tsx` is a child of `StaffHome` on `/superadmin`. It calls the existing `POST /api/super/competition/status` (no new endpoint, no new migration): same-origin, a fresh `Idempotency-Key` UUID, body `{action, confirm:true}`.

| Status    | Shown                               | Actions                                      |
| --------- | ----------------------------------- | -------------------------------------------- |
| `SETUP`   | Setup — participants cannot sign in | **Open competition**                         |
| `RUNNING` | Running                             | **Pause**, **End competition** (asks first)  |
| `PAUSED`  | Paused                              | **Resume**, **End competition** (asks first) |
| `ENDED`   | Ended — cannot be reopened          | none (a link to "Renew the competition")     |

- **Confirmation**: only `end` is confirmed ("End the competition?"), because it cannot be undone. Open, pause and resume are reversible and are not.
- **Where the current status comes from**: `src/app/superadmin/page.tsx` (guarded by `requireStaffArea("superadmin")`, `force-dynamic`) reads it on the server through `loadCompetitionOverview` (`src/lib/runtime/server-data.ts`), which calls the existing Super-Admin-only function `get_renewal_content` with the staff id of the verified session and keeps ONLY `readiness.competition_status` and `readiness.teams` (a narrow zod schema; everything else of that payload is ignored). No status is ever taken from the client, and the database re-checks the role and the transition on every action. If the status cannot be read, the panel says so and offers **Reload** instead of guessing a status or offering actions. Trade-off: that function also computes the renewal content and readiness, which is more than the dashboard needs; a dedicated read-only SQL function would be lighter but would need a migration, so it was not added. It is a possible follow-up.
- **Failures** (fixed wording by error code, never server text): `COMPETITION_NOT_READY` (no team yet, or incomplete content), `INVALID_COMPETITION_TRANSITION` (the panel corrects itself to the status the server reports), `FORBIDDEN`, `UNAUTHENTICATED`, network and server errors. After an unknown outcome (network error, `5xx`) a retry reuses the same `Idempotency-Key`, so it can never be applied twice; after a definite answer the next attempt gets a new key.
- Double clicks are ignored while a request is in flight (the buttons are disabled and the panel is `aria-busy`); results are announced in a `role="status"` / `role="alert"` region.

## 6a. Authorisation

`GET` and `POST /api/super/renew` and the page are Super Admin only: the layout guard (`requireStaffArea("superadmin")`), the route handler (role from the verified session; the staff id is never taken from the request) and the database functions (`app.require_super_admin` / the explicit role check) each enforce it.
A same-origin check and an `Idempotency-Key` guard the `POST`.

## 7. The editor (`/superadmin/renew`)

Follows the screenshots: Go back at the top left, the centred title "Renew the Competition", an orange badge (`A`, `A.1` …) above a two-column `label | value` table per theme and per question
(Theme name / Theme description; Question / Hint 1 / Hint 2 / Reward), then "RULES AND REGULATIONS" with a numbered, removable list and an **Add+** row, then **RESET** and **APPLY CHANGES**. Editable
values are visibly input fields (dashed orange border, tinted fill); labels and ids are plain text. The page scrolls normally and stacks on small screens.

- **RESET** restores what was loaded and sends nothing.
- **APPLY CHANGES** validates locally (invalid fields are marked and the first one focused; no dialog), then opens **"Apply Changes"** with the exact wording of the document and the buttons **YES, APPLY CHANGES** / **GO BACK**. GO BACK closes it and keeps every edit.
- **YES** sends one request (one `Idempotency-Key`, reused only when the outcome is unknown), disables everything and shows "Applying changes…". Success is reported only after the server confirmed the whole renewal, then the editor reloads the server's content. Failure shows a fixed message by error code and keeps the edits; `RENEWAL_BLOCKED` re-reads which teams block; `CONTENT_CHANGED` offers "Discard my edits and load the latest".
- A readiness banner shows how many admins and teams will go, which teams still block, and **Check again**.
- **Unsaved changes**: closing/reloading the tab (`beforeunload`), any in-app link (sidebar, Go back) and the browser's Back button ask "Leave without applying?" while there are edits.

## 8. Verification (what was actually run)

See the delivery report for the exact commands and results. In short: the SQL suite (`supabase/tests/200_renew_competition.test.sql`), a two-connection concurrency script (`concurrency/zz_renew.concurrency.mjs`) and an upgrade script (`upgrade/b21_upgrade.upgrade.mjs`) run against a real PostgreSQL 16 scratch cluster; Vitest unit and component tests; Playwright (`tests/e2e/renew.spec.ts`, its own project that runs last because a renewal is global).

## 9. Limitations and risks

- The in-memory test backend (`tests/e2e/support/fake-renewal.mjs`) **mirrors** the SQL; the browser and handler tests prove the application against that mirror. The SQL itself is proven on real PostgreSQL by the SQL tests above. A rule changed in one must be changed in the other.
- A submission awaiting approval is discarded with its team (§4). Teams are not "archived": the existing deletion pathway erases them, as the document describes ("similar to the deletion of admins").
- Admin accounts not created by the Super Admin make a renewal refuse (`RENEWAL_INCOMPLETE`) rather than be deleted or skipped.
- Participants read the rules when the page is rendered; a renewal deletes every team, so no participant is mid-session across a renewal.
- There is no history of previous content: the audit event records counts and tokens only. Keep a copy of the content you replace if you need to restore it (the editor's RESET only restores what was loaded).
- The migration was not applied to any real project. Apply it to staging first (`supabase db push` is the operator's step, not part of this patch).

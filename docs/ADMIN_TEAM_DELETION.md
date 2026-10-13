# Super Admin: permanently delete Admins and Teams (Patch B18, revision 4: complete deletion, DELETE_BLOCKED regression tests and diagnostics)

What exists: the Super Admin has two screens, **Delete Admins** (`/superadmin/delete-admins`) and **Delete Teams**
(`/superadmin/delete-teams`), reachable from the Super Admin sidebar. Each lists records with checkboxes, a "N selected"
count and a trash button; the trash button opens "Do you want to permanently delete the selected admins?" (teams likewise,
singular when one is selected) with **Yes** / **No**. Deleting a team deletes the team and **everything it owns, including
its purchases and its whole coin ledger**. Deleting an Admin deletes the Admin and all of its teams the same way. There is no
disabling, reassigning, restore, soft delete, archive or "retired identity" record.

Revisions 1 and 2 kept purchase and coin history by moving foreign keys onto an identity registry. That machinery is gone
(it never existed in a released database: migration 20 is unreleased and was rewritten).

## 1. What migration 20 changes (`20261006000020_super_admin_deletion.sql`)

Schema: **no table, column, foreign key, index or trigger is added, dropped or altered.** Migration 20 only creates and
replaces functions:

| Object                                                                           | Change                                                                                                                  |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `app.ledger_immutable()` (trigger function behind `coin_tx_no_update`)           | replaced: still raises `coin_transactions is append-only`, except for a DELETE of a row whose team is being erased (§2) |
| `resolve_session`                                                                | replaced: a session whose staff / member / team row no longer exists is `UNAUTHENTICATED`                               |
| `app.deletion_selection`, `app.erase_teams`                                      | new, internal                                                                                                           |
| `list_deletable_admins`, `list_deletable_teams`, `delete_teams`, `delete_admins` | new, `service_role` only, each re-checks "active SUPER_ADMIN"                                                           |

Verified before writing it (`pg_constraint`, `pg_trigger`, `information_schema.role_table_grants`, migrations 1–19): every
table that references `teams`, `team_members`, `submissions` or `staff_users` is handled by `app.erase_teams` /
`delete_admins`; test 190 lists every foreign key that points at those four tables and fails if a new one appears that the
functions do not know about. All foreign keys stay `ON DELETE RESTRICT` (nothing cascades); deletion order does the work.

## 2. The ledger exception (the one relaxed protection)

`coin_transactions` has been append-only since migration 6: triggers refuse UPDATE, DELETE and TRUNCATE, and `service_role`
holds only SELECT and INSERT. The requirement now is that a deleted team's ledger is deleted with it, so the DELETE branch of
`app.ledger_immutable()` has exactly one exception: the row's `team_id` must be listed in the transaction-local setting
`app.retiring_team_ids`. Only `app.erase_teams` sets it (`set_config(..., true)`), for the verified team ids only, immediately
before its single `DELETE FROM coin_transactions` and clears it right after.

What stays enforced, and is tested (test 190 §3 and `b18_upgrade.upgrade.mjs`): UPDATE always refused; TRUNCATE always refused;
DELETE without the setting refused; DELETE of another team's row refused even with the setting; `service_role` still has no
DELETE/UPDATE/TRUNCATE privilege on the ledger, `team_time_purchases` or `audit_events` (the setting alone gives it nothing);
`app.erase_teams` itself is **not** executable by `service_role` (it has no authorisation of its own); `audit_events` is
untouched; the balance-chain trigger is untouched. As always, the database owner can disable triggers; that is not new.

## 3. What is deleted, what is kept

Deleted for every selected team (and, for an Admin, every team whose `admin_id` is that Admin, including a team created
while the deletion waited for locks): `coin_transactions` (all rows with the team's `team_id`, which covers its members' and
its submissions' rows because their foreign keys are composite with `team_id`), `team_time_purchases`, `hint_purchases`,
`answer_drafts`, `team_questions`, `team_themes`, `submissions`, `ufm_challenges`, `sessions`, `team_members`, `teams`,
`auth_throttle` keys of the team's login ID, and the `request_log` rows of §4. For every selected Admin: `sessions`,
`ufm_challenges`, the `auth_throttle` key of the username, `staff_users`, and the `request_log` rows of §4.

Team deletion also clears `teams.final_submitted_by` first (it and `team_members.team_id` reference each other).

Kept, and why (this is **not total erasure**):

- **`audit_events`** (append-only, never updated, deleted or truncated; `audit_no_update` / `audit_no_truncate` stay enabled).
  Rows written earlier about a deleted account remain: they carry its ids (`team_id`, `staff_id`, `member_id`, `entity_id`)
  and, in the payloads of `TEAM_CREATED`, `TEAM_DELETED`, `ADMIN_CREATED`, `ADMIN_DELETED` and similar events, the team code,
  team name, login ID and admin username (payload keys: `admin_id, initial_coins, login_id, member_count, name, role, status,
team_code, username`). No password hash, session token or admission number is in any audit payload. This migration adds
  `TEAM_DELETED`, `ADMIN_DELETED`, `TEAMS_DELETED` and `ADMINS_DELETED` events (ids, code/name/login ID/username, and counts of
  removed rows). Removing audit rows would mean editing an immutable trail; it is a policy decision, deliberately not taken here.
- The Super Admin's own `request_log` rows for `delete_teams` / `delete_admins` (scope = the Super Admin). They hold the
  deleted ids so that a retry of the **same** request replays its answer instead of failing.
- `leaderboard_snapshot` (unused), competition rules, themes, hints, questions, keys, buy-time options, the Super Admin and every
  other Admin and Team with all their data.

Remaining balances: a team's coins are derived from its own ledger rows, so no other team's balance, rank or leaderboard row
can change. Test 190 compares row fingerprints of every unrelated table and team before and after.

## 4. `request_log`: verified schema, ownership, and the cleanup predicates

Schema (migrations 7, 12–14, 17, 18): `request_log(team_id uuid, idem_key uuid, operation text, response jsonb, created_at,
request_fingerprint text)`, primary key `(team_id, idem_key)`, **no foreign keys**, no triggers, and one non-unique index on `created_at` (`request_log_created_idx`, commented "hourly purge"; no purge job exists in the repository, which is unchanged). Written only by
`app.idem_store`, read only by `app.idem_lookup`, always inside a transaction that already holds the row lock of the principal.

The column name is misleading: `team_id` is a **scope**. For participant calls it is the team's id; for staff calls it is the
caller's `staff_users.id`. That settles what the suspicious B18 r1/r2 statement `delete from request_log where team_id =
any(<admin ids>)` means: it is **correct for the admin's own scope** (every staff call the admin ever made) and it can never
match a team. But it is not the whole story. Reading every writer of `idem_store`, a deleted team also leaves rows in other
scopes:

| Operation (fingerprint)                                                                               | Scope (`team_id`)                 | Belongs to a deleted team when…                 |
| ----------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------- |
| unlock_theme, start_question, submit_answer, buy_hint, buy_time, final_submit, start_team_competition | the team                          | `team_id` = the team                            |
| `create_team` (JSON of code, name, login, admission numbers)                                          | the creating admin or Super Admin | `response #>> '{team,id}'` = the team           |
| `penalize_team` (`team:<id>`)                                                                         | the owner admin                   | fingerprint = `team:<team id>`                  |
| `approve_submission` (`submission:<id>`), `disapprove_submission` (`submission:<id>                   | note:<md5>`)                      | owner admin or Super Admin                      | the submission id belongs to the team |
| `create_admin` (`username:…`)                                                                         | the Super Admin                   | `response #>> '{admin,id}'` = the deleted admin |
| `delete_teams`, `delete_admins`                                                                       | the Super Admin                   | never deleted (kept for replay)                 |

Final predicates: `app.erase_teams` deletes rows matching (a) `team_id = any(teams)`, (b) `operation='create_team'` and
`response #>> '{team,id}' = any(teams)`, (c) `operation='penalize_team'` and `request_fingerprint = any('team:'||id)`, (d)
`operation in (approve, disapprove)` and `split_part(request_fingerprint,'|',1) = any('submission:'||id)` for the team's
submission ids (read **before** the submissions are deleted). `delete_admins` additionally deletes `team_id = any(admin ids)`
(the admin's scope) and `operation='create_admin'` with `response #>> '{admin,id}' = any(admin ids)`. A `staff_id` column does
not exist on `request_log`, so nothing else is applicable. Unrelated rows (other teams, other admins, the Super Admin's status
and other replies, a surviving admin's `create_admin` replies for other admins, the `delete_*` records) are not matched; test 190
asserts the exact set of removed keys for direct deletion, admin deletion, bulk deletion, and shows rollback restores them all.

Idempotency, concurrency, in-flight retries: every participant request locks the team row, every staff request that writes a
team-scoped record locks the team or staff row, and `delete_*` locks the selected team rows (`FOR UPDATE`, id order) and admin
rows before it deletes anything. A request that started first finishes and its `request_log` row is then removed with its team;
a request that arrives after finds no team/session (`UNAUTHENTICATED` / `NOT_FOUND`) and writes nothing; a reviewer approval
racing a team deletion either completes before it or is refused after it (test E5/E6). A retry with the same key after the
deletion cannot replay a stale answer because the record is gone and the session is invalid. Retrying the **same delete**
request replays from the Super Admin's own kept record.

## 5. Who may do what

| Call                                                            | Anonymous | Participant | Admin | Super Admin |
| --------------------------------------------------------------- | --------- | ----------- | ----- | ----------- |
| `GET /api/super/admins`, `GET /api/super/teams`                 | 401       | 403         | 403   | yes         |
| `POST /api/super/admins/delete`, `POST /api/super/teams/delete` | 401       | 403         | 403   | yes         |

Order in each handler: Origin check (POST) → verified session → role → `Idempotency-Key` → strict body (8 KB) → one database
call → whitelisted result → envelope. The body carries ids only (`adminIds` / `teamIds`, 1–100 distinct UUIDs). The database
re-checks that the caller is an **active SUPER_ADMIN** inside the transaction. Selecting the Super Admin or any non-ADMIN is
`FORBIDDEN` and nothing is deleted.

## 6. Sessions, reuse, atomicity

Sessions of deleted accounts are deleted in the same transaction and `resolve_session` answers `UNAUTHENTICATED` for any
session whose principal is gone. Usernames, team login IDs, team codes and admission numbers of deleted records are free again.

One call is one transaction: all selected records are deleted or none is. Ids are re-checked inside the transaction (`404
NOT_FOUND` if one vanished), and a foreign key the cleanup does not know about, for example a ledger row of **another** team
naming a deleted admin, is `409 DELETE_BLOCKED` and rolls everything back (including request-log and ledger deletions).

Lock order: competition (`FOR SHARE`) → caller's staff row (`FOR NO KEY UPDATE`) → selected teams (`FOR UPDATE`, id order) →
selected admins (`FOR UPDATE`, id order; `create_team` locks its admin's row) → teams created in between. A deadlock victim rolls
back whole and can be retried.

### `DELETE_BLOCKED`: what blocks, what does not, and how to find out why

A foreign key the cleanup does not know about makes the whole request fail with `409 DELETE_BLOCKED`; every statement of the
call (teams, request-log rows, gated ledger deletion, sessions, admins) is rolled back, and nothing is stored for the
`Idempotency-Key`, so the same request can be repeated once the reference is gone. Blocking is relative to the **selection**:

| Reference                                                                                         | Effect on a deletion                                                                      |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `coin_transactions.staff_id` (ledger row of a team **not** being deleted, reviewed by the admin)  | blocks; the Super-Admin-reviewed row of an unrelated team stays unchanged either way      |
| `teams.created_by`, `submissions.reviewed_by`, `teams.ufm_penalized_by`, `staff_users.created_by` | block when the referencing row survives; selecting **both** sides in one request succeeds |
| a foreign key from any unknown table to a team                                                    | blocks (`DELETE_BLOCKED`, never a silent partial deletion)                                |
| `sessions.staff_id`, `ufm_challenges.staff_id` (also when the challenged team survives)           | **not** a blocker: removed together with the admin                                        |

None of these references can be created through the application (the single Super Admin is the only reviewer outside the
owner), so in practice they appear only through manual data changes; `supabase/tests/190_super_admin_deletion.test.sql` §12b
plants each one out of band and proves the outcome and the full rollback, and `B18-r3-production-preflight.sql` (read-only) is the
way to look for them in a real database before a release.

**Diagnostics (server side only).** The database error carries `{"constraint": "<fk name>", "table": "<referencing table>"}`
in its DETAIL: schema identifiers only, never an id, key, row value, username or credential. The API handler logs one line,
`deletion: blocked by a foreign key { fn, constraint, table }`, to the server log, after checking that both values look like
identifiers (anything else is logged as `undefined`). The browser never receives them: `DELETE_BLOCKED` is not on the list of
codes that may carry details, so the response is the fixed `409` envelope and the screen shows the fixed sentence "Nothing was
deleted: some of these … are still referenced by other records." Look the constraint up with `\d <table>` or in
`docs/evidence/schema.sql`, find the referencing row, remove or reassign it as an explicit, reviewed data fix, and retry.

## 7. Interface

Checkbox rows, select-all (up to 100), an `aria-live` count, a trash button (disabled at 0). Loading, empty and error states
are distinct. The dialog is the shared accessible `ModalDialog`; Escape, the backdrop and **No** change nothing; **Yes** is
disabled while the request runs. Success is shown only after the server confirmed it. Failure keeps the dialog and selection
with fixed wording by error code. The confirmation text says that members, progress, submissions, purchases and coin history
are deleted, and that an Admin's teams go with it.

## 8. Tests

| Layer                                                               | File                                                                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| SQL (real PostgreSQL)                                               | `supabase/tests/190_super_admin_deletion.test.sql`                                              |
| Concurrency (real PostgreSQL, parallel sessions)                    | `supabase/tests/concurrency/team_deletion.concurrency.mjs`, `team_provisioning.concurrency.mjs` |
| Upgrade B17 → B18 with real data                                    | `supabase/tests/upgrade/b18_upgrade.upgrade.mjs`                                                |
| API handlers (incl. DELETE_BLOCKED diagnostics)                     | `tests/unit/deletion-handlers.test.ts`, `tests/unit/deletion-contract.test.ts`                  |
| Components (incl. 409 DELETE_BLOCKED)                               | `tests/component/deletion-screen.test.tsx`, `tests/component/deletion-screen-limit.test.tsx`    |
| Browser (blocker control in `tests/e2e/support/fake-postgrest.mjs`) | `tests/e2e/super-delete.spec.ts`                                                                |

## 9. Applying it

Migration 20 is forward-only and creates/replaces functions only; it rewrites no earlier migration. Review it, run it
**locally** (never against a shared or production database), run `npm run db:verify`, and only then apply it through the normal
release process. Take a backup first: the deletion, including the ledger, is irreversible by design, and the audit rows named
in §3 remain.

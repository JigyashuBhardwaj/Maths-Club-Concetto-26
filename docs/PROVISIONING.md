# Admin and team provisioning (Patch B12)

What exists: the Super Admin creates Admins, an Admin creates Teams, an Admin sees only the teams they created
("My teams"), and both staff homes show the live leaderboard. What does **not** exist yet: team presence, theme
progress, review queue, UFM, reassigning a team, disabling an Admin, password reset (all later milestones), and any
scoring (every score is 0 until the scoring milestone).

## 1. Who can do what

| Action                            | Participant | Admin       | Super Admin |
| --------------------------------- | ----------- | ----------- | ----------- |
| `POST /api/super/admins`          | 403         | 403         | yes         |
| `POST /api/admin/teams`           | 403         | yes (owner) | 403         |
| `GET /api/admin/teams` (My teams) | 403         | own teams   | 403         |
| `GET /api/leaderboard`            | 403         | yes         | yes         |

- The owner of a team is the **authenticated Admin**. No request body, path, query or header can name an owner: the
  request schemas are strict and have no `adminId`, `role`, `coins`, `status` or `isActive` field, and the handler
  passes the staff id from the session to the database. The database re-checks the role and uses that id.
- Admin B cannot read Admin A's teams: `list_admin_teams` filters on `teams.admin_id = caller`. There is no
  team-by-id route in B12, so there is nothing to probe.
- A Super Admin creates Admins, not teams (a team always has exactly one owning Admin); the Super Admin sees every
  team on the leaderboard.
- Roles are enforced three times: `proxy.ts` + the server layout guard (pages), the handler (`requireRole`), and the
  SQL function (`FORBIDDEN`).

## 2. Database (migration 13, `20261006000013_provisioning.sql`)

No table, column or index changes. Four `SECURITY DEFINER` functions (pinned `search_path`; `EXECUTE` revoked from
`public`, `anon`, `authenticated`; granted to `service_role` only):

| Function                                                                                     | Purpose                                                                |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `create_admin(p_staff_id, p_username, p_password, p_idem_key)`                               | Active SUPER_ADMIN creates an ADMIN                                    |
| `create_team(p_staff_id, p_team_code, p_name, p_login_id, p_password, p_admission_nos, key)` | Active ADMIN creates a team, its four members and the initial grant    |
| `list_admin_teams(p_staff_id)`                                                               | The caller's own teams (stable)                                        |
| `get_leaderboard(p_staff_id)`                                                                | Rank, team code, score of every team for an active Admin / Super Admin |

`create_team` is one transaction: team row (owner and `created_by` = caller, `coins` = `competition.initial_coins`),
members M1–M4, an `INITIAL_GRANT` ledger row (the balance-chain trigger requires the amount to equal
`initial_coins`, 500), and a `TEAM_CREATED` audit row. Either everything exists or nothing does. Passwords are hashed
by `app.hash_password` (bcrypt, cost 12) inside the function; the plaintext is never stored, logged, audited or
returned, and no response contains a hash.

Validation (the database is the authority; the browser and the API repeat it for friendlier messages):

- Admin: username `[A-Za-z0-9._-]{3,64}`, case-insensitively unique; password 10–72 bytes.
- Team: Team ID `[A-Z0-9][A-Z0-9_-]{0,15}` (stored upper-case), name 1–100 characters without control characters,
  Login ID `[A-Za-z0-9._-]{3,64}` (case-insensitively unique), password 8–72 bytes and not equal to the Team ID or
  Login ID, exactly four admission numbers `[A-Z0-9][A-Z0-9/._-]{0,31}` (stored upper-case), distinct within the
  request and unique across all teams.
- Failures raise `app.fail(code)`: `VALIDATION_FAILED` (`details.fields`), `USERNAME_TAKEN`, `TEAM_CODE_TAKEN`,
  `LOGIN_ID_TAKEN`, `ADMISSION_NO_TAKEN` (`details.slot` 1–4), `FORBIDDEN`, `IDEMPOTENCY_KEY_REUSED`. The unique
  constraints (`staff_users.username`, `teams_team_code_key`, `teams_login_id_key`,
  `team_members_admission_no_key`) are the backstop for a race; a violation is mapped to the same codes and the whole
  transaction rolls back.

### Idempotency

Same mechanism as B10 (`app.idem_lookup` / `app.idem_store`, table `request_log`), scoped to the **staff id**. The
fingerprint is the normalised request **without the password**, so a stored response never depends on a secret. The
same key and the same request replays the stored response (`Idempotent-Replay: true`); the same key for a different
request is `409 IDEMPOTENCY_KEY_REUSED`; a failed request stores nothing, so it can be retried. The caller's staff row
is locked `FOR UPDATE` first, so two concurrent requests with one key serialise and the second replays. `create_team`
takes the competition row `FOR SHARE` before the staff row (the B10 lock order), so it cannot deadlock with
`open` / `pause`.

## 3. API

All routes: same-origin check (non-GET), session cookie, role, `Idempotency-Key` header (UUID; state-changing calls),
strict JSON body (2 KB), one database call, a whitelist result schema, the standard envelope. Errors are mapped by code;
no database text, hash, token or stack trace is returned.

| Route                    | Body                                                                                   | Success `data`                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `POST /api/super/admins` | `{username, password, confirmPassword}`                                                | `{admin: {id, username, role, is_active, created_at}}`                             |
| `POST /api/admin/teams`  | `{teamCode, name, loginId, password, confirmPassword, admissionNos: [M1, M2, M3, M4]}` | `{team: {id, team_code, name, login_id, status, coins, member_count, created_at}}` |
| `GET /api/admin/teams`   | -                                                                                      | `{teams: [{id, team_code, name, login_id, status, member_count, created_at}]}`     |
| `GET /api/leaderboard`   | -                                                                                      | `{rows: [{rank, team_id, score}]}`                                                 |

`team_id` in the leaderboard is the human Team ID (`team_code`). Score is `score_override`, else `final_score`, else 0; **[B16: Since B16 the score is the derived official score (`app.team_scores`). See SCORING_AND_LEADERBOARD.md.]**
ties are ordered by the shorter final time, then Team ID. The board lists **every** team (rank 1 to N).

## 4. User interface

- **Super Admin** (`/superadmin`): sidebar "Create admin" only (Overview and Audit log removed). It opens the dialog
  "Create a New Admin" (Username, Password, Retype Password; Create, Go Back). Right column: Live Leaderboard.
- **Admin** (`/admin`): sidebar "Create a team" and "My teams"; the bottom line shows the Admin's user ID. "Create a
  team" opens "Create a New Team" (Team ID, Team Name, Login ID, Password, Confirm Password, M1–M4 Admission No.;
  Create Team, Go Back). "My teams" (`/admin/teams`) is a table of the Admin's own teams with a Go back button.
- Go Back only closes the dialog; nothing is sent. A second click or Enter while a request is in flight is ignored,
  and the fields are disabled. The browser keeps one `Idempotency-Key` per distinct form content and reuses it only
  after an unknown outcome (network failure, 5xx), so a request that did succeed is replayed instead of repeated.
- Messages are fixed wording chosen by the error code; server text is never displayed. Passwords are cleared after a
  success and never stored in the browser (no `localStorage` / `sessionStorage`).
- The leaderboard refreshes every 60 s while the tab is visible and keeps the last good rows if a refresh fails. **[B16: the leaderboard is a derived read (no snapshot table, no cron refresh), polled every 15 s with jitter. See SCORING_AND_LEADERBOARD.md.]**

## 5. Tests

| Layer      | File                                                                                  | Covers                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| SQL        | `supabase/tests/90_provisioning.test.sql`                                             | create admin/team, hashing, 500 coins + ledger, duplicates, rollback, validation, roles, ownership, idempotency, leaderboard, privileges |
| SQL (race) | `supabase/tests/concurrency/team_provisioning.concurrency.mjs`                        | retry storm (one key), two admins racing for one Team ID, name race, `create_team` vs `open`                                             |
| Unit       | `tests/unit/provisioning-{contracts,client,flow}.test.ts`                             | schemas, error mapping, HTTP slice with a fake database (roles, strict bodies, validation, duplicates, replay, no leaks)                 |
| Component  | `tests/component/{create-admin-dialog,create-team-dialog,staff-leaderboard}.test.tsx` | fields, errors, double click, Go Back, keys, leaderboard refresh                                                                         |
| Browser    | `tests/e2e/provisioning.spec.ts`                                                      | the central slice, validation, double click, HTTP authorisation, guards, axe                                                             |

The browser tests run the real application against the in-memory stand-in `tests/e2e/support/fake-postgrest.mjs`
(extended with the four functions). It mirrors the SQL; **the SQL is proven by the PostgreSQL tests above**, not by the
stand-in. For the one place where both meet (HTTP to real SQL) a throwaway PostgREST-shaped shim was used during
development; it is not part of the repository.

## 6. Production notes

- Apply migration 13 with the normal Supabase migration flow. It creates functions only; it does not read, change or
  delete any existing row, and it does not create a Super Admin.
- Created teams can sign in once the competition is `RUNNING` or `PAUSED` (B9/B10 rule), with Team Login ID, the
  team password and the member's own admission number.
- Known limits: an Admin cannot be disabled or have teams reassigned yet; a team password cannot be reset yet; the
  Super Admin does not see the per-Admin team lists.

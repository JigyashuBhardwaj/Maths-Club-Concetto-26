# SECURITY.md — Maths Club Concetto 26

Status: **proposal for review (Milestone 0).** Scope: a time-boxed, high-integrity competition with ~400 users, some of whom will try to gain an advantage. Fullscreen enforcement is a rules mechanism, **not** a security boundary.

## 1. Assets and adversaries

| Asset | Why it matters |
|-------|----------------|
| Coin balance, score, timers, question state | The competition's outcome |
| Question content and reviewer keys | Leaking locked questions or reference answers ruins the event |
| Other teams' answers | Collusion |
| Credentials (team, admin, Super Admin) | Impersonation, tampering with results |
| Audit log | Dispute resolution |

| Adversary | Likely attempts |
|-----------|-----------------|
| Curious/competitive participant | Edit client JS, replay/modify requests, change system clock, open DevTools, share answers, request other teams' data, double-click purchases, read locked questions |
| Participant with scripting skill | Race conditions, brute-forcing another team's login, scraping the API |
| Compromised or careless admin | Act on teams not assigned to them, approve own friends |
| External attacker | Credential stuffing, XSS via answer text, secret extraction |

## 2. Requirements (referenced by `TEST_PLAN.md`)

| ID | Requirement |
|----|-------------|
| SEC-01 | No secret (service-role key, JWT secret, cron secret, DB URL) is exposed to the browser or committed to Git |
| SEC-02 | Passwords are stored only as salted argon2id (or bcrypt cost ≥ 12) hashes; never logged |
| SEC-03 | Every API handler resolves the principal from the session and re-authorises the target object; no endpoint trusts a client-supplied team, member, role, score, time or balance |
| SEC-04 | Login throttling is per account, not per IP (campus NAT) |
| SEC-05 | Sessions are opaque, revocable, `HttpOnly; Secure; SameSite=Lax; __Host-` cookies with a hard expiry (12 h) |
| SEC-06 | All tables have RLS enabled and forced, with no policies for `anon`/`authenticated`; engine functions are executable by `service_role` only |
| SEC-07 | Locked question bodies, other teams' data and reviewer keys (`question_keys`: reference answer, solution notes) are never returned to a participant — in any question state, including `APPROVED` (previous questions show the team's own answer only). The body of an `AVAILABLE` question is withheld until it is activated by entering it |
| SEC-08 | There is no public registration route for any role; exactly one Super Admin can exist |
| SEC-09 | Destructive admin actions (reset score, disqualify) require a server-verified two-step confirmation and write an immutable audit event |
| SEC-10 | Every state-changing operation is idempotent and atomic |
| SEC-11 | User-generated text (answers, explanations, notes, team names) is rendered as text, never as HTML |
| SEC-12 | Demo data and demo credentials cannot exist in a production database |

## 3. Authentication

* **Participant:** `teamLoginId + password + admissionNo`. The admission number must belong to the team (join on `team_members`). All failure modes return the same message and take similar time (hash the supplied password against a dummy hash if the team does not exist, to avoid user-enumeration timing).
* **Staff:** `username + password`. Inactive accounts are rejected.
* **One live session per member** (partial unique index). A new login supersedes the old one; this is required for crash recovery (a frozen laptop must not lock the member out) and is audited.
* **Fullscreen exit** revokes the member's session immediately (`FULLSCREEN_EXIT`). Team progress is unaffected.
* **Logout and expiry** revoke the session row; the cookie becomes useless even if copied.
* **Realtime token:** a separate 10-minute JWT minted only for a valid session, containing no more than `team_id`, `member_id`/`staff_id` and `role`.

## 4. Authorisation matrix

| Action | Participant | Admin | Super Admin |
|--------|-------------|-------|-------------|
| Read own team state, questions of unlocked themes | ✔ own team only | — | — |
| Unlock theme, buy hint/time, save draft, submit, final submit | ✔ own team only, while `RUNNING` | — | — |
| Read leaderboard | ✔ | ✔ | ✔ |
| See assigned teams, members online, matrix | — | ✔ assigned only | ✔ all |
| Read submission + reviewer key | — | ✔ assigned teams only | ✔ |
| Approve / disapprove | — | ✔ assigned teams only | ✔ (`DEC-06`) |
| Create team | — | ✔ (assigned to self) | ✔ |
| Reset score / disqualify | — | ✔ assigned only, two-step | ✔ two-step |
| Create / disable admin, reassign teams, change competition status, adjust time | — | — | ✔ |
| Read audit log | — | — | ✔ (admin: own teams' events, optional) |

Authorisation is enforced **twice**: in the route handler (principal → allowed?) and again inside the engine function (which receives the principal and re-checks ownership), so a bug in either layer is not sufficient to cross a boundary.

## 5. Tamper-resistance (brief §37 "Security")

| Attack | Why it fails |
|--------|--------------|
| Change browser clock to extend time | No decision uses client time; deadlines are DB timestamps |
| Inflate coins/score in the request | Requests contain no balances or scores; the server computes both |
| Request Team B's state by changing an id | Principal's `team_id` comes from the session; the id in the URL is ignored or checked against it (`403/404`) |
| Read a locked question by guessing its id | `get_question_for_team` returns `THEME_LOCKED` unless the theme is unlocked and the question is not `LOCKED`; an `AVAILABLE` question returns metadata without the body |
| Open an approved "Previous" question to read the official answer | The participant query never joins `question_keys`; it returns only the team's own submission, its state and the reviewer's note |
| Buy a Tier 2 hint without Tier 1 | `buy_hint` rejects with `HINT_TIER1_REQUIRED`; a `hint_purchases` trigger rejects it again at the database |
| Escalate to admin | Role comes from `sessions`, which is written only by login functions; no client-controlled role field exists |
| Approve own team | Participants have no admin endpoints; admin ≠ participant sessions |
| Double-submit / double-buy | Idempotency key + status checks under lock + unique indexes |
| Replay an old approval request | `SUBMISSION_NOT_PENDING` |
| Brute-force a team password | Per-account throttle + exponential delay; admission number is a second unknown |
| Script autosave to hammer the server | Per-principal caps (§ API_SPEC 8) |
| Edit the draft while another submission is pending | `save_draft` requires `ACTIVE` |

## 6. Application hardening

* **XSS:** React escapes by default; Markdown is rendered with raw HTML disabled; KaTeX rendered with `trust:false`. Strict CSP: `default-src 'self'`; `script-src 'self'` (nonces if needed); `connect-src 'self' https://<project>.supabase.co wss://<project>.supabase.co`; `frame-ancestors 'none'`.
* **CSRF:** `SameSite=Lax` + `Origin` check on all non-GET.
* **Input limits:** server-side length limits mirror the database `CHECK` constraints.
* **Headers:** `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy: same-origin`, `Permissions-Policy` (fullscreen allowed for self).
* **Dependencies:** minimal; `npm audit` and lockfile review in CI; no postinstall scripts from unknown packages.
* **Errors:** generic messages to clients; detail only in server logs (never include passwords, tokens or full answers in logs).

## 7. Secrets and provisioning

* `.env*` is git-ignored from the first commit; a pre-commit/CI secret scan (`gitleaks`) blocks accidental commits.
* Environment variables are listed in `DEPLOYMENT.md` §4 with their scope (server-only vs public).
* **Super Admin** is created once by `npm run provision:superadmin`, which reads the username and password from the operator's terminal or environment, hashes them, inserts the row and prints nothing sensitive. The unique index guarantees there can never be two. Credentials are never in source, seeds, migrations or logs.
* **Admins** are created by the Super Admin through the UI; the Super Admin sees the initial password once.
* `seed:demo` refuses to run unless `APP_ENV` is `development`/`test` **and** the database host is not the production project (`SEC-12`); a release check queries for demo accounts (`is_demo` flag in a seed-only table, or the `DEMO_` code prefix) and fails the deploy if any exist.

## 8. Audit

* Written inside the same transaction as the change, so audit and state cannot diverge.
* Append-only: update/delete trigger plus revoked privileges.
* Covers every event in `STATE_MACHINE.md` §8 with actor, team, entity, before/after values and request id.
* Failed logins are audited (account key, IP, user agent) for post-event review.

## 9. Privacy

Stored personal data is limited to admission numbers, team names, admin display names and login metadata (IP, user agent). Retention: delete after the event closes, except aggregated results the club chooses to keep. Admission numbers are never shown to other teams and never appear in the leaderboard.

## 10. Pre-event security checklist

- [ ] No `.env` or key in Git history (scan whole history)
- [ ] Service-role key present only in Vercel server env
- [ ] RLS forced on all tables; `anon` cannot `select` anything (script-verified)
- [ ] Engine functions not executable by `anon`/`authenticated` (script-verified)
- [ ] Exactly one Super Admin; demo accounts absent
- [ ] Rate limits verified against the venue's shared-IP scenario
- [ ] Tamper tests `SE-01…SE-12` pass on the production-like preview
- [ ] Audit immutability test passes
- [ ] Backup and restore rehearsed once

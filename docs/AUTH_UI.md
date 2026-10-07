# Authentication UI and route guards (Patch B11)

B11 connects the sign-in pages to the B9 authentication backend and puts a server-side boundary around the three
role areas. It adds **no** database object, no new API endpoint, no new session store and no game rule.

## 1. The flow

```
Landing ─► /login/participant ─► POST /api/auth/participant/login ─► Set-Cookie __Host-session ─► /participant
           /login/admin        ┐
           /login/superadmin   ┴► POST /api/auth/staff/login       ─► Set-Cookie __Host-session ─► role home
```

- **Participant form:** Team Login ID, Team Password, Admission Number.
- **Staff form** (`/login/admin`, `/login/superadmin`): Username, Password. The page sends **no role**. After a
  successful login the browser goes to the home of the role the **server** reports (`ADMIN` → `/admin`, `SUPER_ADMIN` →
  `/superadmin`), whichever of the two pages the form was on. Admin credentials typed into the Super Admin page still
  yield an `ADMIN` session and land on `/admin`.
- The browser holds the session only as the `HttpOnly` cookie from B9. No token, role or credential is ever put in
  `localStorage`, `sessionStorage`, a URL or a global.
- Navigation after login is a full page load (`window.location.assign`), so the server renders with the cookie it was
  just given and no router cache can replay an earlier redirect.

## 2. Route protection design

Protected: `/participant`, `/participant/*`, `/admin`, `/admin/*`, `/superadmin`, `/superadmin/*`.
Public: `/`, `/login/*`, `/api/*` (each API route does its own check), static assets.

Two layers, deliberately different in strength:

| Layer                                                            | Where                                                                                                                    | What it checks                                                                                                                                                                                                                                    | Why                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Proxy** (`src/proxy.ts`, Next 16's replacement for middleware) | Every request to a protected path, including prefetch and RSC fetches                                                    | A well-formed `__Host-session` cookie exists. No cookie → redirect to that area's sign-in page. Everything it lets through is `Cache-Control: no-store`.                                                                                          | Fast, database-free pre-filter; the back button after sign-out cannot replay a cached page.                 |
| **Server guard** (`requireArea` in `src/lib/auth/guard.ts`)      | The layout **and** the page of every protected area (a layout does not re-render on client-side navigation; a page does) | The authoritative check: the cookie's token is hashed and resolved by `resolve_session` in the database (the same function behind `GET /api/auth/me`), then the role is compared with the area. Redirects; it never renders for a denied request. | One source of truth for "who is this"; role comes from the session row, never from the request or the page. |

Decisions are pure functions in `src/lib/auth/access.ts` (`areaForPath`, `decideAccess`), shared by both layers and
unit-tested for every role/area pair.

| Caller \ area | `/participant`  | `/admin`         | `/superadmin`    |
| ------------- | --------------- | ---------------- | ---------------- |
| not signed in | → sign-in page  | → sign-in page   | → sign-in page   |
| `PARTICIPANT` | allowed         | → `/participant` | → `/participant` |
| `ADMIN`       | → `/admin`      | allowed          | → `/admin`       |
| `SUPER_ADMIN` | → `/superadmin` | → `/superadmin`  | allowed          |

Each role owns exactly one area; there is no inheritance (a Super Admin does not browse `/admin`).

Behaviours worth knowing:

- A **forged but well-formed** cookie passes the proxy and is refused by the server guard (`resolve_session` says
  unknown) → redirect to the sign-in page. The proxy is a pre-filter, not the authority.
- An **expired, revoked, superseded or disabled-account** session is not authenticated: pages redirect, `GET
/api/auth/me` is `401`. The sign-in page then shows the form (the dead cookie is replaced on the next login and
  cleared on logout).
- **A failure to find out who someone is is never an answer.** If the database cannot be reached, a protected page
  responds `500` with the generic error page (no redirect, no content, no detail). The sign-in pages do not depend on the
  database to render, so people can try again.
- The sign-in pages are **static** (they read no cookie and call no API on load), so they render even when the
  database is down and the landing page can prefetch them. Someone who already holds a session and opens one simply sees
  the form; signing in again replaces a participant's session (one live session per member).
- A path that matches no page (for example `/admin/anything`) is a `404` once past the proxy; a visitor without a
  session is redirected to sign in first. No page content is exposed either way.
- Pages that need to know the principal later (B12+) call `getPrincipal()` / `requireArea()`; both are cached per
  request, so one database call serves the layout and the page.

## 3. Session restoration

- **On the server** (every protected request): `getPrincipal()` → `resolvePrincipalFromToken()` → `resolve_session`.
  `GET /api/auth/me` uses the very same function (`resolvePrincipal` is now a thin wrapper), so a page and the API can
  never disagree. Refresh and navigation therefore keep working for as long as the session is live (12 h).
- **From scripts** (e.g. a future client component that wants the principal): `GET /api/auth/me`.
- Nothing about the session is readable by script: the cookie is `HttpOnly`, and `GET /api/auth/me` returns only role,
  member/team or staff display data and the expiry (no token, hash, password or admission number).

## 4. Logout

`Sign out` (admin/superadmin sidebar, and a small corner button on the participant home) calls `POST /api/auth/logout`:
the session row is revoked (`LOGOUT`), the cookie is cleared, and **only after the server confirms** does the browser
go to the role's sign-in page. If the request fails (database down, network) the person stays where they are and is
told "Couldn't sign out. Please try again." — the UI never shows a signed-out page while the session is still live. A
copied cookie is dead after logout (`401`); typing a protected URL redirects to sign-in.

## 5. What the forms do

- Client-side validation uses the same Zod schemas as the API (required, trimmed, length limits) purely for friendlier
  messages; the server validates again and is the authority. Nothing is sent while a field is empty or too long.
- One request per attempt: the form ignores further submits while one is in flight and disables its inputs
  (`aria-busy`).
- Failures are shown from fixed wording, never from server text (`src/lib/auth/login-messages.ts`):

| API result                                                                                     | Message shown                                                       |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `401 UNAUTHENTICATED` (wrong team, password, admission number; inactive/unknown staff account) | "Those details don't match an account. Check them and try again."   |
| `429 RATE_LIMITED`                                                                             | "Too many attempts. Please wait N seconds and try again."           |
| `423 COMPETITION_NOT_RUNNING` (participants only)                                              | "The competition isn't open for sign-in right now. …"               |
| `400 VALIDATION_FAILED`                                                                        | "Please check the details you entered and try again."               |
| `403 FORBIDDEN` (origin check)                                                                 | "This request was blocked. Reload the page and try again."          |
| network error                                                                                  | "Couldn't reach the server. Check your connection and try again."   |
| anything else (`503`, unparsable body)                                                         | "Sign-in is temporarily unavailable. Please try again in a moment." |

An inactive staff account is indistinguishable from a wrong password by design (B9); there is no separate "blocked"
message to show.

## 6. Demo / development identities

`npm run provision:demo` follows the B9 `provision:superadmin` architecture; there is no migration and no credential in
the repository.

```
PROVISION_DATABASE_URL=postgres://owner@127.0.0.1:5432/concetto npm run provision:demo -- --teams 2 --open-competition
```

- Creates `demo_admin` (ADMIN, created by the existing Super Admin) and `--teams N` (1–4, default 1) teams
  `demo_team_01…` with code `DEMO_01…`, four members each (`DEMO0101…DEMO0104`), the competition's initial coins and the
  matching ledger row. Everything is `demo`-prefixed so the SEC-12 pre-event release check can find and fail on it.
- Passwords are random (120 bits), generated when the script runs, hashed **inside the database** (`app.hash_password`)
  and printed **once** to the terminal. They are not written to any file, environment variable or command line, and no
  hash is ever selected or printed.
- Re-running is safe: existing identities are left untouched and their passwords are **not** shown again;
  `--reset-passwords` gives them new random passwords.
- `--open-competition` opens SETUP → RUNNING as the Super Admin through `public.set_competition_status` (needs a team and
  the seeded 10 × 5 content). Participants cannot sign in while the competition is `SETUP`.
- Needs the Super Admin first (`npm run provision:superadmin`). Refuses: non-local hosts (unless
  `PROVISION_ALLOW_REMOTE=1`), `APP_ENV=production`, and a database that already holds non-demo teams (unless
  `PROVISION_DEMO_ALLOW_MIXED=1`). It asks for a typed `yes` unless `--yes`. **Never run it against production.**
- To sign in locally you also need `.env.local` (see `.env.example`): `NEXT_PUBLIC_SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_TOKEN_PEPPER`, `APP_ORIGIN`.

## 7. Tests

| Where                                                                                                 | What                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/auth-access.test.ts`                                                                      | Every role × area decision, path matching and look-alike prefixes                                                                                                                                                                                                      |
| `tests/unit/auth-proxy.test.ts`                                                                       | Matcher, redirect targets, malformed cookies, `no-store`                                                                                                                                                                                                               |
| `tests/unit/auth-guard.test.ts`                                                                       | `getPrincipal` / `requireArea`: no/malformed/unknown cookie, all 9 role × area outcomes, infrastructure failure is never "signed out"                                                                                                                                  |
| `tests/unit/auth-flow.test.ts`                                                                        | The real B9 handlers against the in-memory backend: login, restore, logout, supersede, expiry, throttle, role from server, disabled account, cross-site refusal; the stand-in satisfies the production Zod contracts and the real `supabase-js` client                 |
| `tests/unit/auth-client.test.ts`, `tests/component/login-form.test.tsx`, `…/sign-out-button.test.tsx` | Envelope parsing, message mapping, validation, duplicate-submit prevention, no leakage, role-based navigation                                                                                                                                                          |
| `tests/unit/provision-demo-identities.test.ts`                                                        | Planning, SQL shape (no hash read-back, quoting), report, refusals                                                                                                                                                                                                     |
| `tests/e2e/auth.spec.ts`                                                                              | Real browser: sign-in for all three roles, cookie flags, refresh/navigation, wrong credentials, validation, double click, competition not open, rate limit, sign-out, expired and superseded sessions, redirects (`307`), forged cookie, role isolation, public routes |

### How the browser tests get an authenticated session

`playwright.config.ts` starts two servers: an **in-memory stand-in for the Supabase endpoint**
(`tests/e2e/support/fake-postgrest.mjs`) and the **unmodified production build** of the app, whose
`NEXT_PUBLIC_SUPABASE_URL` points at the stand-in. There is no test switch inside the application. All identities, the
service key and the session pepper are generated at random for each run and live only in the process environment;
nothing secret is in the repository. A global setup signs member 1 of each test team in through the real login endpoint
and keeps that cookie (under `node_modules/.cache`) for the specs that open protected pages. Desktop and mobile use
different teams, because a new login of a member revokes that member's previous session (as in production).

The existing specs that open `/participant`, `/participant/theme/…`, `/admin` and `/superadmin` now start from a real
signed-in session (a few lines of setup each); none of their assertions changed. Both servers are started fresh for
every run (`reuseExistingServer: false`), because a server from an earlier run has other keys.

**Fidelity of the stand-in.** It implements the four B9 functions with the same rules and result shapes as the SQL
(throttle constants, one live session per member, 12 h expiry, generic failure, participant login only while the
competition is `RUNNING`/`PAUSED`), and `auth-flow.test.ts` pins its output to the production schemas. It is **not**
PostgreSQL or PostgREST: the SQL is proven by `supabase/tests/70_auth.test.sql`, and the combination was additionally
checked once by hand against the real SQL functions (see the B11 verification report).

## 8. Limitations

- The participant home and question pages still show **demo data**; B11 only protects them.
- The proxy checks cookie presence, not liveness; liveness is checked by the pages (by design, section 2).
- Safari and plain-HTTP LAN origins do not store `__Host-` cookies (B9 limitation, unchanged).
- Sessions are not refreshed or extended; they end 12 h after login (B9).
- There is no "remember me", password reset, or admin management UI.

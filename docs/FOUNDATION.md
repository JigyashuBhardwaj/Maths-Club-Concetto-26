# Foundation (Patch A)

What exists: Next.js 16 (App Router) + TypeScript strict + Tailwind v4, the landing page, reusable UI
primitives, placeholder app shells, test tooling, CI and security/config hygiene.
What does **not** exist: authentication, Supabase, schema, timers, coins, state machines, review engine,
submissions, UFM, realtime, leaderboard, authorization. Everything under `src/app/{participant,admin,superadmin}`,
`src/app/login/[role]` and `src/lib/contracts` is a placeholder or type-only contract.

## Layout

```
src/app/            routes (landing, login placeholder, 3 shell placeholders, /api/health)
src/components/ui/  primitives (Button, GlassPanel) — shadcn conventions (cva + cn)
src/components/landing/  landing page (server) + LandingStage (the only client boundary) + landing.css
src/components/shell/    AppShell + PlaceholderPage for future role interfaces
src/lib/            utils, roles, css helper, env (schema/server/public), webgl, contracts (types only)
src/config/         security headers / CSP (unit tested)
src/styles/         design tokens + base layer
tests/              unit, component (Vitest), e2e (Playwright + axe)
scripts/hygiene.mjs repo hygiene guard
```

## Commands

`npm run dev | build | start | lint | typecheck | test | test:e2e | format | format:check | hygiene | check`
(`check` = format:check + lint + typecheck + test + hygiene). Node >= 22.12 (`.nvmrc` = 22).

Browser tests: `npx playwright install chromium`, then `npm run test:e2e`. On a headless machine without a GPU
set `PW_SOFTWARE_GL=1`; to use an already-installed Chromium set `PW_CHROMIUM_PATH=/path/to/chrome`.

## Environment

Copy `.env.example` to `.env.local`. Only `APP_ENV` and `APP_ORIGIN` are used now (both have defaults).
Server variables are read only through `src/lib/env/server.ts` (`server-only`). A `NEXT_PUBLIC_` variable must
never hold a secret; `npm run hygiene` fails on secret-looking names. The Super Admin account is never configured
through env or source.

## Notes for later patches

- Guard `/participant`, `/admin`, `/superadmin` server-side; they are open placeholders today (marked noindex).
- CSP allows `'unsafe-inline'` scripts (Next hydration). Move to nonces once pages are dynamic.
- Extend CSP `connect-src` with the Supabase https/wss origins when Supabase is added.
- `docs/` from Milestone 0 predate the locked decisions (team timer starts at competition entry, question timers
  start when a question becomes ACTIVE and may run in parallel, UFM Disqualify = −1201, no reference answer
  after approval, Hint Tier 2 requires Tier 1). They need an amendment patch before backend work starts.

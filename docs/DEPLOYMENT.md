# DEPLOYMENT.md — Maths Club Concetto 26

Status: **proposal for review (Milestone 0).**

## 1. Environments

| Env | App | Database | Purpose |
|-----|-----|----------|---------|
| **local** | `next dev` | Supabase CLI stack in Docker, or a free cloud dev project (if Docker is unavailable on a team laptop) | Day-to-day development; engine tests with the test clock |
| **preview** | Vercel preview per branch/PR | **staging** Supabase project (shared) | Review and E2E of every patch before it can reach production |
| **staging** | Vercel preview/branch `staging` | Supabase **Pro** project, same region and compute as production | Load tests and the final dress rehearsal |
| **production** | Vercel production | Supabase Pro project | The competition |

Rules: preview/staging never point at the production database; production credentials exist only in Vercel's production environment and a password manager; the demo seed can only run against local/staging.

## 2. Plans and region (decisions `DEC-19`, `DEC-22`)

* **Supabase Pro minimum.** Free allows only 200 concurrent Realtime connections; the target is 300 (test at 400). Pro allows 500. Compute should be upgraded above the default for the event window; size it from the load test. Staging must match production or the load test proves nothing.
* **Region:** one region for both, near the users — proposed Mumbai (`ap-south-1`) for Supabase and `bom1` for Vercel functions — so each API call is a single short hop.
* **Vercel:** confirm that the chosen plan's function timeout/concurrency limits and the project's terms suit the event; the load test is the decider. Enable Vercel Fluid/regional function settings per current docs.
* Plan limits change; **re-verify the numbers on the day you subscribe** (this document recorded Supabase Realtime limits at the time of writing).

## 3. Source control and release flow

```
Claude workspace repo ──patch+notes──▶ human review ──apply──▶ official repo feature branch
      (disposable)                                                   │
                                                                     ▼
                                               PR → Vercel preview + staging DB → CI + E2E + manual check
                                                                     │
                                                           merge to main (protected)
                                                                     ▼
                                    migrations applied to production (human, `supabase db push`) → app deploy → smoke test
```

* Nothing in this workspace pushes to the official repository.
* `main` is protected: PR required, CI green.
* **Migrations are forward-only and applied before the app that needs them**, written backward-compatibly (add → deploy → remove) so a rollback of the app never meets an incompatible schema.
* No manual edits to the production database except through a reviewed migration or an audited super-admin function. Emergency SQL is written to the runbook log.

## 4. Environment variables

| Variable | Scope | Secret? | Used for |
|----------|-------|---------|----------|
| `APP_ENV` | server | no | `development` / `test` / `preview` / `production`; gates seeds and the test clock |
| `APP_ORIGIN` | server | no | CSRF `Origin` check |
| `NEXT_PUBLIC_SUPABASE_URL` | public | no | Realtime socket target |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | no (but useless without policies) | Realtime socket only; has no table access |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | **yes** | Calling engine functions |
| `SUPABASE_JWT_SECRET` (or signing key, per Supabase's current scheme) | **server only** | **yes** | Minting short-lived Realtime tokens |
| `SESSION_TOKEN_PEPPER` | server only | yes | HMAC pepper when hashing session tokens |
| `SUPABASE_DB_URL` | CI / local only | yes | Migrations and DB tests (never in the app runtime) |
| `SUPERADMIN_USERNAME`, `SUPERADMIN_PASSWORD` | operator's shell, **one-off** | yes | `provision:superadmin` only; never stored in Vercel or Git |

`.env.example` documents names without values. The build fails if a `NEXT_PUBLIC_*` variable has a name containing `SECRET`, `SERVICE` or `JWT`.

## 5. Database operations

* **Migrations:** `supabase/migrations/NNNN_name.sql`, forward-only. Local: `supabase db reset` rebuilds from scratch and runs seeds; CI does the same and then runs the DB test suite.
* **Scheduled jobs (`pg_cron`):** `expire_due_teams()` every 30 s; `refresh_leaderboard()` every 60 s; purge old `request_log` rows hourly. A health check reads `cron.job_run_details` and the Super Admin overview shows "sweeper last ran N s ago". If the sweeper stalls, lazy expiry still keeps rules correct; only idle-team finalisation and the leaderboard lag.
* **Seeds**
  * `npm run seed:content` — 12 themes, 60 questions, hints, reviewer keys. Idempotent; allowed everywhere; asserts counts.
  * `npm run seed:demo` — demo admins/teams; refuses unless `APP_ENV ∈ {development,test}` and the host is not the production project.
  * `npm run provision:superadmin` — interactive, one-time, credentials from the operator.
* **Backups:** Pro's daily backups (confirm retention) **plus** a manual `pg_dump` (a) before the event, (b) at the mid-event break, (c) immediately after. Dumps are stored encrypted off-platform. PITR add-on is recommended for the event month if available. **A restore must be rehearsed once** on staging and timed.

## 6. Observability (minimum viable)

Vercel function logs and error tracking; Supabase logs/`pg_stat_statements`; a Super Admin **overview page** showing active sessions, teams running, pending queue depth and oldest pending age, sweeper heartbeat, and Realtime connection count. During the event one person watches these, not the code.

## 7. Venue readiness

* Test from the actual venue Wi-Fi at the actual scale if possible (`SP-04`): can browsers open `wss://<project>.supabase.co`? Is the Vercel domain reachable? Is there a captive portal/proxy?
* All students share a public IP: confirm throttling is per-account (`SEC-04`).
* Fixed list of supported browsers (current Chrome/Edge/Firefox on laptops); a one-page "before you log in" instruction.
* Spare laptop + mobile hotspot for the organizer.

## 8. Incident runbook

| Situation | Action |
|-----------|--------|
| Venue network drops for everyone | Super Admin **pauses** the competition (freezes every clock); resume when stable |
| Supabase or Vercel outage | Server-side timers kept running, so time was lost: when service returns, pause, then use `adjust_team_time` to compensate (audited); announce policy beforehand |
| Student machine crashes | Student logs in again (supersedes the old session); state is intact |
| Team forgot password | Admin resets it (`reset_team_password`) |
| Admin unavailable | Super Admin reviews that admin's queue, or reassigns the teams |
| Wrong approval/rejection | Not reversible in default scope (`DEC-05`); use a compensating `ADMIN_ADJUSTMENT` ledger entry and note it in the audit |
| Suspected cheating | Admin uses UFM (two-step); evidence is the audit log |
| Leaderboard stale | Check sweeper heartbeat; run `refresh_leaderboard()` once manually |
| DB CPU/connections high | Pause; check slow queries; scale compute; resume |
| Need to deploy a fix mid-event | **Don't**, unless the competition is paused and the change is a one-line, previewed hotfix approved by two people |

## 9. Pre-competition checklist (brief §39)

- [ ] Final commit tagged; production deploy built from that exact commit
- [ ] Full E2E green on that commit; **load test at ≥ 300 (ideally 400) passed and report filed**
- [ ] Production env vars verified (names and scopes); no `NEXT_PUBLIC_` secrets
- [ ] Backups verified; a restore rehearsed; manual `pg_dump` taken
- [ ] **Demo accounts absent** (query returns zero) and `seed:demo` disabled in production
- [ ] **Exactly one Super Admin**, login verified; no default/seed credentials
- [ ] Real teams loaded: credentials delivered securely, each team's admission numbers verified, admin ↔ team assignments verified
- [ ] 12 themes × 5 questions present with correct costs, rewards, time limits, hints and reviewer keys (checked by `seed:content` assertions *and* a human read-through)
- [ ] Scoring verified on hand-computed fixtures in production-like data
- [ ] Final-submit and auto-end tested on a throwaway team
- [ ] Audit log writing and immutable
- [ ] Sweeper and leaderboard jobs running (heartbeat visible)
- [ ] Venue Wi-Fi/WebSocket check done
- [ ] Incident runbook printed; roles assigned (who watches dashboard, who can pause, who can restore)

## 10. Freeze (Milestone 12)

1. Tag `competition-freeze`; disable auto-deploy on production (Vercel ignored build step or deploy protection); restrict who can promote deployments.
2. Re-run the checklist on production with a throwaway team; delete that team after.
3. No code or schema changes during the event. Data operations only through the audited admin tools.
4. After the event: export results and audit log, take a final dump, then follow the retention note in `SECURITY.md` §9.

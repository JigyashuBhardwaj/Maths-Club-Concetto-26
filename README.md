# Maths Club Concetto 26 — Claude working repository

**Disposable workspace.** This is *not* the official repository
(`https://github.com/JigyashuBhardwaj/Maths-Club-Concetto-26`). Nothing here is pushed to it. Work is delivered as reviewable patches that the team applies, tests and commits themselves.

## Status

**Milestone 0 — Project analysis. No application code yet.**

| Read in this order | |
|--------------------|--|
| `docs/REVIEW.md` | **Start here.** Decisions needed, contradictions, risks, cutline, sequence |
| `docs/ARCHITECTURE.md` | The design in one place |
| `docs/DATA_MODEL.md` | Exact tables, constraints, indexes, invariants |
| `docs/STATE_MACHINE.md` | Every transition, and all critical competition operations as atomic PostgreSQL transactions |
| `docs/API_SPEC.md` | Endpoints, errors, idempotency, snapshot shape |
| `docs/REALTIME_SPEC.md` | Channels, events, presence, polling fallback |
| `docs/SECURITY.md` | Threats, authorisation matrix, hardening |
| `docs/TEST_PLAN.md` | Test matrix, concurrency tests, load tests |
| `docs/DEPLOYMENT.md` | Environments, env vars, runbook, freeze checklist |
| `docs/REQUIREMENTS.md` | Brief → design traceability |
| `docs/ECONOMY_AND_FINALIZATION.md` | Hints, Buy Time, Final Submit, the 4 h timer and how a team's end is persisted (Patch B15) |

Stopped for human review, as the brief requires.

## Evidence

`docs/evidence/schema.sql` is the DDL from `DATA_MODEL.md` and `docs/evidence/schema-smoke.sql` checks ten constraint behaviours. Both were run once against a scratch PostgreSQL 16 (11 expected rejections, all observed). They do not cover Supabase-specific features or the engine functions, which do not exist yet.

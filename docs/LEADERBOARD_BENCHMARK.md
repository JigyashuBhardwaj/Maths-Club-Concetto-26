# Leaderboard load benchmark (Phase B16)

Harness: `scripts/bench/leaderboard-bench.mjs` + `scripts/bench/pg-rest-shim.mjs`. Result files are plain JSON.
This benchmark was run **only against a local scratch PostgreSQL**, never against production or staging (the script refuses
any non-local database host).

**What the results do and do not show.** They show that, on the machine below, the actual leaderboard handler and the actual
SQL answer 300 simulated participants polling every 15 s (about 20 requests per second) with 100 teams and simultaneous
score-changing events, with zero errors, internally consistent snapshots and a deterministic ranking, at a median of about
10 ms. They are **not** a production capacity statement: see §6. The 300-participant target is therefore _exercised and met on
this local rig_; it is **not verified for the Supabase deployment**, which needs the same script run against a staging
project.

## 1. What is measured

- Real `next start` (production build) serving the real `/api/p/leaderboard` handler: Origin check → session
  (`resolve_session`) → role → `get_team_leaderboard` → whitelist → response.
- Real SQL: migrations 1–18, `app.team_scores_all`, the materialized ranking, `get_team_leaderboard`.
- A tiny Node PostgREST stand-in (`pg-rest-shim.mjs`) between the app and PostgreSQL, with a bounded connection pool
  (default 20), so the app's own `supabase-js` `.rpc` calls run unmodified.
- **100 teams** (95 started, 5 not started), **300 participant sessions** (3 members per team for 100 teams), seeded through
  the real endpoints (Super Admin → Admin → teams → participants).
- **Phases** 0. _Database only_: `EXPLAIN (ANALYZE)` of the ranking, 200 sequential calls, and `pgbench` (20 s, 300 connections) calling
  `get_team_leaderboard` directly.
  1. _Steady_: 300 clients poll the way the app does (15 s ± 20 % jitter, 90 s) while a writer per started team (95 writers)
     runs the real sequence through the API for theme 1: two hint purchases, five answer submissions and five Admin approvals
     (the fifth completes the theme) — 12 requests per team, 1,140 in total, all concurrent with the reads. The stress phase
     continues with theme 2 (unlock, enter, hints, answers, approvals: 14 requests per team, 1,330 in total).
  2. _Stress_: the same 300 clients in a closed loop with no waiting (30 s, another 1,330 writes). This is far above the real
     load (≈11× the target rate) and is there to find the limit, not to represent the event.
  3. _Quiet_: writers stopped; all 300 clients read at the same instant. All 300 answers must be identical and equal to an
     **independent recomputation** from the base tables (computed in the script, not by the SQL under test).
- **Every response of every phase is checked**: contiguous ranks 1..n, `me` equals its own row, started teams precede
  unstarted ones, order by score / minutes / Team ID, every score is one a legitimate state can produce, and no team's
  score moves backwards between that client's successive reads.

## 2. How to reproduce

```
npm ci
npm run build
npm i --no-save pg                  # the shim's PostgreSQL client; deliberately NOT added to package.json
BENCH_DB_ADMIN_URL=postgres://postgres@127.0.0.1:54318/postgres \
  node scripts/bench/leaderboard-bench.mjs \
  --teams 100 --unstarted 5 --clients 300 --steady 90 --stress 30 --pgbench 20 --pool 20 \
  --out bench-result.json
```

`BENCH_DB_ADMIN_URL` is the superuser URL of a **local** PostgreSQL ≥ 15 (the run creates and drops its own database,
`lbbench_<random>`). `pgbench` must be on the PATH for phase 0 (otherwise that part is skipped with a notice). Other flags:
`--interval` (poll interval ms, default 15000), `--app-port`, `--db-port`, `--keep-db`, `--no-writers`. A full run takes
about 5 minutes. The runs below used exactly the command above (runs 4–6).

## 3. Environment of the runs below

|                 |                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| Machine         | 2 × Intel Xeon @ 2.10 GHz (virtual), 8 GiB RAM, Linux 6.18                                               |
| Software        | Node v22.22.0, Next.js 16.3.8 (production build), PostgreSQL 18.4                                        |
| PostgreSQL      | `shared_buffers=128MB`, `max_connections=500`, `work_mem=4MB`, default everything else, local socket/TCP |
| Topology        | load generator, Next.js, DB shim and PostgreSQL **all on this one machine**                              |
| DB pool         | 20 connections in the shim                                                                               |
| Clock           | PostgreSQL clock pinned (the test clock), so minutes taken stay 0 and every check is exact               |
| App environment | `APP_ENV=test` (the app only honours the pinned test clock in that mode)                                 |

## 4. Results

Same command, same machine, three consecutive runs (6 = the third).

### Steady state: 300 clients at 15 s ± 20 %, 95 writers changing scores (90 s)

| Run | Reads | req/s | Errors  | avg ms | p50 ms | p95 ms | p99 ms | max ms | Writes (errors) |
| --- | ----- | ----- | ------- | ------ | ------ | ------ | ------ | ------ | --------------- |
| 4   | 1,823 | 20.3  | 0 (0 %) | 12.8   | 9.7    | 19.3   | 163.9  | 235    | 1,140 (0)       |
| 5   | 1,795 | 19.9  | 0 (0 %) | 10.7   | 9.5    | 18.1   | 27.6   | 54     | 1,140 (0)       |
| 6   | 1,869 | 20.8  | 0 (0 %) | 18.5   | 9.6    | 23.4   | 304.4  | 344    | 1,140 (0)       |

Machine CPU about 19 % in this phase. The p99 differs a lot between runs because it is decided by a handful of reads: in runs 4
and 6 the slowest dozen reads all started within the same few milliseconds near the end of the window (a coincident arrival
of many clients while writers were finishing), which the 1,800-sample p99 magnifies. The median and p95 are stable.

### Stress: same clients with no waiting (30 s) — not a realistic load, a limit probe

| Run | Reads | req/s | Errors | avg ms | p50 ms | p95 ms | p99 ms | Writes (errors) |
| --- | ----- | ----- | ------ | ------ | ------ | ------ | ------ | --------------- |
| 4   | 6,838 | 227.9 | 0      | 1,339  | 1,198  | 2,213  | 3,675  | 1,330 (0)       |
| 5   | 6,772 | 225.7 | 0      | 1,350  | 1,330  | 2,205  | 3,573  | 1,330 (0)       |
| 6   | 6,466 | 215.5 | 0      | 1,415  | 1,269  | 2,179  | 4,265  | 1,330 (0)       |

The single Next.js process saturates at roughly 215–230 requests per second on this box (machine CPU about 84 %; Next.js
about 22 CPU-seconds of the 30 s window), about 11× the 20 req/s the event needs. Latency here is queueing: 300 clients
keep 300 requests outstanding against one process.

### Database only

| Run | `EXPLAIN ANALYZE` ranking (20 runs) avg / p95 | 200 sequential `get_team_leaderboard` avg / p50 / p95 / p99 | `pgbench`, 300 connections, 20 s |
| --- | --------------------------------------------- | ----------------------------------------------------------- | -------------------------------- |
| 4   | 1.02 / 2.15 ms                                | 1.60 / 1.48 / 2.27 / 4.08 ms                                | 1,083 tps                        |
| 5   | 0.94 / 2.16 ms                                | 1.27 / 1.25 / 1.48 / 1.79 ms                                | 1,111 tps                        |
| 6   | 1.08 / 3.02 ms                                | 1.54 / 1.47 / 1.90 / 3.90 ms                                | 1,122 tps                        |

The ranking is about 1 ms of database time. During the steady phase the once-a-second sample of active database sessions
caught only a few sessions at all (run 4: 5 on CPU, 2 waiting on `IO:WalSync` from the score-changing writes); the database was
not the bottleneck. This is a sampling observation, not a full profile. Before the SQL changes of this
revision the same ranking took about 11 ms (an optional-team predicate inside the aggregation, two evaluations per request, a
non-inlinable `compute_score`); the current design is described in `docs/SCORING_AND_LEADERBOARD.md` §3.

### Quiet: after writers stop, all 300 clients read at once

| Run | Errors | Identical answers | Equals independent recomputation | Burst wall time |
| --- | ------ | ----------------- | -------------------------------- | --------------- |
| 4   | 0      | 300 / 300         | yes                              | 1.43 s          |
| 5   | 0      | 300 / 300         | yes                              | 1.35 s          |
| 6   | 0      | 300 / 300         | yes                              | 1.38 s          |

### Consistency (all phases, all three runs)

Zero violations in every counter: ranks, `me`, order, unstarted-not-last, illegitimate score, moved-backwards. Zero errors in
all reads and writes. The ranking is deterministic: with the data quiet, 300 concurrent reads returned one identical board
that matched the independent recomputation.

### Earlier runs (1–3) are not comparable

Runs 1–3 were made while the harness itself was still being corrected (keep-alive connection reuse in the load generator
produced stalls of 12–30 s in the stress phase, and the first runs predate the SQL change). They are not reported as
results. Their steady-state phases were also error-free, but they are not part of the evidence above.

## 5. Interpretation

- At the designed 15 s interval, 300 clients produce about 20 reads per second; each was answered with a median of about
  10 ms by the application and about 1.5 ms by the database on this rig, with no errors and consistent snapshots.
- A 5 s interval would triple the rate to about 60 req/s. That is still inside what this rig handled, but it buys little:
  scores change at most once a minute through the time penalty and on a player's own actions (which already trigger a prompt
  refresh). No evidence here justifies 5 s, so the default stays at 15 s.
- No server-side cache is used: with the read costing about 1 ms in the database there is nothing worth caching, and a cache
  would add staleness for penalties and frozen scores.

## 6. Limitations (why this is not production proof)

1. **One small machine** (2 vCPU, 8 GiB) runs the load generator, Next.js, the shim and PostgreSQL together; they compete for
   CPU. Production has a separate Supabase/PostgREST/Supavisor path and Vercel (or similar) application instances, so absolute
   numbers will differ in both directions.
2. **A shim instead of PostgREST and Supavisor.** The shim answers the same `.rpc` calls with a 20-connection pool; real
   PostgREST adds its own parsing, JWT checks and pool, and Supabase adds network latency between the app and the database.
3. **Pinned clock** (`APP_ENV=test`). Time does not advance, so minutes taken stay 0 and the benchmark does not exercise
   scores drifting through the time penalty; that is covered by `supabase/tests/150_scoring.test.sql`. The SQL cost does not
   depend on the clock value, but the benchmark does not prove it.
4. **Local network, no TLS, no CDN, no real browsers.** Clients are simulated HTTP clients, not browsers (no rendering, no
   tab-visibility behaviour; the poller's timing logic is unit-tested separately in `tests/unit/board-poller.test.ts`).
5. **Single Next.js process.** The stress phase saturates at about 220 requests per second. A production deployment will
   usually run several instances, but that was not measured.
6. **Keep-alive stalls under saturation.** In the saturating stress phase, reusing keep-alive connections to the Next server
   produced occasional stalls of 12–30 s (reproducible with both undici and `node:http`, absent with `connection: close`). The
   load generator therefore opens a fresh connection per read. I could not explain this inside Next/Node completely. It only
   appears at 10× the real load; the steady phase is unaffected, but it is unresolved.
7. **Data volume**: 100 teams × up to 12 questions × 3 members; a few thousand score events. The real event is about the same
   size, but table statistics, autovacuum and bloat of a long-lived database were not modelled.
8. `resolve_session` updates `last_seen_at` on every authenticated request (B15 behaviour, not part of B16), so every
   leaderboard poll is one session read-plus-write besides the ranking read. At 20 requests per second this is small, and it
   is included in the measured times, but it is a database write per poll that B16 did not introduce and did not change.
9. Runs 4–6 are three repetitions on the same machine; the spread (for example p99 28–304 ms in the steady phase) shows the
   tail latency is noisy. No confidence interval is claimed.

To verify the target for the real environment, the load must be driven against a **staging** deployment (Supabase project
and hosted application) with representative data and with explicit approval. This script cannot do that as it stands: it
refuses non-local databases on purpose and starts its own shim. A staging run would need its HTTP load and consistency
checks pointed at the staging URL; do not point anything at production.

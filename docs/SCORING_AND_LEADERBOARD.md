# Scoring, live leaderboard and UFM penalty (Phase B16)

Status: implemented in B16 (migration `20261006000018_scoring_leaderboard_penalty.sql`). It builds on the B15 timer and
finalization, which are **not** changed in behaviour. The Milestone-0 documents that described Reset and Disqualify
(`STATE_MACHINE` §5.9, `DATA_MODEL` §compute_team_score, `REVIEW` DEC-03/04/11/16, `API_SPEC`, `REQUIREMENTS`, `TEST_PLAN`) carry a
pointer to this page where B16 changed them.

## 1. The score

```
score = completed_themes × 500 + solved_questions × 100 + remaining_coins − minutes_taken × 5
```

- **completed_themes**: themes with all five questions `APPROVED`. **solved_questions**: `APPROVED` questions (an answer
  waiting for review does not count). **remaining_coins**: the team's balance, so a hint, a time pack or an unlock lowers
  the score and an approval reward raises it.
- **minutes_taken** = `round((timer_seconds − remaining_seconds) / 60)`, half up (7:29 → 7, 7:30 → 8), where
  `remaining_seconds` is the team clock (`least(now, ended_at, paused_at while paused)` against `ends_at`), clamped to
  `0..timer_seconds`. For a 4 h team this is `round(240 − remaining minutes)`; a legacy 2 h team is not charged for hours it
  never had. A team that has not started has 0 minutes, so it scores the formula's 500.
- The score may be **negative** (a team that spends and then runs the clock out ends below zero; the floor of the old
  design is gone).
- **Derived and dynamic.** There is no stored live score, no per-minute write and no cron. Every read derives it from the
  live rows in one SQL statement (`app.team_scores`).
- **Frozen at the terminal moment.** When a team becomes `FINAL_SUBMITTED` or `ENDED` (timer, competition end, or a
  penalty on a running team) `app.freeze_final_score` writes completed / solved / coins / minutes / score once into the
  existing `teams.final_*` columns. Final Submit and auto-expiry share this one function, so there is one basis and no drift
  afterwards. A late approval still pays its coins (B14) but cannot change the frozen score. An approval that arrives
  between a team's timer expiry and its persistence first ends the team at its own end (additive hook in
  `approve_submission`), so the freeze happens before the late reward.

## 2. Official score and the UFM penalty

`official_score = 0` if `ufm_penalized_at` is set, else `score_override` (only a never-built Disqualify would set it), else
the gameplay score above. The gameplay score and the whole history stay in the database; the penalty is an override.

**Penalise this team** (`public.penalize_team`, `POST /api/admin/teams/:teamId/penalize`):

- In **My Teams** the Admin clicks a Team ID; a dialog asks “Penalise this team?” with **Yes** / **No**. No (or Escape)
  sends nothing. Yes sends `{confirm:true}` with an `Idempotency-Key`.
- **Owner Admin only.** A participant gets 403, the Super Admin gets 403 (and no dialog), another Admin gets 404, no session
  401, a cross-site request 403, a missing key or a malformed body 400.
- A running team is ended through `app.expire_team` (reason `UFM_PENALTY`, at the team clock, so a paused team ends at its
  pause instant) and its score is frozen; a team that is already `FINAL_SUBMITTED` / `ENDED` is only marked. A team that has
  **not started** is refused (`TEAM_NOT_STARTED`, 409): there is nothing to penalise, and the rule that a penalty only exists
  on a terminal team is a table constraint.
- **Atomic, idempotent, audited.** One database call under the team lock. The same key replays; a different key on a team
  already penalised returns `changed:false` and writes nothing. One `UFM_PENALIZED` audit row (previous status, official
  score 0, the gameplay score it had). `ufm_penalized_*` can never be changed or cleared (trigger `UFM_PENALTY_IMMUTABLE`;
  a super-admin “revert” tool, if ever wanted, is a deliberate future migration).
- The team keeps its history; every participant action is refused with `TEAM_ENDED` / `ALREADY_SUBMITTED` as for any ended
  team; the participant board shows 0 for it.
- Not built (unchanged from earlier decisions): UFM **Reset** (superseded by this penalty) and **Disqualify** (−1201).

## 3. The leaderboard

- **Order:** teams that have started first; then official score descending, minutes taken ascending, Team ID ascending
  (code-point collation: `T11` before `T9`). Ranks are 1..n without gaps. Teams that have not started are listed after every
  started team, with the formula score (500).
- **One snapshot.** `app.leaderboard_rows` is a single statement, so rank, score and the participant's own line always come
  from the same MVCC snapshot. Ranking is server-side; the browser never re-sorts.
- **Participants** (`GET /api/p/leaderboard` → `get_team_leaderboard`): rank / Team ID / score of **all** teams plus `me`
  (the caller's own line, prominent at the top and highlighted in the table). View only. The result is a zod whitelist: nothing but rank,
  Team ID and score reaches the browser.
- **Admin and Super Admin** (`GET /api/leaderboard` → `get_leaderboard`): rank / Team ID / score of all teams.
- **Refresh** (`src/lib/home/board-poller.ts`, used by the participant board and the staff board):
  - **15 s default** (`LEADERBOARD_REFRESH_MS`), with **±20 % jitter** on every wait so 300 browsers drift apart. The time
    penalty changes scores with no gameplay event, so the periodic refresh stays.
  - **Pauses while the tab is hidden** (no requests at all). When the tab becomes visible again it refreshes if it missed a
    tick or its data is older than one interval, after a random 0–1 s delay, otherwise it resumes its rhythm.
  - **No overlapping requests.** While one is in flight another is never started; an event during flight is remembered and
    answered with exactly one follow-up. A request stuck for 20 s is abandoned and its late result ignored.
  - **Prompt refresh after local gameplay events** (the team's own state version changes: purchase, approval, theme
    completion), throttled to one request per 2 s.
  - **Failure** keeps the last good rows and doubles the next wait, up to 60 s.
  - **No Realtime, no push fan-out.** One plain `GET` per refresh.
  - **No server-side cache.** Decision: maximum staleness is **0**. A memo would have to be per serverless instance (instances
    share no memory), would not reduce database work in proportion, and would delay penalty visibility and frozen scores for
    nothing, because the measured read is cheap (see below and `docs/LEADERBOARD_BENCHMARK.md`). Revisit only with benchmark
    evidence from a staging environment.
  - Not changed to 5 s: that would triple the request rate (300 clients: 20 → 60 req/s) and the benchmark gives no evidence
    that it is needed.
- **Query cost design.** `app.compute_score` has no `SET` clause so the planner can inline it. `app.team_scores_all(now)`
  aggregates every team once; `app.team_scores(now, team_id)` filters that result (an optional-team predicate inside the
  aggregation made the generic plan roughly 10× slower). `get_team_leaderboard` computes the ranking once in a
  `MATERIALIZED` CTE that feeds both `rows` and `me`, so there is one evaluation and one snapshot per request.
- **Per request database work.** `resolve_session` (the existing session check, which also updates `last_seen_at`; this is
  B15 behaviour, not introduced by B16) plus one `get_team_leaderboard` / `get_leaderboard` call. No other query, no write
  from the leaderboard itself.
- **Scale.** 100 teams, 300 concurrent participants at 15 s is about 20 requests per second on average. One read per request,
  no locks (reads take the snapshot only). `team_scoring.concurrency.mjs` checks 200 concurrent reads, no torn scores and one
  freeze per team under load. `scripts/bench/leaderboard-bench.mjs` measures the real handler and the real SQL; its results
  and limits are in `docs/LEADERBOARD_BENCHMARK.md`.

## 4. Database objects

| Object                                                            | Purpose                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `teams.ufm_penalized_at`, `ufm_penalized_by`                      | The penalty (paired, terminal-only, immutable). `teams_final_cache_paired` keeps the `final_*` cache all-or-nothing.           |
| `app.compute_score(completed, solved, coins, minutes)`            | The formula, in one place.                                                                                                     |
| `app.team_scores_all(now)`                                        | Per team: parts, gameplay score, official score, penalised flag. Frozen `final_*` if present, else live. One aggregation.      |
| `app.team_scores(now, team_id?)`                                  | `team_scores_all` filtered to one team (or all).                                                                               |
| `app.freeze_final_score(team)`                                    | Idempotent terminal freeze.                                                                                                    |
| `app.leaderboard_rows(now)`                                       | The ordered rows.                                                                                                              |
| `public.get_leaderboard`, `get_team_leaderboard`, `penalize_team` | Service-role-only RPCs.                                                                                                        |
| Re-declared with one additive change                              | `app.expire_team` (+freeze), `final_submit` (+freeze), `approve_submission` (+expiry hook), `admin_matrix` (+`ufm_penalized`). |

The migration backfills the frozen score of teams that are already terminal (audit `SCORES_BACKFILLED`).

## 5. Tests

- SQL: `150_scoring` (formula, rounding, spend, approval, theme completion, pause, freeze, late approval, expiry boundary,
  negative score, tie-breaks, read authorization), `160_ufm_penalty`, `170_late_approval_at_expiry`, and the adjusted
  `90_provisioning` / `140_final_submit_freeze`. Concurrency: `team_scoring`. Upgrade: `b16_upgrade`.
- Unit / component: scoring contracts and handlers, the penalty dialog, the home leaderboard, My Teams, `board-poller` (jitter, hidden pause, no overlap, event refresh, backoff, watchdog).
- E2E: `scoring.spec.ts` (score vs spend/approval/theme, Final Submit and expiry freeze, ranking, boards on screen, penalty
  Yes/No, idempotency and authorization).

## 6. Decisions changed from Milestone 0

| ID     | Was                                                        | Now                                                                                      |
| ------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| DEC-03 | A late approval updates reward **and** score               | Reward is paid; the frozen score never changes                                           |
| DEC-04 | UFM Reset (score 0, team continues) and Disqualify (−1201) | Penalty: official score 0, team frozen, owner Admin only; Reset and Disqualify not built |
| DEC-11 | Exclude NOT_STARTED teams                                  | List them after started teams, formula score shown                                       |
| DEC-16 | minutes = `120 − floor(remaining/60)`                      | minutes = round(elapsed / 60), half up                                                   |

# REALTIME_SPEC.md — Maths Club Concetto 26

Status: **proposal for review (Milestone 0).**

## 1. Principles

1. **Realtime is a hint channel, not a data channel.** An event says *that* something changed (plus a version number), never *what* the new state is. The client reacts by fetching the authoritative snapshot over HTTPS. A lost, duplicated or out-of-order event is therefore harmless.
2. **The product must work with Realtime completely down.** A slow poll (15 s) is always running as a safety net; the fast path is a bonus. *(B15: the poll is the only path in use. When a polled snapshot says a team's timer reached zero, the server persists `ENDED` on that read — see `ECONOMY_AND_FINALIZATION.md` §5.)*
3. **Use Broadcast and Presence. Do not use `postgres_changes`.** It couples the UI to table shapes and performs per-subscriber authorisation work; it also makes the database a bottleneck for fan-out.
4. **Channels are scoped as narrowly as possible** so message volume stays far below plan limits (§7).
5. **Presence is informational only** (brief §24). It never changes competition state.

## 2. Event emission

Pings are emitted **inside the engine transaction** with `realtime.send(payload, event, topic, private)`. They are delivered only if the transaction commits, and cannot be lost because an API function died after commit. (`RISK-12`: the first spike confirms `realtime.send` is available on the project's Supabase version; fallback is a server-side broadcast call immediately after the RPC returns, with the poll covering any loss.)

All payloads are small and contain **no sensitive data**:

```json
{ "v": 42, "reason": "THEME_UNLOCKED" }
```

`v` is the team's (or competition's) `state_version`. A client that sees `v` lower than or equal to what it already holds ignores the event; a higher `v` triggers one re-fetch.

## 3. Channels and events

| Channel | Who subscribes | Events (broadcast) | Notes |
|---------|----------------|--------------------|-------|
| `team:{team_id}` | the team's ≤ 4 members; the assigned admin; the Super Admin | `team.state_changed {v, reason}` | Also hosts **presence** for that team (presence key = `member_id`). Members `track()`; admins only observe |
| `admin:{staff_id}` | that admin (and Super Admin for their own) | `admin.queue_changed {team_id, pending}`; `admin.member_violation {team_id, member_id}` | Drives the review inbox and a visible alert for fullscreen exits |
| `global` | every logged-in client | `leaderboard.updated {computed_at}`; `competition.status_changed {status, v}` | One message every ≤ 60 s for the leaderboard; rare for status **[B16: the leaderboard is a derived read (no snapshot table, no cron refresh), polled every 15 s with jitter. See SCORING_AND_LEADERBOARD.md.]** |

`reason` values (for debugging and for UX hints, never for logic): `TEAM_STARTED`, `THEME_UNLOCKED`, `QUESTION_STARTED`, `HINT_PURCHASED`, `TIME_PURCHASED`, `ANSWER_SUBMITTED`, `SUBMISSION_APPROVED`, `SUBMISSION_REJECTED`, `TEAM_FINAL_SUBMITTED`, `TEAM_ENDED`, `UFM`, `DRAFT_SAVED`.

Draft saves emit **no** event on the team channel (too chatty, and it would cause teammates' editors to churn). Teammates see a draft change only when they re-open the question or when a conflict is detected on save (`STALE_DRAFT`).

### 3.1 Authorisation

Baseline (works even if the private-channel spike fails): channel names include an unguessable UUID, payloads contain only a version and a reason, so a subscriber who somehow guesses a channel learns nothing useful, and any follow-up fetch is authorised by the session cookie.

Preferred (spike `SP-01`): **private channels** with a Realtime-authorisation policy on `realtime.messages`, using a **short-lived (10 min) JWT minted by our server** from the session (`team_id`, `member_id` / `staff_id`, `role` claims). The browser calls `supabase.realtime.setAuth(token)` and the client refreshes the token every 8 minutes via `GET /api/auth/realtime-token`. If the session is revoked, the next token request fails and the socket closes at expiry.

## 4. Presence

* Each participant, after login and entering fullscreen, joins `team:{team_id}` and calls `track({ member_id, since })`.
* Admins join the channels of their assigned teams read-only. An admin with 20 teams holds 20 channels on one socket (limit is 100 per connection).
* **Authoritative fallback:** the heartbeat (`POST /api/p/heartbeat`, every 25 s) updates `sessions.last_seen_at`; the `member_presence` view marks a member offline after 75 s. Admin dashboards display `online = presence OR heartbeat-fresh`, so a presence glitch cannot show a connected student as offline for long.
* Presence message volume is tiny: a team of 4 produces ~16 presence messages at join; 100 teams logging in over a minute produce ≈ 27 presence msg/s worst case, below Pro's 50/s. (A single global presence channel would produce ≈ 90,000 messages and break the limit — hence per-team channels, `A8`.)

## 5. Client lifecycle

```
login ─▶ GET /api/p/state ─▶ connect socket ─▶ join team + global channels ─▶ track presence
   │                                                  │
   │            ping(v > local v) ──────────────────▶ GET /api/p/state (debounced 250 ms)
   │            leaderboard.updated ───────────────▶ GET /api/leaderboard
   │            competition.status_changed ────────▶ GET /api/p/state
   │            socket closed / error ─────────────▶ enter POLL mode (state every 15 s, jittered ±3 s)
   │            socket reopened ───────────────────▶ GET /api/p/state once, leave POLL mode
   └──────── tab becomes visible ─────────────────▶ GET /api/p/state once
```

Rules:
* **Jitter** every poll and reconnect (random 0–3 s) so a venue-wide network blip does not produce a synchronised reconnect storm.
* **Debounce** re-fetches (250 ms) so a burst of pings causes one request.
* **Exponential backoff** on reconnect: 1, 2, 4, 8, 15 s (cap).
* The poll stays enabled even while the socket is up, but at a relaxed 60 s, as a safety net.

## 6. Leaderboard cadence

* A `pg_cron` job runs `refresh_leaderboard()` every 60 s (and on team finalisation, throttled to at most once per 10 s). It writes one row to `leaderboard_snapshot` and emits `leaderboard.updated` on `global`. **[B16: the leaderboard is a derived read (no snapshot table, no cron refresh), polled every 15 s with jitter. See SCORING_AND_LEADERBOARD.md.]**
* `GET /api/leaderboard` returns that row with `Cache-Control: public, s-maxage=20, stale-while-revalidate=30`, so 300 clients cause only a few database reads per minute. It is identical for everyone; each client picks out its own team's row locally.
* Because the score includes `−5 × minutes taken`, the live score of every running team legitimately changes every minute, which is exactly why the brief's "update every minute" is the correct cadence.
* Teams in `NOT_STARTED` are excluded (`DEC-11`). Ranking: score desc, then fewer minutes taken, then `team_code` for stability. **[B16: Changed in B16: NOT_STARTED teams are listed, after started ones. See SCORING_AND_LEADERBOARD.md.]**

## 7. Volume estimates against Pro limits (500 msg/s, 500 connections)

| Traffic | Estimate | vs limit |
|---------|----------|----------|
| Connections | 300–400 participants + ≤ 20 staff | ≤ 420 of 500 (84%) |
| Team pings | ~1 per purchase/submit/review; < 5/s overall × 4 recipients | < 20 msg/s |
| Leaderboard ping | 1/60 s × 420 recipients | ~7 msg/s **[B16: the leaderboard is a derived read (no snapshot table, no cron refresh), polled every 15 s with jitter. See SCORING_AND_LEADERBOARD.md.]** |
| Presence | login storm ≈ 27 msg/s for ~1 min; then ~0 | < 50/s |
| Staff alerts | negligible | — |

Headroom on connections is the tightest number, which is why the load test (`LT-03`) targets 400 sessions and why the **Free plan is ruled out**. If a deployment must stay under 500, a participant tab that is hidden for > 10 minutes may drop its socket and rely on polling (optional tuning knob).

## 8. Failure handling

| Failure | Behaviour |
|---------|-----------|
| Socket cannot connect (blocked by venue firewall) | POLL mode from the start; UI shows a small "live updates delayed" indicator after 30 s |
| Event lost / duplicated / reordered | Version comparison + periodic poll make it harmless |
| Realtime token expires | Client refreshes; on refusal (session revoked) it routes to login |
| Supabase Realtime outage | Poll mode; presence derived from heartbeats only |
| Reconnect storm after a network blip | Jitter + backoff + debounce; load test `LT-09` verifies |
| Hidden tab throttled by the browser | On `visibilitychange` perform an immediate re-fetch; countdowns are recomputed from absolute deadlines, so they are right immediately |

## 9. Spikes required before Milestone 5 (each ≤ 2 hours)

| ID | Question | If it fails |
|----|----------|-------------|
| SP-01 | Private channels authorised by a server-minted JWT (claims → `realtime.messages` policy) | Use public ping-only channels with unguessable names (baseline in §3.1) |
| SP-02 | `realtime.send` from within a `SECURITY DEFINER` function delivers only on commit | Broadcast from the API route after the RPC returns; rely on poll for gaps |
| SP-03 | Presence + 20 channels on one admin socket behaves under 400 simulated clients | Move admin online/offline to heartbeat-only |
| SP-04 | WebSocket reachability from the actual venue network | Poll-only mode (already supported) |

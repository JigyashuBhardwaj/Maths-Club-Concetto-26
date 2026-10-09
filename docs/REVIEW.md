# REVIEW.md — Milestone 0 findings: start here

This is the document to read first. It lists what must be decided, where the brief contradicts itself or is silent, what can go wrong, and what I recommend changing **before any code is written**. The other eight documents describe the design that follows from the recommended defaults below.

Nothing has been implemented. No application or test code exists. The only thing run is a smoke test of the database schema (see §10). The official repository has **not** been modified, and I could not read it (see §10).

---

## 1. Summary and recommendation

**The brief is implementable and the core idea is sound.** The hard parts are not the screens; they are (a) making money/time/state changes exactly-once under concurrency, (b) keeping 400 clients in sync without hammering the database, and (c) the amount of work against the deadline.

My recommendation, in one paragraph: put all competition rules in **Postgres functions** (one transaction per operation, team-level row lock, idempotency key, audit row and ping in the same transaction); keep the **Next.js layer thin**; treat **Realtime as a "something changed" ping only, with a 15-second poll as a safety net** so the product still works if WebSockets are blocked at the venue; use **per-account (not per-IP) login throttling** because the whole venue shares one IP; and use a **cached leaderboard snapshot**. Use **Supabase Pro** — the Free plan's 200-connection Realtime cap cannot serve 300 users.

Honest scope warning: the full brief is roughly **55–65 hours of focused work** by my estimate (§8). Two days with two or three parallel streams can deliver the **MUST** set comfortably and the **SHOULD** set if the content and decisions arrive early. The cutline is in §8; I'd rather you choose it now than discover it on competition day.

---

## 2. Questions for you (answer these before I start Milestone 1)

**Blocking now**

1. **Official repo scaffold.** I couldn't read it (not attached to this session). Please paste or attach: the file tree (two levels), `package.json`, the Next.js version, package manager (npm/pnpm/yarn), Node version, and whether Tailwind/shadcn/ESLint are already set up. Milestone 1 must be a patch that applies cleanly on top of what exists rather than a competing scaffold (`AMB-21`).
2. **Competition date/time and who is on the team.** How many hours remain, and how many people (and Claude sessions) can work in parallel? This decides the cutline.
3. **Content.** The numbers and text listed in §7 are on the critical path: without costs, rewards, time limits, hint costs and the 50 questions, the engine can be built but not verified end to end.
4. **Accounts.** Supabase **Pro** project(s) and a Vercel account/team (staging + production). Region preference (I propose Mumbai).
5. **Decisions marked ★ in §3** — I've written a default for each; reply only where you disagree.

**Needed before Milestone 7–8**

6. What students see **after** final submit/time-up (their score? rank? hidden until organisers reveal?). Not specified in the brief (`AMB-22`).
7. Text of the **Rules** screen (`AMB-23`).
8. Who reviews if an admin is absent, and how many admins/teams-per-admin you expect.

---

## 3. Decisions (each has a recommended default)

★ = affects the database schema or engine, so I want your explicit OK. Anything else I will proceed with the default and flag in the patch notes.

| ID | Decision | Recommended default | Why |
|----|----------|--------------------|-----|
| ★ DEC-01 | What starts a team's timer **(locked; B15 changed its length: 4 h for teams that start from B15 on, 2 h kept for teams already started — see `ECONOMY_AND_FINALIZATION.md`)** | The team timer (7,200 s = 120 min) starts when a participant actually **enters the competition interface**: after login, after acknowledging the rules, and after completing the fullscreen acknowledgement, the client calls *Enter competition*. Login never starts it. The first member to complete this starts it for the whole team; later members never restart it. The server is authoritative | A login-page glitch or a member just checking credentials must not burn a team's time |
| DEC-02 | Global gate | Participants can't log in while competition is `SETUP`; Super Admin presses **Open** (`SETUP→RUNNING`) at the start. Each team's timer starts when its first member enters the competition (`DEC-01`) | Stops early starts; uses the `competition.status` you asked for |
| ★ DEC-03 | Pending submissions when the team's time ends or it final-submits | Stay **reviewable** after the end; on approval the reward and score update, with minutes frozen at `ended_at`. Leaderboard marks the team "review pending" | Otherwise teams lose points because an admin was slow. Brief §18 ("no more submissions") is satisfied: no *new* submissions **[B16: Changed: a late approval pays coins but never changes the frozen score. See SCORING_AND_LEADERBOARD.md.]** |
| ★ DEC-04 | UFM semantics **(locked)** | **Reset score**: the official score becomes 0 *now* and the team **continues** (status `RUNNING`, timers, coins and progress untouched); points earned afterwards count normally from 0 (850 → Reset → 0 → earn 100 → 100). Implemented as a **baseline**, not an override: `teams.score_reset_at` + `teams.score_reset_baseline` (the raw score at that instant); official score = raw − baseline. **Disqualify**: official score −1201 (`score_override`), status `DISQUALIFIED`, team frozen, all later mutations rejected. Both need the server-verified two-step confirmation and are audited. A Super Admin "revert UFM" for mistakes stays a proposal, not default scope | Reset is a penalty, not an exit. **Locked rule:** a reset-adjusted score may never fall below −1200, so Disqualify (−1201) is always the lowest possible score and a non-disqualified team can never rank below a disqualified one (see `DATA_MODEL.md` §4) **[B16: Changed: UFM is a penalty (score 0, team frozen, owner Admin only); Reset and Disqualify are not built. See SCORING_AND_LEADERBOARD.md.]** |
| DEC-05 | Reverting a wrong approve/reject | Not in default scope; use a compensating `ADMIN_ADJUSTMENT` ledger entry | Reverting an approval after the next question started is a rabbit hole |
| DEC-06 | Super Admin can review any team | **Yes**, audited | Fallback when an admin is absent |
| ★ DEC-07 | Disapproval | Row kept as `REJECTED`; the team's **draft is kept** (locked UI-2.1 rule: the typed answer stays in the box and the button returns to red Submit, so members can study their mistakes); optional short reviewer note shown to the team | Supersedes the brief's "cleared" wording; history is kept for disputes |
| ★ DEC-08 | Buy time | Only while `ACTIVE` (not while pending); several configurable options (seconds + cost + optional cap) per question, the participant UI shows three (2/4/8 min = 20/40/80 coins as placeholder content); `expectedPurchaseCount` prevents double-clicks across members | Brief doesn't give pack size or limits |
| ★ DEC-09 | Hint tiers **(locked)** | **Tier 2 requires Tier 1** to have been purchased first (same question, same team); enforced in `buy_hint` and by a database trigger. Tier 1 stays freely purchasable; each hint is still paid once per team | Product decision |
| DEC-10 | "Previous" question **(amended)** | Enabled for approved questions in **read-only**; disabled for Q1. It shows only the team's **own** answer and explanation, the approval/rejection state and the reviewer's non-sensitive note. It **never** shows the official reference answer or solution notes (`question_keys`), in any state | Reference material must not leak to teams still working on other questions |
| DEC-11 | Leaderboard | Exclude `NOT_STARTED` teams (they'd otherwise score +500); rank by score, then fewer minutes, then team code | An unstarted team with 500 coins would outrank teams that played **[B16: Changed: every team is listed; teams that have not started rank after started ones with the formula's 500. See SCORING_AND_LEADERBOARD.md.]** |
| DEC-12 | Sessions | One live session per member; a new login supersedes the old; fullscreen exit revokes it; re-login needs the password again | Required for crash recovery |
| ★ DEC-13 | Team size / identifiers | 1–4 members; admission numbers **globally unique**; team ID and login ID unique | A student in two teams would break member identity |
| DEC-14 | Drafts | One **shared** draft per team+question with optimistic versioning; no live co-editing | Simple, loss-free; conflicts show a "teammate edited" notice |
| ★ DEC-15 | Question content format | Markdown with KaTeX math and optional images; answers remain plain text | Questions are mathematical; plain text would be unreadable |
| DEC-16 | "Minutes taken" | `120 − floor(remaining_seconds/60)`, clamped 0–120 | Brief says "integer minutes remaining" **[B16: Changed: minutes = elapsed (`timer_seconds − remaining`), rounded half up. See SCORING_AND_LEADERBOARD.md.]** |
| DEC-17 | Question timeout | Permanent for that question; the theme can never complete | As in brief §6/§12 |
| DEC-18 | Review latency fairness | Follow the brief (team clock keeps running while pending). Oldest-first queue, visible wait times, Super Admin overview shows slow queues | Cheap mitigation without changing rules; consider a "review SLA" at the event |
| DEC-19 | Supabase plan | **Pro** for production **and** staging | Free caps Realtime at 200 connections |
| DEC-20 | Where rules live | **Postgres functions**, TS layer thin | Atomicity, one round trip, testable with a controllable clock |
| DEC-21 | Auth | Custom session auth (opaque cookie + `sessions` table) for all roles | Login model doesn't fit Supabase Auth; instant revocation |
| DEC-22 | Region | Supabase Mumbai + Vercel `bom1` | Users are in India |
| DEC-23 | Realtime role | Ping + presence only; poll fallback | Robust to blocked WebSockets and lost messages |
| DEC-24 | Admin assignment | Team auto-assigned to creating admin; Super Admin can reassign; disabling an admin prompts reassignment | Matches brief; closes an unowned-queue gap |
| DEC-25 | Emergency tools | Super Admin **adjust team time** (audited) and **reset team password** (admin) | Needed to compensate outages / lost credentials mid-event; not in the brief |
| ★ DEC-26 | When a question timer starts **(locked)** | A question timer starts when that question becomes `ACTIVE` — **not** when its theme is unlocked. Unlocking a theme leaves Q1 `AVAILABLE` (no timer; body hidden). When a participant actually **enters/opens Q1**, the server atomically activates it (`start_question`: `AVAILABLE → ACTIVE`) and the timer starts. There is **no Start button**: `start_question` is a server-side operation triggered by entering the question, idempotent, so two members entering together activate it once and both get the same deadline. After an approval the next question becomes `ACTIVE` immediately and its timer starts. Several questions (in different themes) can be `ACTIVE` at once, each with its own timer | Needs a state between `LOCKED` and `ACTIVE` for Q1 so that unlocking does not start a clock |

---

## 4. Contradictions and ambiguities found in the brief

| ID | Finding | Resolution proposed |
|----|---------|---------------------|
| AMB-01 | §5 starts each team's clock on first entry; §27 introduces a global `SETUP/RUNNING` state without saying how they interact | `DEC-01`, `DEC-02` |
| AMB-02 | §16 says disapproval "clears" the answer; §28 wants every event reconstructable for disputes | Keep a `REJECTED` history row; the draft is **kept**, not cleared (`DEC-07`, locked UI-2.1) |
| AMB-03 | §18 "no more submissions" at timeout vs. submissions already awaiting review | `DEC-03` |
| AMB-04 | §17 final submit stops "all timers" but is silent on pending submissions | `DEC-03` |
| AMB-05 | §23 "reset score to zero" doesn't say whether the team keeps playing; −1201 is correctly one below the minimum natural score (−1200) | **Resolved by the product owner:** Reset → score becomes 0, the team continues and later points count from 0; Disqualify → −1201 and frozen (`DEC-04`; tests `SC-04`, `SC-07`…`SC-09`, `AD-10`, `AD-11`) |
| AMB-06 | §6 keeps the team clock running during review: a slow admin directly costs the team points | `DEC-18` |
| AMB-07 | §6/§14: question timers start on unlock whether or not anyone is working on it, so unlocking many themes starts many clocks. Possibly intended pressure, but surprising | **Resolved by the product owner:** a question timer starts when the question becomes `ACTIVE`, not on theme unlock; several timers may run at once (`DEC-26`) |
| AMB-08 | §19 score includes `−5/min`, so live scores fall every minute; unstarted teams would sit at +500 | `DEC-11` |
| AMB-09 | §3 gives the Super Admin "oversight" but §16 only lets the assigned admin review | `DEC-06` |
| AMB-10 | §15 "Previous" for completed questions is undefined | `DEC-10` (amended: own answer only, never the reference answer) |
| AMB-11 | §11 doesn't say whether tier 2 requires tier 1, or the costs | **Resolved by the product owner:** Tier 2 requires Tier 1 (`DEC-09`). Costs remain content data |
| AMB-12 | §12 gives no pack size, price, repeat limit, or behaviour while pending | `DEC-08` |
| AMB-13 | §22 "black/white = unavailable/failed" and "white = untouched" are ambiguous, and colour alone fails accessibility | Define a state→colour **and icon/label** table in the design system |
| AMB-14 | §25 fullscreen: F11 (browser fullscreen) is not the Fullscreen API and may not fire `fullscreenchange`; iOS Safari has no element fullscreen | Page itself requests API fullscreen on a click; supported-browser list; `RISK-07` |
| AMB-15 | §3/§4 four admission-number fields but "up to 4" members; uniqueness across teams unstated | `DEC-13` |
| AMB-16 | §26 autosave doesn't say whether the draft is per member or per team | `DEC-14` |
| AMB-17 | §10 "text only" answers, but the questions themselves are mathematical (notation, figures) | `DEC-15` |
| AMB-18 | §19 "integer number of minutes remaining" is floor or round? | `DEC-16` |
| AMB-19 | §3 teams per admin dynamic, but no reassignment or disabled-admin handling | `DEC-24` |
| AMB-20 | §29 suggests `seed:production`, §30 forbids credentials in source | Content seed is safe in production; Super Admin is **provisioned interactively**, never seeded |
| AMB-21 | §46: the official repo "contains the initial project setup", while Milestone 1 builds a foundation | Need the real scaffold first (§2 item 1) |
| AMB-22 | No post-final-submit screen, no result visibility rule | Ask (§2 item 6) |
| AMB-23 | "Rules" button is in the header but no rules text | Ask (§2 item 7) |

---

## 5. Risks

| ID | Risk | L | I | Mitigation |
|----|------|---|---|------------|
| RISK-01 | **Realtime connection cap:** Free = 200, Pro = 500 (verified against Supabase's published limits at the time of writing) vs. 300–400 target | H | H | Pro for prod and staging; load test `LT-03`; poll fallback |
| RISK-02 | Venue Wi-Fi blocks WebSockets / shared-IP lockouts | M | H | Poll mode built in; per-account throttling; test on-site (`SP-04`) |
| RISK-03 | **Content not ready** (50 questions, 100 hints, ~200 numbers, reviewer keys) | H | H | Content schema + validator early; seed script asserts completeness |
| RISK-04 | Two-day scope | H | H | Cutline (§8); vertical slice first; parallel work packages |
| RISK-05 | Docker/local Supabase hard to run on team laptops (Windows) | M | M | Cloud dev project fallback; tests can run against it |
| RISK-06 | Timer correctness (pause shift, lazy expiry, frozen timers) | M | H | Single time function, test clock, concurrency tests CC-01…08, invariant checker |
| RISK-07 | Fullscreen rule unreliable (F11, ESC, browser differences, accidental exits) | H | M | Page-initiated fullscreen; clear on-screen instructions; draft flushed before logout; admins alerted not punished automatically; supported-browser list |
| RISK-08 | Admin review bottleneck costs teams time | M | H | Oldest-first queue, wait-time display, Super Admin fallback, enough admins; `DEC-18` |
| RISK-09 | DB compute/connections undersized | M | H | RPC via PostgREST pooling; upgrade compute; load test decides |
| RISK-10 | Login storm (hashing CPU) at event start | M | M | Staggered start announcement; argon2 params tuned by load test `LT-01` |
| RISK-11 | Draft conflicts or lost typing | M | M | Versioned shared draft, save-on-blur/before-navigation, local backup |
| RISK-12 | Spikes unproven: private channels with custom JWT; `realtime.send` in functions | M | M | Spikes `SP-01/02` early; both have fallbacks (public ping channels / post-RPC publish) |
| RISK-13 | Vercel plan/function limits surprise under load | L | H | Load test on the exact plan |
| RISK-14 | Vendor outage mid-event | L | H | Pause + `adjust_team_time` runbook; backups; rehearsal |
| RISK-15 | Cheating beyond fullscreen (second device, shared answers) | H | M | Out of scope technically; audit log + admin UFM; say so plainly to organisers |
| RISK-16 | Patches won't apply cleanly to a scaffold I haven't seen | M | M | Get the scaffold (§2 item 1); milestone-sized patches |
| RISK-17 | Team may find PL/pgSQL harder to review than TypeScript | M | M | Docs describe each function step by step; SQL tests are executable specs; walkthrough of each patch |
| RISK-18 | Operator error live (wrong click) | M | M | Two-step confirmations, audit, runbook, super-admin revert for UFM |

(L = likelihood, I = impact: H/M/L.)

---

## 6. Recommended changes to the brief/plan before implementation

1. **Adopt the defaults in §3**, especially `DEC-03`, `DEC-04`, `DEC-07`.
2. **Use Supabase Pro** for production and staging (`DEC-19`).
3. **Put rules in SQL functions** and write the tests against a real database with a test clock (`DEC-20`).
4. **Make Realtime non-essential** (ping + poll) (`DEC-23`).
5. **Add Idempotency-Key to every mutation** and a `request_log` table.
6. **Throttle logins per account, not per IP.**
7. **Cache the leaderboard** as a snapshot row refreshed every ≤ 60 s. **[B16: the leaderboard is a derived read (no snapshot table, no cron refresh), polled every 15 s with jitter. See SCORING_AND_LEADERBOARD.md.]**
8. **Use per-team Realtime channels**; never a single global presence channel.
9. **Order the work as a vertical slice first** (login → enter → unlock → question → submit → approve, thin UI) rather than finishing all of the database, then all of auth, then all of the engine. It exposes integration problems on day 1 instead of day 2.
10. **Add the emergency tools** (`DEC-25`) and a `check_invariants()` function.
11. **Do not build the visual identity yet** (as instructed). One input already exists: the cinematic dark/orange landing page prototype made earlier in this session. I have *not* carried it into this workspace; whether it becomes the login/home foundation is a design-system decision once your references arrive.

---

## 7. Content and assets needed (critical path)

| Item | Count | Fields |
|------|-------|--------|
| Themes | 10 (A–J) | name, description, topics, difficulty, unlock cost |
| Questions | 50 (5 per theme) | body (Markdown + KaTeX; images allowed), difficulty, reward coins, time limit, buy-time options (seconds + cost + optional max purchases, three per question in the UI) |
| Hints | 120 | tier-1 and tier-2 text, cost each |
| Reviewer material | 50 | reference answer, solution notes (admin-only) |
| Rules text | 1 | for the Rules screen |
| Branding | — | Concetto logo (not yet supplied), Maths Club logo (have) |

I'll provide a JSON schema and a validator so the team can fill this in as a spreadsheet/JSON and get precise errors.

---

## 8. Scope cutline, work packages, sequence

### 8.1 Cutline

* **MUST** (a fair competition can run): schema + engine (start, unlock, hints, buy time, submit, approve/disapprove, timeouts, final submit, auto-end, scoring); three-role auth with member identity; participant home/theme/question/final UI; admin team matrix + review + add team; leaderboard (poll); audit logging; sweeper; deployment; E2E smoke; **load test at ≥ 300**.
* **SHOULD**: realtime pings + presence; fullscreen rule; UFM with audit; Super Admin UI; crash/network recovery polish; Rules screen.
* **COULD** (drop first): global pause UI (schema stays), adjust-time tool, audit viewer UI (query SQL instead), spiral/scroll animation polish, private-channel authorisation.

### 8.2 Work packages that can run in parallel once the contract is frozen

| WP | Content | Depends on | Est. hours |
|----|---------|-----------|-----------|
| A | Schema, content seed, engine functions, DB tests, invariant checker | — | 18–22 |
| B | Auth, sessions, API handlers, contracts, error mapping | A (schema), contracts | 8–10 |
| C | Participant UI (home, modal, question, final) | contracts, design system | 12–15 |
| D | Admin UI (matrix, review, add team, UFM) + Super Admin UI | contracts, design system | 10–12 |
| E | Design system + login/landing | UI references | 4–6 |
| F | Realtime, polling, heartbeat, presence | A, B | 5–6 |
| G | E2E, load tooling, deployment, freeze | everything | 10–12 |

Total ≈ 65–80 person-hours across streams; with three parallel streams that is roughly 25–30 elapsed hours, which is why the cutline matters. These are my rough estimates (±50%).

### 8.3 Proposed order (vertical slice first)

1. **Gate 0 (now):** this review → your answers (§2).
2. **Milestone 1 (≈ 2 h):** foundation patch on your real scaffold; `lib/contracts`; CI; secret scan.
3. **Milestone 2 (≈ 4 h):** schema, constraints, test clock, content seed, invariant checker.
4. **Slice (≈ 8 h):** auth for all roles + `start`, `unlock`, `submit`, `approve/disapprove` with minimal UI on both sides, proving the full loop end to end.
5. **Breadth:** hints, buy time, timeouts, sweeper, final submit, scoring, leaderboard, team creation, admin matrix.
6. **Realtime + recovery**, fullscreen, UFM, Super Admin.
7. **Design pass** when references arrive; **hardening, E2E, load test, staging rehearsal**.
8. **Production deploy → freeze.**

Each step ships as a milestone-sized patch with: what changed, why, files, DB changes, env vars, tests added and run (real output only), known limitations, the exact diff, manual test steps.

---

## 9. Assumptions I've made (tell me if wrong)

1. Participants use laptops/desktops with current Chrome, Edge or Firefox.
2. One competition, one event; no multi-tenancy.
3. Question content is final before the event and not edited live.
4. Admission numbers are unique per student and known when teams are created.
5. Up to 100 teams; roughly 10–25 admins.
6. Network from the venue can reach Vercel and Supabase (to be tested).
7. The team can pay for Supabase Pro/Vercel for the event period.
8. "Concetto logo" will be supplied; the Maths Club logo is the one already provided.
9. Answers are reviewed by humans; there is no auto-grading.
10. Times are shown in the viewer's local time zone; all storage is UTC.

---

## 10. What I could not do

* **Read the official repository.** GitHub access for it is not enabled in this session, and the brief says not to assume it is. I did not request access, to keep within "do not touch the official repository." If you want me to read it (read-only) tell me, or paste the tree and `package.json`.
* **Run the application or its tests.** There is no application code or test code yet. The one thing I did run: the DDL in `DATA_MODEL.md` was applied to a scratch PostgreSQL 16 and ten constraint behaviours were spot-checked (second Super Admin, duplicate admission number, negative coins, duplicate initial grant, duplicate theme unlock ledger row, second pending submission, timer/state mismatch, audit update/delete/truncate, two live sessions per member, mixed staff/member session). All behaved as designed. That does **not** cover Supabase-specific features (RLS roles, Realtime, `pg_cron`) or the engine functions, which do not exist yet. The scripts are in `docs/evidence/` so you can re-run them.
* **Verify non-Realtime plan limits** (Postgres compute connection counts, Vercel limits). They are called out as "verify" items rather than stated as fact.

**Per the brief, I am stopping here and waiting for your review.**

---

## 11. Amendment 1 — reconciliation with the locked decisions

Milestone 0 was written before these decisions were locked. This amendment edits the documents so they agree with them; nothing else about the architecture changed (Postgres-function engine, opaque-cookie sessions, ping-only Realtime with polling fallback, idempotency keys, team row lock, cached leaderboard, Supabase Pro).

| Locked decision | What changed | Where |
|-----------------|--------------|-------|
| Team timer starts when a participant actually enters the competition (after rules + fullscreen acknowledgement), not at login | Wording made explicit; login test added | `DEC-01`, REQ-010, STATE §3, §5.1, §6, API §4, TEST CE-01, CE-16 |
| Question timer starts when the question becomes `ACTIVE`, not on theme unlock; Q1 becomes `ACTIVE` when a participant enters it (no Start button) | **New state `AVAILABLE`** and **new server-side operation `start_question`**, triggered by entering Q1 (later questions still go `LOCKED → ACTIVE` on approval of the previous one) | `DEC-26`, DATA_MODEL §1/§3.7, STATE §4/§5.2/§5.2a, API §4/§7, TEST CE-17…CE-21, SE-14, E2E-10 |
| Multiple question timers may run simultaneously across questions/themes | Stated explicitly (it was implied); invariants and tests added | STATE §4, ARCH §6, TEST CE-19 |
| UFM Reset = score becomes 0 and the team continues (later points count from 0); Disqualify = −1201 and frozen | Reset is a **baseline** (`score_reset_at`, `score_reset_baseline`), not an override; Reset leaves `status` unchanged. `score_override` is now used by Disqualify only | `DEC-04`, STATE §3/§5.9, DATA_MODEL §3.3/§4/INV-12, API §5/§7, TEST SC-04, SC-07…SC-09, AD-10, AD-11 |
| Approved previous questions must not expose official/reference answers | `DEC-10` narrowed to the team's own answer, state and reviewer note; `question_keys` never reach participants in any state | `DEC-10`, SEC-07, API §4, TEST SE-13, E2E-11 |
| Tier 2 hint requires Tier 1 | Rule in `buy_hint` plus database trigger | `DEC-09`, STATE §5.3, DATA_MODEL §3.7, INV-11, TEST CO-11 |
| Canonical state names: questions `LOCKED, AVAILABLE, ACTIVE, PENDING_APPROVAL, APPROVED, TIMED_OUT`; submission review `REJECTED` | Docs already used these names; the Patch A type contract was aligned to them in a separate tiny amendment (A.2). Submission statuses are `PENDING, APPROVED, REJECTED`; team statuses `NOT_STARTED, RUNNING, FINAL_SUBMITTED, ENDED, DISQUALIFIED` | DATA_MODEL §1, `src/lib/contracts/competition.ts` |

Already consistent with the locked decisions and left unchanged: server-authoritative timers; question timer pauses at submit while the team timer continues; approval pays a fixed reward exactly once and starts the next question; disapproval keeps the history row, clears the draft and resumes from the paused point; a question timeout permanently fails that path; submissions made before time-up or final submit stay reviewable while no new ones are accepted (`DEC-03`).

### Rules added by the amendment

1. **Reset floor (locked by the product owner).** A reset-adjusted score is `greatest(−1200, raw − baseline)` and may never fall below −1200. Disqualification is always exactly −1201 and freezes the team, so a non-disqualified or reset team can never rank below a disqualified team. Schema, `INV-12` and tests `SC-08`/`SC-09` enforce it.
2. **Repeated Reset.** A second Reset re-zeroes the score from the then-current raw score (it is not a no-op) and is audited.
3. **Reset and Disqualify together.** Disqualify wins (`score_override = −1201`); the Reset baseline is kept for history.
4. **What "entering Q1" means.** Opening the question page (the client calls `POST /api/p/questions/:id/enter`). Merely viewing the theme's question list does not start the timer.

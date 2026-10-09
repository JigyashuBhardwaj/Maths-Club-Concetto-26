# REQUIREMENTS.md — traceability index

One line per requirement extracted from the Master Brief, with where this design satisfies it. Use it to confirm nothing was dropped. `§` = brief section. Where a requirement was clarified or changed, the decision is in `REVIEW.md`.

| ID | Requirement | § | Realised in |
|----|-------------|---|-------------|
| REQ-001 | Team-based competition; 4 members share one state | 2 | DATA_MODEL §3.3–3.4; ARCH §7 |
| REQ-002 | ≤ 300 concurrent users (test 350–400), ≤ 100 teams, ≤ 4 members | 2, 38 | ARCH §8; TEST_PLAN §5 |
| REQ-003 | Exactly one Super Admin, provisioned securely, never in source | 3, 30 | DATA_MODEL §3.2; SECURITY §7 |
| REQ-004 | Super Admin creates/disables admins; no public admin registration | 3 | API_SPEC §6; SEC-08 |
| REQ-005 | Admin manages dynamic assigned teams; adds teams | 3, 4 | API_SPEC §5; DEC-24 |
| REQ-006 | Participant login = team login ID + password + admission number | 3 | API_SPEC §3; SECURITY §3 |
| REQ-007 | Member identity & online/offline known | 3, 24 | DATA_MODEL §3.5, §4; REALTIME §4 |
| REQ-008 | Team creation form fields; auto-assignment to creating admin | 4 | API_SPEC §5 |
| REQ-009 | 500 coins at start | 5, 7 | DATA_MODEL §3.9 (`INITIAL_GRANT`) |
| REQ-010 | **B15: 4-hour (14,400 s) team timer for teams that start from B15 on; teams started earlier keep 7,200 s (stored per team in `teams.timer_seconds`).** The timer starts once, when a participant actually enters the competition (after rules and fullscreen acknowledgement) — never at login; same for all members | 5 | STATE §5.1; DEC-01 |
| REQ-011 | Timer authoritative on server; browser never authoritative | 5, 6, 18 | ARCH §6; STATE §1.3 |
| REQ-012 | Team timer continues during pending, browsing, logout | 6 | STATE §4 |
| REQ-013 | Question timer starts when the question becomes `ACTIVE` (Q1: when a participant enters it; later questions: on approval of the previous one) — not on theme unlock; several may run at once; pauses at submit; resumes on disapproval | 6, 16 | STATE §4, §5.2a, §5.6–5.7; DEC-26 |
| REQ-014 | Question timeout blocks theme progression; theme greyed | 6 | STATE §4; DEC-17 |
| REQ-015 | Shared coins; atomic, server-authoritative changes; ledger + cached balance | 7 | DATA_MODEL §3.9; STATE §5 |
| REQ-016 | 10 themes (A–J) × 5 questions = 50 questions + Final Submit ticket (11 tickets) | 8 | DATA_MODEL §3.6; DEPLOY §9 |
| REQ-017 | Theme unlock shared by whole team; parallel work on different themes | 8 | STATE §5.2 |
| REQ-018 | Ordered questions; N+1 only after N approved; explicit states | 9 | STATE §4 |
| REQ-019 | One pending submission per team/question; no resubmit while pending | 9 | DATA_MODEL §3.8 (partial unique index) |
| REQ-020 | Text-only answer + explanation (multiline) | 10 | DATA_MODEL §3.8; DEC-15 |
| REQ-021 | Two hint tiers, cost coins, shared, never paid twice; Tier 2 requires Tier 1 | 11 | DATA_MODEL §3.7; STATE §5.3; DEC-09 |
| REQ-022 | Buy extra question time with coins; only before zero; question timer only | 12 | STATE §5.5; DEC-08 |
| REQ-023 | Student home layout: logos, timer, coins, rules, leaderboard, 10 theme tickets + Final = 11 tickets | 13 | (UI milestone; design-system pending references) |
| REQ-024 | Theme unlock modal flow | 14 | API_SPEC §4; STATE §5.2 |
| REQ-025 | Question page contents and Previous/Next rules; previous (approved) questions show the team's own answer only, never the reference answer | 15 | API_SPEC §4, §7; DEC-10; SEC-07 |
| REQ-026 | Submission → admin review → approve/disapprove with fixed reward | 16 | STATE §5.7 |
| REQ-027 | Final submit: confirm, freeze, score server-side, atomic, idempotent | 17 | STATE §5.8 |
| REQ-028 | Auto-end at 0 enforced server-side; score saved | 18 | STATE §5.4 |
| REQ-029 | Official score formula, server-side | 19 | DATA_MODEL §4 |
| REQ-030 | Live leaderboard, ~1-minute refresh, DB-friendly at 300 users | 20 | REALTIME §6; DATA_MODEL §3.12 **[B16: the leaderboard is a derived read (no snapshot table, no cron refresh), polled every 15 s with jitter. See SCORING_AND_LEADERBOARD.md.]** |
| REQ-031 | Admin UI: leaderboard, status, My Teams, Add Teams, matrix with colours | 21, 22 | API_SPEC §5; AMB-13 |
| REQ-032 | UFM: Reset score → 0 and the team continues (later points count from 0); Disqualify → −1201 and the team freezes; two-step, audited | 23 | STATE §5.9; SEC-09; DEC-04 **[B16: Changed: Penalise (Yes/No): official score 0 and the team frozen; no Reset, no Disqualify. See SCORING_AND_LEADERBOARD.md.]** |
| REQ-033 | Fullscreen exit logs out that member and informs admin; progress kept | 25 | STATE §6; API_SPEC §3 |
| REQ-034 | Crash/network recovery; debounced autosave; DB authoritative | 26 | ARCH §9; API_SPEC §4 (draft) |
| REQ-035 | Global SETUP/RUNNING/PAUSED/ENDED designed into the timer engine | 27 | STATE §2 |
| REQ-036 | Audit log of all important events | 28 | DATA_MODEL §3.11; STATE §8 |
| REQ-037 | Demo seed separate; never in production | 29 | DATA_MODEL §8; SEC-12 |
| REQ-038 | Security rules (no client trust, team isolation, hashed passwords, RLS…) | 30 | SECURITY |
| REQ-039 | Stack: Next.js/TS, Tailwind, Supabase, Vercel; no microservices | 31 | ARCH §11 |
| REQ-040 | Design system before final UI; one coherent language | 33, 45 | ARCH §10 (`design-system/`); REVIEW §6 |
| REQ-041 | Documented state machines; centralised transitions | 35 | STATE_MACHINE |
| REQ-042 | Atomic + idempotent operations (the brief's eleven named functions plus `start_question`) | 36 | STATE §1, §5; API_SPEC §1 |
| REQ-043 | Test coverage list | 37 | TEST_PLAN §3 |
| REQ-044 | Load test before production; no unproven claims | 38 | TEST_PLAN §5 |
| REQ-045 | Preview → staging → production; freeze | 39 | DEPLOYMENT §1, §9, §10 |
| REQ-046 | Milestone roadmap; no big-bang | 40 | REVIEW §8 |
| REQ-047 | Isolated workspace; patch discipline; never push to official repo | 41, 42 | README; DEPLOYMENT §3 |
| REQ-048 | UI and backend developed together, feature by feature | 43 | REVIEW §6 (vertical slice) |
| REQ-049 | First task = analysis only, then stop | 44 | REVIEW §10 |

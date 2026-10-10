# Official Concetto 26 content (Phase B17)

Status: implemented in B17 (migration `20261006000019_official_content.sql`). It builds on B16 and changes **no** gameplay,
timer, coin, scoring or authorization code. Everything here is _content_: the ten theme names and descriptions, the fifty questions, the
hundred hints, the per-question rewards and the eight rules, taken from `content to upload(2).docx`.

## 1. One source, generated copies

```
content to upload(2).docx
  └─ scripts/content/extract-docx.py (raw dump, for review) → human-reviewed, normalised ─►  content/concetto26/official-content.json   (THE source of truth)
                                              └─ scripts/content/generate.mjs ─►  supabase/migrations/20261006000019_official_content.sql
                                                                              └─►  src/lib/content/official-public.ts   (themes + rules only)
```

- `node scripts/content/generate.mjs` writes both files; `--check` fails when either has drifted. `tests/unit/official-content.test.ts` runs the same
  check, so a hand edit of a generated file, or a JSON change without regeneration, fails the unit tests.
- The JSON records the source file's SHA-256 and the two owner-approved deviations (section 6).
- **Questions, hints and rewards never reach client code.** They are in the migration (database) only. The browser bundle
  receives only theme names/descriptions and the rules (public by nature). A unit test scans `src/` and fails if any question or hint text appears there.
- `supabase/seed.sql` is unchanged: it stays the placeholder fixture the existing SQL tests and CI use. Official content is applied by migration 19.
- The e2e in-memory backend (`tests/e2e/support/fake-gameplay.mjs`) reads the same JSON, so browser tests exercise the real text and rewards.

## 2. Content inventory

| Item                                                                     | Count | Verified by                                                                                   |
| ------------------------------------------------------------------------ | ----: | --------------------------------------------------------------------------------------------- |
| Themes (A-J) with official name and description                          |    10 | `official-content.test.ts`, `180_official_content.test.sql`, `b17_upgrade`                    |
| Questions (A.1 ... J.5, five per theme, in document order)               |    50 | same                                                                                          |
| Hints (two per question, tier 1 and 2)                                   |   100 | same                                                                                          |
| Per-question rewards (sum 4230; distinct values 50, 60, 70, 80, 90, 100) |    50 | same                                                                                          |
| Rules and regulations                                                    |     8 | `official-content.test.ts`, `home.test.tsx`, `participant-home.spec`, `official-content.spec` |

### Themes

| Id  | `themes.id` | Official name (ticket and dialog heading)       | Official description (theme dialog)                                 |
| --- | ----------: | ----------------------------------------------- | ------------------------------------------------------------------- |
| A   |           1 | DIG INTO THE PASSWORD OF IIT ISM                | ADVANCED CRYPTOGRAPHY, NUMBER THEORY & COMBINATORICS                |
| B   |           2 | HOW BAD CAN BE HOSTEL FOOD                      | PROBABILITY, STATISTICS, OPTIMIZATION AND QUEUING THEORY            |
| C   |           3 | END SEM FEAR TAKEOVER                           | Engineering Mathematics, Calculus, and Differential Equations       |
| D   |           4 | WHAT IS THE SIZE OF THE CAMPUS?                 | Geometry, Distance and Measurement, and Coordinate Geometry         |
| E   |           5 | WHO IS THE POKER GUY HERE                       | Probability, Combinatorics, Game Theory, and Derangements           |
| F   |           6 | ASK OUT YOUR CRUSH                              | PROBABILITY AND STATISTICS                                          |
| G   |           7 | I WANT A STRAIGHT TRAJECTORY IN LIFE            | Linear Systems, Geometry, Infinite Products, and Integrals          |
| H   |           8 | IS THE GUARD CHASING YOU?                       | Coordinate Geometry, Conics, Vectors, and Relative Motion           |
| I   |           9 | WHAT AMOUNT TO PUT IN PAY REQUEST TO MY SENIORS | Probability, Optimization, Geometric Distributions, and Game Theory |
| J   |          10 | DO YOU HATE PROVING YOURSELF?                   | Mathematical proofs, logic, induction, and contradiction            |

The internal ids A-J stay the keys of routes, API and database. The display name is never used as an identifier.

### Rules (home page `i` icon)

|   # | Text (word for word; rule 2 carries the approved correction in section 6)                                                                                                                                                                                                                                                                                                                                 |
| --: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Every team will start with 500 coins. These coins can be spent on buying themes, purchasing additional time, and buying hints for questions. Spend them wisely.                                                                                                                                                                                                                                           |
|   2 | Once a team proceeds to a question, the timer starts and will not stop during active solving. Each question has a base time limit of 4 minutes. Teams may purchase additional time using their coins. If the time runs out on a question, that theme is considered exhausted.                                                                                                                             |
|   3 | A team cannot proceed to question X+1 without solving question X. No skipping ahead.                                                                                                                                                                                                                                                                                                                      |
|   4 | Teams must submit their answer along with a text explanation. We very well know how to identify AI-generated texts, so make sure your explanation genuinely reflects your own reasoning. After submission, wait for approval from your respective admin. During this phase, the timer is paused. If the solution is rejected, the timer resumes. If it is approved, you may move on to the next question. |
|   5 | There are 10 themes to choose from. The topics covered by each theme will be displayed before you buy it. Make optimal choices based on your strengths, available coins, and time.                                                                                                                                                                                                                        |
|   6 | Use your own brain rather than AI or any other external means. If any team is found violating the rules, the admins have the authority to impose penalties, including decreasing the score—potentially to 0.                                                                                                                                                                                              |
|   7 | Do not abuse or harass admins if they take time to approve your submissions. Admins are people too. You may, however, bribe your admin into approving your wrong solutions (highly recommended).                                                                                                                                                                                                          |
|   8 | Do not try to mess with the website or start playing with the spiral theme effect. Utilise your 4-hour time wisely.                                                                                                                                                                                                                                                                                       |

### Rewards by theme

| Theme | A.1 ... .5                  | Sum |
| ----- | --------------------------- | --: |
| A     | 100 / 100 / 100 / 100 / 100 | 500 |
| B     | 70 / 70 / 90 / 60 / 100     | 390 |
| C     | 70 / 80 / 80 / 90 / 90      | 410 |
| D     | 100 / 60 / 90 / 50 / 90     | 390 |
| E     | 70 / 80 / 90 / 60 / 100     | 400 |
| F     | 70 / 70 / 90 / 90 / 100     | 420 |
| G     | 80 / 90 / 90 / 50 / 100     | 410 |
| H     | 70 / 90 / 90 / 90 / 100     | 440 |
| I     | 90 / 100 / 80 / 80 / 100    | 450 |
| J     | 80 / 90 / 70 / 90 / 90      | 420 |

## 3. Mapping: document ID -> database record -> UI location

ID rules (unchanged from `supabase/seed.sql`): `themes.id` = theme number (A=1 ... J=10); `questions.id` = (theme number - 1) x 5 + ordinal;
`hints.id` = (question id - 1) x 2 + tier.

| Content           | Database                                                              | UI                                                                                       |
| ----------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Theme name        | `themes.name` (and the generated `OFFICIAL_THEMES`)                   | ticket label and tooltip (`ticket-spiral.tsx`), theme dialog heading, question page `h1` |
| Theme description | `themes.description` (team snapshot, `team_state`)                    | theme dialog body                                                                        |
| Rule 1-8          | not stored (public text, `OFFICIAL_RULES`)                            | rules dialog (`rules-dialog.tsx`), numbered list                                         |
| Question text     | `questions.body_md`, returned only after the team enters the question | question page `.q-text` via `ContentText`                                                |
| Hint text         | `hints.body_md`, returned only to a team that owns the hint           | hint dialog via `ContentText`                                                            |
| Reward            | `questions.reward_coins`, paid by `approve_submission`                | question page "Reward" tile (server value); My Teams approval message                    |

| Doc ID | `questions.id` | `hints.id` (tier 1 / 2) | Reward | Opens as                 | Question starts with                                                    |
| ------ | -------------: | ----------------------: | -----: | ------------------------ | ----------------------------------------------------------------------- |
| A.1    |              1 |                   1 / 2 |    100 | `/participant/theme/A/1` | A message intercepted from the campus network has been encoded in two … |
| A.2    |              2 |                   3 / 4 |    100 | `/participant/theme/A/2` | A client and server use a small demonstration setup to recover a sessi… |
| A.3    |              3 |                   5 / 6 |    100 | `/participant/theme/A/3` | A critical network router processes an array of N = 12 data packets. D… |
| A.4    |              4 |                   7 / 8 |    100 | `/participant/theme/A/4` | An array A of size N = 1000 represents millisecond network delay spike… |
| A.5    |              5 |                  9 / 10 |    100 | `/participant/theme/A/5` | A campus data center routes traffic from n = 6 input lines {L1, L2, L3… |
| B.1    |              6 |                 11 / 12 |     70 | `/participant/theme/B/1` | The hostel mess has one serving counter. Students arrive according to … |
| B.2    |              7 |                 13 / 14 |     70 | `/participant/theme/B/2` | Using q = 0.5, find the expected sum of the queue-waiting times of all… |
| B.3    |              8 |                 15 / 16 |     90 | `/participant/theme/B/3` | The warden defines the dissatisfaction cost per student as D(q) = Wq(q… |
| B.4    |              9 |                 17 / 18 |     60 | `/participant/theme/B/4` | Each dinner is independently bad with probability 1/3 and good with pr… |
| B.5    |             10 |                 19 / 20 |    100 | `/participant/theme/B/5` | The mess committee surveys satisfaction scores in two hostels using st… |
| C.1    |             11 |                 21 / 22 |     70 | `/participant/theme/C/1` | For each positive integer n, let Pₙ = ∏ₖ₌₁ⁿ(1 + tan(kπ/(4n))). Define … |
| C.2    |             12 |                 23 / 24 |     80 | `/participant/theme/C/2` | Using the value of a from Q3.1, find b = Σₙ₌₁^∞ n^(a/2)/2ⁿ.…            |
| C.3    |             13 |                 25 / 26 |     80 | `/participant/theme/C/3` | Find c = (120/(11e)) limₓ→₀ [((1 + x)^(1/x) − e + ex/2)/x²].…           |
| C.4    |             14 |                 27 / 28 |     90 | `/participant/theme/C/4` | Let M be a c × c matrix whose entries are mᵢⱼ = \|i − j\|. Find d = de… |
| C.5    |             15 |                 29 / 30 |     90 | `/participant/theme/C/5` | Evaluate L = limₙ→∞ n ∫₀¹ xⁿ(x² + 2)e^(x²) dx. Find L/e.…               |
| D.1    |             16 |                 31 / 32 |    100 | `/participant/theme/D/1` | On Independence Day, a flagpole is tilted. Its line is given by (x+1)/… |
| D.2    |             17 |                 33 / 34 |   60 ¹ | `/participant/theme/D/2` | A bank near the heritage building is at (−13, −14, 0). The straightene… |
| D.3    |             18 |                 35 / 36 |     90 | `/participant/theme/D/3` | The oval garden near the heritage building is elliptical, centred at t… |
| D.4    |             19 |                 37 / 38 |     50 | `/participant/theme/D/4` | Using the stopping point obtained in Q4.3, find its eccentric angle θ … |
| D.5    |             20 |                 39 / 40 |     90 | `/participant/theme/D/5` | Find the distance between the centre of the ellipse and the stopping p… |
| E.1    |             21 |                 41 / 42 |     70 | `/participant/theme/E/1` | You are dealt 2 hole cards from a fresh 52-card deck. Let the probabil… |
| E.2    |             22 |                 43 / 44 |     80 | `/participant/theme/E/2` | You are dealt 2 hole cards from a fresh 52-card deck. Let the probabil… |
| E.3    |             23 |                 45 / 46 |     90 | `/participant/theme/E/3` | Two poker players, A and B, play a simplified zero-sum betting game. P… |
| E.4    |             24 |                 47 / 48 |     60 | `/participant/theme/E/4` | You hold Pocket Aces (A OF SPADES, A OF HEARTS). There are two opponen… |
| E.5    |             25 |                 49 / 50 |    100 | `/participant/theme/E/5` | At a showdown, four unique cards of completely distinct ranks—an Ace, … |
| F.1    |             26 |                 51 / 52 |     70 | `/participant/theme/F/1` | To talk to your crush during a lecture, you sit in a row containing 15… |
| F.2    |             27 |                 53 / 54 |     70 | `/participant/theme/F/2` | Using S = 5 from Question 1, you analyze your crush’s 10S + 1 = 51 fri… |
| F.3    |             28 |                 55 / 56 |     90 | `/participant/theme/F/3` | Using K = 11 from Question 2, you and your crush independently select … |
| F.4    |             29 |                 57 / 58 |     90 | `/participant/theme/F/4` | At your meet-up on day a + b of the semester, you order coffee togethe… |
| F.5    |             30 |                 59 / 60 |    100 | `/participant/theme/F/5` | Your crush presents a statistical challenge to deliver their final res… |
| G.1    |             31 |                 61 / 62 |     80 | `/participant/theme/G/1` | A vector-valued function w(t) satisfies w′(t) = Xw(t), where X = [[0, … |
| G.2    |             32 |                 63 / 64 |     90 | `/participant/theme/G/2` | The trajectory from Q8.1 traces an ellipse. Take the four points at ti… |
| G.3    |             33 |                 65 / 66 |     90 | `/participant/theme/G/3` | Evaluate the infinite product ∏ from n = 2 to ∞ of (n³ − 1)/(n³ + 1). … |
| G.4    |             34 |                 67 / 68 |     50 | `/participant/theme/G/4` | Evaluate the improper integral ∫ from 0 to 1 of ln(1 − x)/x dx.…        |
| G.5    |             35 |                 69 / 70 |    100 | `/participant/theme/G/5` | Let F(x, y, z) = ln(1 − xyz)/(xyz), interpreted by continuity wherever… |
| H.1    |             36 |                 71 / 72 |     70 | `/participant/theme/H/1` | A circular zone is given by x² + y² = 16, and an escape parabola is gi… |
| H.2    |             37 |                 73 / 74 |     90 | `/participant/theme/H/2` | The portal leads to an elliptical chamber given by (x − 17)²/25 + (y −… |
| H.3    |             38 |                 75 / 76 |     90 | `/participant/theme/H/3` | The guard moves around the original circle with angular velocity π/2 r… |
| H.4    |             39 |                 77 / 78 |     90 | `/participant/theme/H/4` | The guard is initially at G = (0, 0) and can run at a constant speed o… |
| H.5    |             40 |                 79 / 80 |    100 | `/participant/theme/H/5` | A circular security barrier is given by (x − 5)² + (y + 2)² = 169. The… |
| I.1    |             41 |                 81 / 82 |     90 | `/participant/theme/I/1` | Senior i accepts a request of ₹x with probability 1 − x/kᵢ, independen… |
| I.2    |             42 |                 83 / 84 |    100 | `/participant/theme/I/2` | You request ₹x₁, ₹x₂, ₹x₃, ₹x₄ from A, B, C, D with x₁ + x₂ + x₃ + x₄ … |
| I.3    |             43 |                 85 / 86 |     80 | `/participant/theme/I/3` | Each day, A, B, C, D independently call you with probabilities 1/2, 1/… |
| I.4    |             44 |                 87 / 88 |     80 | `/participant/theme/I/4` | A, B, C, D independently ask you to run an errand with probabilities 1… |
| I.5    |             45 |                 89 / 90 |    100 | `/participant/theme/I/5` | To settle your pay requests, the seniors put 14 ₹10 notes into three l… |
| J.1    |             46 |                 91 / 92 |     80 | `/participant/theme/J/1` | Person k (k = 1, 2, …, 2026) says: “Exactly k of the 2026 people here … |
| J.2    |             47 |                 93 / 94 |     90 | `/participant/theme/J/2` | 2025 people sit around a circular table. Each is either a truth-teller… |
| J.3    |             48 |                 95 / 96 |     70 | `/participant/theme/J/3` | Three students each claim a statement holds for all positive integers … |
| J.4    |             49 |                 97 / 98 |     90 | `/participant/theme/J/4` | Josephus Problem…                                                       |
| J.5    |             50 |                99 / 100 |     90 | `/participant/theme/J/5` | The last surviving soldier has rank 45. What is the smallest number of… |

¹ D.2: the reward cell is blank in the document; **60** was confirmed by the project owner (section 6).

## 4. What the migration does (and does not do)

### Why it must install, not only update (fresh-database lifecycle)

Supabase builds a fresh database **migrations first, `seed.sql` after**: `supabase db reset` and `supabase start` "apply all migrations in order, then run `seed.sql`";
`supabase db push` applies migrations only, and seeds a remote database only with `--include-seed`, again after the migrations (Supabase docs, "Local development workflow").
So when migration 19 runs on a fresh database the content tables are still **empty**, and `seed.sql` (all `ON CONFLICT DO NOTHING`) creates the placeholder rows
only afterwards. A migration that merely skipped an empty database (the first B17 patch) would have been recorded as applied while the placeholders went in behind it.

### What it does now

`20261006000019_official_content.sql` is one guarded `DO` block. It loads the official content into three temporary tables once, then takes one of two paths:

| Database state when it runs                                | Path                                                                                                                                                                                                                                                                                                                                                                                     | Result                                                                                                                                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 / 0 / 0 rows** (fresh: `db reset`, `db push`, CI)      | **INSTALL**: inserts the 10 themes, 50 questions and 100 hints with the structure the seed gives its rows (difficulty EASY 1-3 / MEDIUM 4-7 / HARD 8-10, unlock cost 100, display order, topics `{placeholder}`, question timer 240 s, hint cost 20 / 40). The seed that follows finds every row and adds only what is not content (150 buy-time options, 50 reviewer-key placeholders). | Official content, no audit row (it is the database's initial content).                                                                                                    |
| **10 / 50 / 100 rows** (an upgrade: production at B16)     | **UPDATE**: overwrites only `themes.name, description` · `questions.body_md, reward_coins` · `hints.body_md`, and only rows whose content differs (`IS DISTINCT FROM`).                                                                                                                                                                                                                  | Official content; one `CONTENT_IMPORTED` audit event (mode `updated`, counts, source SHA-256) only if something changed. A second run changes nothing and writes nothing. |
| anything else (e.g. 99 hints, or themes without questions) | **ABORT**, nothing changed                                                                                                                                                                                                                                                                                                                                                               | -                                                                                                                                                                         |

Either way the block ends by checking that the database holds exactly the official content (10 + 50 + 100 rows equal to the JSON) and raises if not.

Never touched (upgrade path): teams, members, sessions, `team_themes`, `team_questions`, drafts, submissions, `reward_awarded` of past approvals, balances, the ledger,
timers, hint purchases, final scores, penalties, and (for rows that exist) `unlock_cost`, `hints.cost`, buy-time options, `time_limit_seconds`, difficulty, topics, ids, `question_keys`,
and every function (`approve_submission` and the B16 scoring/freeze code are not re-declared).

**Rewards need no code change.** B14's `approve_submission` already pays `questions.reward_coins` once, through the unique ledger index `ctx_reward`
and the idempotency key, records it in `submissions.reward_awarded` and audits it. B16's hook (a late approval pays but never changes a frozen score) is
unchanged. There is no `50` constant left in any server path; the old value was only the seed's data.

Test and demo teams are not special-cased and not modified: the migration has no WHERE on teams. Their _content_ simply becomes official, which is wanted.

## 5. Security

- Hints: `hints.body_md` is read only through the owner-checked path (`app.question_json` / `buy_hint`) as before; an unowned hint returns price and
  "purchasable" only. Tests: `180_official_content.test.sql` (secrecy and team isolation), `official-content.spec.ts` (no hint text in any `/api/p/*` response or in the page
  before purchase; Hint 2 absent after buying Hint 1), `economy.spec.ts`.
- Questions: text only after entering; a LOCKED question raises `QUESTION_NOT_ACTIVE`; a locked theme returns no body (`gameplay.spec.ts`).
- Canonical answers: the document has none, and `question_keys` keeps its placeholders; no function reads them. The admin sees the participant's own answer only.
- Rendering: `ContentText` renders React text nodes only (no `dangerouslySetInnerHTML`, no Markdown, no HTML), so a question cannot inject markup (unit test with `<script>`, `<img onerror>`, `javascript:` links).
- No secret, key or credential is added. `anon`/`authenticated` privileges are unchanged (SQL test).

## 6. Decisions taken and items for your review

**Approved deviations from the document** (both recorded in the JSON's `approved_deviations`):

1. **D.2 reward = 60** (blank in the document), per your message.
2. **Rule 2 "base time limit of 4 minutes"** (the document says "5 minutes"; you confirmed it is a typo and the timer is 4 minutes).

**Preserved exactly as written - please confirm or send a correction (no change was made without your approval):**

3. **Hint labels are not uniform.** A.x use descriptive labels (e.g. "REVERSE THE PIPELINE:"); B-E use TOPIC / FORMULA / METHOD; F uses LOGIC / FORMULA/METHOD; G-H use TOPIC/LOGIC and METHOD/FORMULA;
   **I.x and J.x hints carry no label at all**. B.3's hints read "HINT 1 - TOPIC:" / "HINT 2 - FORMULA:" and C.1's first hint begins "- TOPIC:" (stray dash). Kept verbatim.
4. **Cross-reference numbering is off by one in places.** The questions say "Q3.1" (C.2 -> C.1, correct), "Q4.3" (D.4/D.5 -> D.3, correct) but "Q9.1" (H.2) and "Q9.2" (H.3) point at theme _I_'s numbering, F.2-F.5 say
   "Question 1 / 2 / 4" without a theme, and **F.4 uses "a + b" with no stated source** (a and b are not defined in F.4 itself). The wording is kept; the dependencies themselves (C.2, D.4, D.5, F.2-F.5, H.2-H.3) are all present and unchanged.
5. **J.4 and J.5 have identical hints** (the Josephus problem); they are two distinct questions and are kept so.
6. **No canonical answers or validation rules exist in the document.** The current system never auto-validates: a participant's free-text answer + explanation goes to a manual Admin review (approve / disapprove),
   so no incompatibility arises. `question_keys` stays as placeholders and is read by nothing.
7. **Pending reviews at rollout.** A submission that is PENDING when migration 19 runs is paid the _new_ reward of its question when approved (submissions already approved keep what they were paid).
   Apply the migration before the competition opens, or when the review queue is empty.
8. **New assets:** a subset of DejaVu Sans (renamed "Concetto Math Fallback", licence in `src/assets/fonts/DejaVu-LICENSE.txt`) is added so Greek letters, roots, integrals and sub/superscripts that the site font (Manrope, Latin only) lacks are
   shown as glyphs instead of boxes; and a small `ContentText` component renders multi-line text, with lines laid out in spaces (payoff tables, indented formulas) in a monospace block.
9. **Long theme names on tickets.** The longest name has 47 characters; tickets are small. Labels now wrap (balanced, up to three lines) with a slightly smaller font and carry the full name as a tooltip; the dialog heading always shows the whole name.
10. **`b16_upgrade.upgrade.mjs`** needed one line changed: it selects "the migrations before B16" and now ignores migrations after 18 (the same pattern `b15_upgrade` already uses). Nothing was weakened.
11. **Pre-existing (not B17):** the mobile test `question-page.spec.ts:116` is the known flaky case (see the report); `prettier --check` fails on the same 11 doc files at the B16 base.

## 7. Rollout and rollback

### Fresh databases (local, CI, staging)

Nothing special to do: `supabase db reset` (migrations, then `seed.sql`) or `supabase db push` (add `--include-seed` for a seed) ends with the official content, because migration 19 installs it into the empty tables and the seed leaves it alone. The pre-B17 SQL tests were written against placeholder content, so `npm run db:verify` runs the "fresh" tests first and then rebuilds the placeholder state with the real seed for the older tests (`supabase/tests/include/placeholder_content.sql`).

### Before (read-only, on production)

1. Confirm production is `af8b6e3` with migration 18 applied: `select max(version) from supabase_migrations.schema_migrations;`.
2. Counts: `select (select count(*) from themes), (select count(*) from questions), (select count(*) from hints);` must be **10, 50, 100** (the migration aborts otherwise, changing nothing).
3. Review queue: `select count(*) from submissions where status = 'PENDING';` - ideally 0 (item 7).
4. Snapshot the content columns (writes three CSV files locally, nothing in the database):
   `psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/content/snapshot-content.sql`
5. Record team state for the before/after comparison (coins, statuses): the upgrade test lists exactly which tables must stay identical (`teams`, `team_themes`, `team_questions`, `submissions`, `coin_ledger`, ...).

### Apply (after your approval, in this order)

1. **Migration 19 first.** It is data-only and works with the _currently deployed_ app (the old app simply serves the new text from the database; its own ticket labels stay "THEME A" until step 2).
2. **Then deploy the app** (`main` with this patch). The new app needs the new content to be in the database for correct descriptions; applying in this order never shows half-new content.
3. Verify (below). The database keeps working throughout; there is no downtime and no lock beyond three small `UPDATE`s.

### Verify

```sql
select count(*) filter (where name <> '') from themes;                                  -- 10
select id, reward_coins from questions order by id;                                      -- the table in section 2
select event_type, payload from audit_events where event_type = 'CONTENT_IMPORTED';     -- one row, mode 'updated', counts 10 / 50 / 100 on the first run
select sum(reward_coins) from questions;                                                 -- 4230
```

Then in the browser (as a test team): tickets show the official names, the `i` icon shows 8 rules, a theme dialog shows its description, Q1 shows the official text, and a purchased hint matches.
Re-running migration 19 must print "0 themes, 0 questions, 0 hints updated" and write no audit row.

### Rollback

- **Content only:** `psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/content/restore-content.sql` (in the folder that holds the three CSV files). One transaction; restores exactly the snapshot; writes a `CONTENT_RESTORED` audit event.
  Tested on a scratch database: after restore the content fingerprint equals a pristine seed.
- **App:** redeploy the previous Vercel deployment (`af8b6e3`). Because migration 19 is data-only, the old app runs unchanged against either content.
- Rewards already paid at the new values stay (the ledger is append-only by design): roll back before the competition opens, or accept those coins.
- There is no schema change, so no down-migration is needed.

## 8. Tests

| Layer                 | What                                                                                                                                                                                                                                                               | Where                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Unit                  | 10/50/100/8 inventory, ids, reward matrix, deviations, cross-references, J.4 != J.5, generated files up to date, migration literals == JSON by id, migration touches content columns only, no hint/question text in `src/`                                         | `tests/unit/official-content.test.ts`                                                                   |
| Unit                  | tickets carry official names (ids A-J unchanged)                                                                                                                                                                                                                   | `tests/unit/home-lib.test.ts`                                                                           |
| Component             | `ContentText`: table, indented lines, Greek/sub/superscript symbols, no markup injection, every question and hint round-trips                                                                                                                                      | `tests/component/content-text.test.tsx`                                                                 |
| Component             | tickets, theme dialog, rules dialog (8 items, order, text), question page with a multi-line question                                                                                                                                                               | `home.test.tsx`, `question-page.test.tsx`                                                               |
| SQL (real PostgreSQL) | official content equals the document column by column, structure unchanged, idempotent, hint secrecy and isolation, exactly-once reward at the document value, late approval after Final Submit and after expiry leaves the frozen score, D.2 = 60, privileges     | `supabase/tests/180_official_content.test.sql`                                                          |
| Fresh (SQL)           | database built migrations -> seed (twice) holds the official content: names, rewards, hint mapping, structure equal to the seed's, empty audit log, re-run is a no-op, then the shared gameplay checks (hint secrecy, A.1 pays 100 once, late approvals, D.2 = 60) | `supabase/tests/fresh/010_fresh_install.test.sql`                                                       |
| Fresh lifecycles      | three real orders in scratch databases - reset (migrations, seed x2), push (migrations only, seed later), upgrade (B16 + migration 19) - end identical to each other and to the JSON; partial database aborts; the old skip-when-empty behaviour fails this test   | `supabase/tests/upgrade/b17_fresh.upgrade.mjs`                                                          |
| Upgrade               | a B16 database with teams in every state -> migration 19: ten tables fingerprint-identical, old approvals keep 50, new approval pays 100 once, frozen scores and penalties unchanged, idempotent, guard aborts on 99 hints                                         | `supabase/tests/upgrade/b17_upgrade.upgrade.mjs`                                                        |
| E2E (desktop + phone) | rules dialog fits and scrolls, every ticket name fits its ticket, each theme dialog shows its own description, A.4 / E.3 maths layout, no horizontal overflow, math font loads, hints not in any response before purchase                                          | `tests/e2e/official-content.spec.ts`                                                                    |
| E2E (updated)         | rewards, question text, hints, scores now read from the official JSON instead of fixed numbers                                                                                                                                                                     | `gameplay`, `economy`, `final-submit`, `scoring`, `my-teams`, `question-page`, `participant-home` specs |

Regenerate after a content change: edit `content/concetto26/official-content.json` (a raw re-extract for comparison: `python3 scripts/content/extract-docx.py <docx> <out.json>`), run `node scripts/content/generate.mjs`, then `npm run db:evidence`.
Once migration 19 has been applied to production it is never edited: a _later_ content change ships as a new, higher-numbered migration (the generator's migration writer is the template), not as a regeneration of 19.

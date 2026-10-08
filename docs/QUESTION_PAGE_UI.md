# Question page — UI foundation (PATCH UI-2)

Route: `/participant/theme/[A–J]/[1–5]` (anything else is a 404). Opened by "Let's solve" on the home page. **Since Patch B13 the page is server-authoritative**: the body, deadline, draft, submission, coins and both timers come from the database through `/api/p/*` (see `GAMEPLAY.md`). The demo engine, the `sessionStorage` store and the DEMO bar are gone.

## Spec → implementation

| Spec item                                                                                                                                        | Where                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Top-left arrow → home from any question                                                                                                          | `ArrowButton` (link to `/participant`) |
| Centre-left arrow → previous question (disabled on Q1)                                                                                           | `question-page.tsx`                    |
| Centre-right arrow → next question; locked until the answer is approved                                                                          | `question-page.tsx` (`nextOpen`)       |
| Heading = "THEME A" … "THEME J"                                                                                                                  | `<h1>`                                 |
| 5 icons in a row: ultimate timer, question timer, buy time, coins left, reward ("50 coins++")                                                    | `question-page.tsx`, `icons.tsx`       |
| Question timer (the question's time limit); starts on the server when Q1 is entered; frozen while pending; stops being usable at zero            | `use-question-detail.ts`, `derive.ts`  |
| Buy time dialog: 2/4/8 mins = 20/40/80 coins, "are you sure?" Yes adds time + deducts, No closes                                                 | `buy-time-dialog.tsx`                  |
| Question box (lorem ipsum)                                                                                                                       | `.q-question`                          |
| Two hints: ask "purchase this hint for 40 / 80 coins?" Yes/No; once owned open a hint dialog with Close                                          | `hint-dialogs.tsx`                     |
| Answer box, CLEAR ALL                                                                                                                            | `.q-input`, `.q-clear`                 |
| Submit: red → grey "Pending for approval" → green "Approved" (+ Next opens, coins awarded); disapproved → red again and the typed answer is kept | `question-page.tsx`, `.q-submit-*`     |

## Decisions taken with the team

- Hint prices follow the Word doc (**40 / 80**), not the image text (25 / 50).
- The Q1 timer starts when the member **enters** Q1 (locked product rule), not when the theme is bought. Later questions start when the previous one is approved.
- B13 removed the local demo and its DEMO bar. Approval and disapproval are server operations (`POST /api/admin/submissions/:id/approve|disapprove`, the minimal controlled review path); the full Admin review UI is a later patch.

## Change after review

On disapproval the answer text is **kept** (not cleared) so members can study their mistakes; only the button returns to red "Submit". This replaces the earlier "box clears" wording in the Word doc and in the Milestone 0 docs (REVIEW/STATE_MACHINE say the draft is cleared on disapproval) — B13 implements the kept-draft behaviour in the database; the Milestone 0 wording still needs the one-line change.

## Rules mirrored from the locked design

Timer pauses while pending and resumes on disapproval; reward paid once; Tier 2 hint needs Tier 1; time and hints can only be bought while the question is ACTIVE; a question that reaches zero is TIMED_OUT and blocks the next one; previous (approved) questions are read-only and show only the member's own answer, never reference answers or solution notes.

## Assumptions / not implemented

- Buying a hint opens that hint straight away; Tier 2 is disabled ("buy hint 1 first") until Tier 1 is owned.
- Submit is disabled while the answer box is blank (not in the spec).
- After the last question (Q5) is approved the Next arrow stays disabled and the footer says "Theme complete."
- Unlocking a theme is team-wide and charged once by the server; the home page and this page read the same snapshot (coins, team timer).
- The draft autosaves to the server (compare-and-set on `expectedVersion`) and is shared by the team. The browser keeps only the text being typed; nothing is stored in `localStorage`/`sessionStorage`.
- Hints and Buy Time arrive in later patches: both are shown but disabled ("coming soon"). The explanation field is sent empty (a single answer box).
- The page learns about teammates' changes by polling `GET /api/p/state` (about every 5 s); there is no realtime push yet.
- Mobile (< 900 px): sections stack and the arrows sit in a row above the answer box.

## Tests

Unit (`gameplay-*.test.ts`), component (`question-page.test.tsx`, `home.test.tsx`), e2e (`question-page.spec.ts`: layout fractions vs the image at 1440×810, submit → admin approve / disapprove, locked/404 routes, axe in three states; `gameplay.spec.ts`: two members of one team).

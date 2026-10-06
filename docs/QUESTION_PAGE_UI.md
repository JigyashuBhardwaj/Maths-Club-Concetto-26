# Question page — UI foundation (PATCH UI-2)

Route: `/participant/theme/[A–J]/[1–5]` (anything else is a 404). Opened by "Let's solve" on the home page. UI only: no auth, no server calls. Everything runs on a local **demo engine** (`src/lib/question/engine.ts`, state in `sessionStorage` for the browser tab).

## Spec → implementation

| Spec item                                                                                                                                        | Where                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Top-left arrow → home from any question                                                                                                          | `ArrowButton` (link to `/participant`) |
| Centre-left arrow → previous question (disabled on Q1)                                                                                           | `question-page.tsx`                    |
| Centre-right arrow → next question; locked until the answer is approved                                                                          | `question-page.tsx` (`nextOpen`)       |
| Heading = "THEME A" … "THEME J"                                                                                                                  | `<h1>`                                 |
| 5 icons in a row: ultimate timer, question timer, buy time, coins left, reward ("50 coins++")                                                    | `question-page.tsx`, `icons.tsx`       |
| Question timer 4:00 per question; Q1 starts on entering; stops being usable at zero                                                              | `engine.ts`                            |
| Buy time dialog: 2/4/8 mins = 20/40/80 coins, "are you sure?" Yes adds time + deducts, No closes                                                 | `buy-time-dialog.tsx`                  |
| Question box (lorem ipsum)                                                                                                                       | `.q-question`                          |
| Two hints: ask "purchase this hint for 40 / 80 coins?" Yes/No; once owned open a hint dialog with Close                                          | `hint-dialogs.tsx`                     |
| Answer box, CLEAR ALL                                                                                                                            | `.q-input`, `.q-clear`                 |
| Submit: red → grey "Pending for approval" → green "Approved" (+ Next opens, coins awarded); disapproved → red again and the typed answer is kept | `engine.ts`, `.q-submit-*`             |

## Decisions taken with the team

- Hint prices follow the Word doc (**40 / 80**), not the image text (25 / 50).
- The Q1 timer starts when the member **enters** Q1 (locked product rule), not when the theme is bought. Later questions start when the previous one is approved.
- Interactive local demo with a labelled **DEMO · simulate admin** bar (Approve / Disapprove / Reset demo). The bar is not part of the real page and goes away with the backend.

## Change after review

On disapproval the answer text is **kept** (not cleared) so members can study their mistakes; only the button returns to red "Submit". This replaces the earlier "box clears" wording in the Word doc and in the Milestone 0 docs (REVIEW/STATE_MACHINE say the draft is cleared on disapproval) — those need the same one-line change when the backend is built.

## Rules mirrored from the locked design

Timer pauses while pending and resumes on disapproval; reward paid once; Tier 2 hint needs Tier 1; time and hints can only be bought while the question is ACTIVE; a question that reaches zero is TIMED_OUT and blocks the next one; previous (approved) questions are read-only and show only the member's own answer, never reference answers or solution notes.

## Assumptions / not implemented

- Buying a hint opens that hint straight away; Tier 2 is disabled ("buy hint 1 first") until Tier 1 is owned.
- Submit is disabled while the answer box is blank (not in the spec).
- After the last question (Q5) is approved the Next arrow stays disabled and the footer says "Theme complete."
- Unlocking a theme on the home page is free in the demo; the home page's coins/timer stay the static mock values (it does not read the demo store).
- Nothing persists beyond the browser tab; the ultimate timer restarts at 03:46:54 per tab session. No realtime, autosave to a server, or multi-member sync.
- Mobile (< 900 px): sections stack and the arrows sit in a row above the answer box.

## Tests

Unit (`question-engine.test.ts`), component (`question-page.test.tsx`, updated `home.test.tsx`), e2e (`question-page.spec.ts`: layout fractions vs the image at 1440×810, full flow, dialogs, locked/404 routes, axe in four states).

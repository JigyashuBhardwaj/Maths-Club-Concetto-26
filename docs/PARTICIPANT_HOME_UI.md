# Participant home page — UI foundation

> **Competition shape (locked):** 10 themes A–J × 5 questions = 50 questions, plus a Final Submit ticket = 11 tickets. Themes K and L do not exist. The constants live in `src/lib/contracts/competition.ts`; the ticket list, spiral geometry and ticket count derive from them.

Route: `/participant`. UI only: no auth, no server calls, no engine. Everything shown is static demo data.

## Spec → implementation

| Spec item                                                                      | Where                                                                                  |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Three circular logos top-left, hover kept                                      | `components/home/logo-badges.tsx` — float + pointer parallax, same as the landing page |
| Heading "WELCOME TO THE ESCAPE ROOM ISMites"                                   | `home-header.tsx` (case preserved)                                                     |
| Timer with sand-clock SVG (static)                                             | `home-header.tsx`, `icons.tsx`, `lib/home/format.ts` — nothing ticks                   |
| Coins left with gold-coins SVG                                                 | `home-header.tsx`, `icons.tsx`                                                         |
| Rules and regulations → dialog with lorem ipsum and a Close button             | `rules-dialog.tsx`                                                                     |
| Live leaderboard, **right** column (per the layout image; the text said left)  | `leaderboard.tsx`                                                                      |
| Own rank / team_id / score above the board                                     | `leaderboard.tsx` (`MOCK_TEAM`)                                                        |
| Empty board of 100 ranks, refreshed every minute                               | `lib/home/use-leaderboard.ts`, `lib/home/leaderboard.ts`                               |
| Ties: score desc, fewer minutes, then team_id (Milestone 0 DEC-11)             | `compareEntries`                                                                       |
| 10 theme tickets (A–J) + FINAL SUBMIT in a spiral (11 tickets)                 | `ticket-spiral.tsx`, `use-spiral-motion.ts`, `lib/home/spiral.ts`                      |
| Theme dialog (heading, lorem, "Unlock with xyz coins", "Explore other themes") | `theme-dialog.tsx`                                                                     |
| Final dialog (heading, lorem, "Yes, submit", "Go back")                        | `final-submit-dialog.tsx`                                                              |

## Behaviour of the spiral

CSS 3D helix; tickets always face the viewer. It drifts at 5°/s and eases to a stop on hover, keyboard focus, drag and while a dialog is open. It also responds to drag, wheel and arrow keys (Left/Right/Up/Down, Home, End); focusing a ticket brings it to the front. With `prefers-reduced-motion` there is no animation loop and every move is instant. No `backdrop-filter`/`filter` on tickets, so it stays light.

## Demo-only behaviour (not implemented on purpose)

- "Unlock with xyz coins" only flips the button to "Let's solve" (remembered for the browser tab, see `QUESTION_PAGE_UI.md`). No coins are deducted and nothing is saved on a server. Since PATCH UI-2, "Let's solve" is a link to the question page.
- "Yes, submit" only closes the dialog. There is no final submission.
- Timer (03:46:54), coins (446), rank/team/score (#12, TEAM123, 60) are constants in `lib/home/mock.ts`, taken from the layout image. The leaderboard source is empty (`emptyLeaderboardSource`).
- The route is open: no login, no role check.

## Assumptions

Logo order IIT (ISM), event mark, Math Club · "hover" = float plus pointer parallax · dark/orange WebGL theme reused unchanged · mobile (< 900 px) stacks header, spiral, leaderboard and the page scrolls · button labels "Yes, submit" and "Let's solve" add punctuation to the spec's "yes submit" / "lets solve" · `activetheory.net/work` could not be inspected (JavaScript-only site), so the spiral is an original simple design.

## Tests

Unit (`home-lib.test.ts`), component (`home.test.tsx`), e2e (`participant-home.spec.ts`: layout fractions vs the image at 1440×810, 11 tickets, dialogs, keyboard, drag, reduced motion, overflow) and the existing axe check on `/participant`.

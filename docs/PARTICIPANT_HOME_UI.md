# Participant home page — UI foundation

> **Competition shape (locked):** 10 themes A–J × 5 questions = 50 questions, plus a Final Submit ticket = 11 tickets. Themes K and L do not exist. The constants live in `src/lib/contracts/competition.ts`; the ticket list, spiral geometry and ticket count derive from them.

Route: `/participant` (protected, B11). **Since Patch B13** the timer, coins, themes and unlock state come from the server snapshot (`GET /api/p/state`, polled; see `GAMEPLAY.md`); only the rules text and the empty leaderboard are still placeholders (**B15:** the Final Submit dialog is real: it ends the team's run, see `ECONOMY_AND_FINALIZATION.md`).

## Spec → implementation

| Spec item                                                                       | Where                                                                                  |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Three circular logos top-left, hover kept                                       | `components/home/logo-badges.tsx` — float + pointer parallax, same as the landing page |
| Heading "WELCOME TO THE ESCAPE ROOM ISMites"                                    | `home-header.tsx` (case preserved)                                                     |
| Team timer with sand-clock SVG (counts down to the server's `ends_at`)          | `home-header.tsx`, `icons.tsx`, `lib/home/format.ts`, `lib/gameplay/derive.ts`         |
| Coins left with gold-coins SVG (the team's balance from the server)             | `home-header.tsx`, `icons.tsx`                                                         |
| Rules and regulations → dialog with lorem ipsum and a Close button              | `rules-dialog.tsx`                                                                     |
| Live leaderboard, **right** column (per the layout image; the text said left)   | `leaderboard.tsx`                                                                      |
| Own rank / team_id / score above the board (team ID real; rank/score "—")       | `leaderboard.tsx`                                                                      |
| Empty board of 100 ranks, refreshed every minute                                | `lib/home/use-leaderboard.ts`, `lib/home/leaderboard.ts`                               |
| Ties: score desc, fewer minutes, then team_id (Milestone 0 DEC-11)              | `compareEntries`                                                                       |
| 10 theme tickets (A–J) + FINAL SUBMIT in a spiral (11 tickets)                  | `ticket-spiral.tsx`, `use-spiral-motion.ts`, `lib/home/spiral.ts`                      |
| Theme dialog (name, description, "Unlock with N coins", "Explore other themes") | `theme-dialog.tsx`                                                                     |
| Final dialog (heading, lorem, "Yes, submit", "Go back")                         | `final-submit-dialog.tsx`                                                              |

## Behaviour of the spiral

CSS 3D helix; tickets always face the viewer. It drifts at 5°/s and eases to a stop on hover, keyboard focus, drag and while a dialog is open. It also responds to drag, wheel and arrow keys (Left/Right/Up/Down, Home, End); focusing a ticket brings it to the front. With `prefers-reduced-motion` there is no animation loop and every move is instant. No `backdrop-filter`/`filter` on tickets, so it stays light.

## Not implemented yet

- "Yes, submit" only closes the dialog. There is no final submission (a later patch).
- The participant leaderboard has no data source yet: the board is empty and the team's own rank and score show "—".
- Until the team's first member presses **Enter competition** the page sits behind that gate; signing in does not start the team timer.

## Assumptions

Logo order IIT (ISM), event mark, Math Club · "hover" = float plus pointer parallax · dark/orange WebGL theme reused unchanged · mobile (< 900 px) stacks header, spiral, leaderboard and the page scrolls · button labels "Yes, submit" and "Let's solve" add punctuation to the spec's "yes submit" / "lets solve" · `activetheory.net/work` could not be inspected (JavaScript-only site), so the spiral is an original simple design.

## Tests

Unit (`home-lib.test.ts`), component (`home.test.tsx`), e2e (`participant-home.spec.ts`, which runs against the server-backed numbers: layout fractions vs the image at 1440×810, 11 tickets, dialogs, keyboard, drag, reduced motion, overflow) and the existing axe check on `/participant`.

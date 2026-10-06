/**
 * Ticket content for the participant home page. UI foundation only: names and descriptions are
 * placeholders until the real theme content is seeded (Milestone 2+).
 */

import { THEME_IDS, type ThemeId } from "@/lib/contracts/competition";

export { THEME_IDS, type ThemeId };

export const LOREM_IPSUM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";

/** The real unlock price depends on theme difficulty and is not decided yet. */
export const UNLOCK_COST_PLACEHOLDER = "xyz";

export interface ThemeTicket {
  kind: "theme";
  id: ThemeId;
  /** Text shown on the ticket and as the dialog heading. */
  label: string;
  description: string;
}

export interface FinalTicket {
  kind: "final";
  id: "FINAL";
  label: string;
}

export type Ticket = ThemeTicket | FinalTicket;

export const THEMES: readonly ThemeTicket[] = THEME_IDS.map((id) => ({
  kind: "theme" as const,
  id,
  label: `THEME ${id}`,
  description: LOREM_IPSUM,
}));

export const FINAL_TICKET: FinalTicket = { kind: "final", id: "FINAL", label: "FINAL SUBMIT" };

/** The 10 theme tickets (A–J) followed by the Final Submit ticket (11 in total). */
export const TICKETS: readonly Ticket[] = [...THEMES, FINAL_TICKET];

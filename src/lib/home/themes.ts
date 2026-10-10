/**
 * Ticket content for the participant home page. The ten theme names and descriptions are the official text of the competition
 * (content/concetto26/official-content.json, generated into @/lib/content/official-public). The internal theme ids A–J stay
 * the keys of everything (routes, API, database); the official name is only what a participant reads.
 */

import { THEME_IDS, type ThemeId } from "@/lib/contracts/competition";
import { OFFICIAL_THEMES } from "@/lib/content/official-public";

export { THEME_IDS, type ThemeId };

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

/** The official name of a theme (A–J). */
export function themeName(id: ThemeId): string {
  const theme = OFFICIAL_THEMES.find((t) => t.id === id);
  if (!theme) throw new Error(`no official theme ${id}`);
  return theme.name;
}

export const THEMES: readonly ThemeTicket[] = THEME_IDS.map((id) => {
  const official = OFFICIAL_THEMES.find((t) => t.id === id)!;
  return {
    kind: "theme" as const,
    id,
    label: official.name,
    description: official.description,
  };
});

export const FINAL_TICKET: FinalTicket = { kind: "final", id: "FINAL", label: "FINAL SUBMIT" };

/** The 10 theme tickets (A–J) followed by the Final Submit ticket (11 in total). */
export const TICKETS: readonly Ticket[] = [...THEMES, FINAL_TICKET];

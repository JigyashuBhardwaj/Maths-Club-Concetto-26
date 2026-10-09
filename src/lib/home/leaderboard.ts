/**
 * Leaderboard model for the participant home page.
 *
 * The SERVER ranks (Phase B16: `get_team_leaderboard`, one SQL statement over one snapshot): started teams first, then
 * higher score, then fewer minutes taken, then Team ID in code-point order; teams that have not started follow. The browser
 * shows the rows exactly as received and never re-sorts them. `compareEntries` / `rankEntries` below are the same ordering
 * written down once for the unit tests and for fixtures; no production path calls them.
 */

export const MAX_TEAMS = 100;
/**
 * Default polling interval of every leaderboard (B16 review: 15 s; do not lower it without benchmark evidence). The time
 * penalty changes scores even when nobody does anything, so the periodic refresh stays; the team's own events refresh it
 * sooner. Each wait is randomised by +/- `LEADERBOARD_JITTER` so 300 clients drift apart instead of arriving together.
 */
export const LEADERBOARD_REFRESH_MS = 15_000;
export const LEADERBOARD_JITTER = 0.2;

export interface LeaderboardEntry {
  teamId: string;
  score: number;
  minutesTaken: number;
}

export interface LeaderboardRow {
  rank: number;
  /** `null` while no team occupies this rank (there are no teams yet). */
  teamId: string | null;
  score: number | null;
}

/** One line of a server-ranked board. */
export interface RankedLine {
  rank: number;
  teamId: string;
  score: number;
}

/** What one refresh returns: the ranking as the server computed it and the signed-in team's own line from the same snapshot. */
export interface LeaderboardSnapshot {
  rows: readonly RankedLine[];
  me: RankedLine | null;
}

export type LeaderboardSource = () => Promise<LeaderboardSnapshot>;

/** The board before the first refresh: nothing yet. */
export const emptyLeaderboardSource: LeaderboardSource = async () => ({ rows: [], me: null });

/** Code-point comparison: deterministic and independent of the viewer's locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareEntries(a: LeaderboardEntry, b: LeaderboardEntry): number {
  return b.score - a.score || a.minutesTaken - b.minutesTaken || compareText(a.teamId, b.teamId);
}

/** Sorts a copy of the entries and assigns ranks 1..n (reference implementation of the server's tie-break chain). */
export function rankEntries(entries: readonly LeaderboardEntry[]): LeaderboardRow[] {
  return [...entries]
    .sort(compareEntries)
    .map((e, i) => ({ rank: i + 1, teamId: e.teamId, score: e.score }));
}

/** Pads the ranked rows with empty rows so the board always shows `total` ranks. */
export function withPlaceholderRows(
  rows: readonly LeaderboardRow[],
  total = MAX_TEAMS,
): LeaderboardRow[] {
  const out: LeaderboardRow[] = rows.slice(0, total).map((r) => ({ ...r }));
  for (let rank = out.length + 1; rank <= total; rank++)
    out.push({ rank, teamId: null, score: null });
  return out;
}

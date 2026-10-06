/**
 * Leaderboard model for the participant home page.
 *
 * Ordering rule (Milestone 0, DEC-11): higher score first; ties by fewer minutes taken;
 * remaining ties lexicographically by team id. In production the server computes the ranks
 * (`leaderboard_snapshot`); this ordering exists so the UI contract and demo data stay consistent.
 */

export const MAX_TEAMS = 100;
/** The board refreshes automatically every minute. */
export const LEADERBOARD_REFRESH_MS = 60_000;

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

export type LeaderboardSource = () => Promise<readonly LeaderboardEntry[]>;

/** No teams exist yet, so the board is empty. Replaced by the real snapshot endpoint later. */
export const emptyLeaderboardSource: LeaderboardSource = async () => [];

/** Code-point comparison: deterministic and independent of the viewer's locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareEntries(a: LeaderboardEntry, b: LeaderboardEntry): number {
  return b.score - a.score || a.minutesTaken - b.minutesTaken || compareText(a.teamId, b.teamId);
}

/** Sorts a copy of the entries and assigns ranks 1..n. */
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

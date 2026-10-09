"use client";

import { cn } from "@/lib/utils";
import {
  emptyLeaderboardSource,
  LEADERBOARD_REFRESH_MS,
  MAX_TEAMS,
  withPlaceholderRows,
  type LeaderboardSource,
} from "@/lib/home/leaderboard";
import { useLeaderboard } from "@/lib/home/use-leaderboard";

interface LeaderboardProps {
  /**
   * The signed-in team's own line BEFORE the first snapshot arrives (its Team ID is known from the session; rank and score
   * are not). Once a snapshot is in, the server's own line replaces it.
   */
  me: { rank: number | null; teamId: string; score: number | null };
  /** The production source is `participantBoardSource`; the default is an empty board (tests, pre-login previews). */
  source?: LeaderboardSource;
  intervalMs?: number;
  /** The team's own state version: a change refreshes the board at once (the team's score may have moved). */
  refreshKey?: number | null;
}

export function Leaderboard({
  me: meFallback,
  source = emptyLeaderboardSource,
  intervalMs = LEADERBOARD_REFRESH_MS,
  refreshKey,
}: LeaderboardProps) {
  const { rows, me: snapshotMe } = useLeaderboard(source, intervalMs, refreshKey);
  const board = withPlaceholderRows(rows, MAX_TEAMS);
  const me = snapshotMe ?? meFallback;

  return (
    <aside className="leaderboard" aria-labelledby="leaderboard-title">
      <h2 id="leaderboard-title" className="lb-title">
        Live Leaderboard
      </h2>

      <div className="lb-me" role="group" aria-label="Your team" data-testid="lb-me">
        <span className="lb-cell lb-rank" aria-label="Your rank">
          {me.rank === null ? "—" : `#${me.rank}`}
        </span>
        <span className="lb-cell lb-team" aria-label="Your team ID">
          {me.teamId}
        </span>
        <span className="lb-cell lb-score" aria-label="Your score">
          {me.score ?? "—"}
        </span>
      </div>

      <div className="lb-scroll" role="region" aria-label="Team standings" tabIndex={0}>
        <table className="lb-table">
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col">Team_ID</th>
              <th scope="col">Score</th>
            </tr>
          </thead>
          <tbody>
            {board.map((row) => (
              <tr
                key={row.rank}
                className={cn(row.teamId !== null && row.teamId === me.teamId && "lb-mine")}
              >
                <td>#{row.rank}</td>
                <td>{row.teamId}</td>
                <td>{row.score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </aside>
  );
}

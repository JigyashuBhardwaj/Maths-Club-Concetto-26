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
  /** The signed-in team's own line. Rank and score stay `null` until participants have a leaderboard snapshot (later patch). */
  me: { rank: number | null; teamId: string; score: number | null };
  /** Test seam; defaults to the empty source because no teams exist yet. */
  source?: LeaderboardSource;
  intervalMs?: number;
}

export function Leaderboard({
  me,
  source = emptyLeaderboardSource,
  intervalMs = LEADERBOARD_REFRESH_MS,
}: LeaderboardProps) {
  const { rows } = useLeaderboard(source, intervalMs);
  const board = withPlaceholderRows(rows, MAX_TEAMS);

  return (
    <aside className="leaderboard" aria-labelledby="leaderboard-title">
      <h2 id="leaderboard-title" className="lb-title">
        Live Leaderboard
      </h2>

      <div className="lb-me" role="group" aria-label="Your team">
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

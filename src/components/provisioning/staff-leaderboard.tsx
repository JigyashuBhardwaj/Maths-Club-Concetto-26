"use client";

import { useEffect, useState } from "react";

import { leaderboardResultSchema, type LeaderboardResult } from "@/lib/contracts/provisioning";
import { createBoardPoller } from "@/lib/home/board-poller";
import { LEADERBOARD_JITTER, LEADERBOARD_REFRESH_MS } from "@/lib/home/leaderboard";

type Rows = LeaderboardResult["rows"];

interface StaffLeaderboardProps {
  /** The server-rendered first paint; `null` when it could not be read (the board then fetches at once). */
  initialRows: Rows | null;
  intervalMs?: number;
  /** Replaced in tests. */
  fetchImpl?: typeof fetch;
}

async function fetchRows(fetchImpl: typeof fetch): Promise<Rows> {
  const response = await fetchImpl("/api/leaderboard", {
    credentials: "same-origin",
    cache: "no-store",
  });
  const body: unknown = await response.json();
  const envelope = body as { ok?: unknown; data?: unknown } | null;
  if (!response.ok || envelope?.ok !== true) throw new Error("leaderboard");
  const parsed = leaderboardResultSchema.safeParse(envelope.data);
  if (!parsed.success) throw new Error("leaderboard");
  return parsed.data.rows;
}

/**
 * The Admin / Super Admin live leaderboard: rank 1 to the number of teams, Team ID and Score. It is the same board for
 * every staff member and has no "your team" row (a staff member has no team). It refreshes through the shared poller (15 s,
 * jittered, never overlapping, paused while the tab is hidden), keeps the last good rows if a refresh fails, and holds only
 * what the server returned for this request.
 */
export function StaffLeaderboard({
  initialRows,
  intervalMs = LEADERBOARD_REFRESH_MS,
  fetchImpl,
}: StaffLeaderboardProps) {
  const [rows, setRows] = useState<Rows>(initialRows ?? []);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const doFetch = fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const poller = createBoardPoller<Rows>({
      load: () => fetchRows(doFetch),
      intervalMs,
      jitter: LEADERBOARD_JITTER,
      // the server rendered the first paint: the first refresh is one (jittered) interval away
      immediate: initialRows === null,
      onData: (next) => {
        setRows(next);
        setStale(false);
      },
      onError: () => setStale(true),
    });
    poller.start();
    return () => poller.stop();
  }, [initialRows, intervalMs, fetchImpl]);

  return (
    <aside className="leaderboard h-full" aria-labelledby="staff-leaderboard-title">
      <h2 id="staff-leaderboard-title" className="lb-title">
        Live Leaderboard
      </h2>
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
            {rows.map((row) => (
              <tr key={row.team_id}>
                <td>#{row.rank}</td>
                <td>{row.team_id}</td>
                <td>{row.score}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <p className="py-6 text-xs text-ink-dim">No teams yet.</p> : null}
      </div>
      {stale ? (
        <p role="status" className="pt-2 text-[11px] text-ink-dim">
          Couldn&apos;t refresh. Showing the last results.
        </p>
      ) : null}
    </aside>
  );
}

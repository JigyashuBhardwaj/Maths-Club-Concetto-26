"use client";

import { useEffect, useRef, useState } from "react";

import { createBoardPoller, type BoardPoller } from "./board-poller";
import {
  LEADERBOARD_JITTER,
  LEADERBOARD_REFRESH_MS,
  type LeaderboardRow,
  type LeaderboardSnapshot,
  type LeaderboardSource,
  type RankedLine,
} from "./leaderboard";

export interface LeaderboardState {
  /** The server's ranking, in the server's order. */
  rows: LeaderboardRow[];
  /** The signed-in team's own line from the same snapshot; `null` before the first refresh. */
  me: RankedLine | null;
  /** Epoch ms of the last successful refresh; `null` before the first one. */
  updatedAt: number | null;
  error: boolean;
}

/**
 * Polls `source` through `createBoardPoller` (15 s by default with +/- 20 % jitter, no overlapping requests, paused while
 * the tab is hidden, backs off on failure). The rows are the server's, in the server's order; the last good rows stay on
 * failure. `refreshKey` (the team's own state version) asks for a prompt, throttled refresh when it changes - a purchase,
 * an approval becoming visible, a finished theme or a finalisation moves this team's score.
 */
export function useLeaderboard(
  source: LeaderboardSource,
  intervalMs: number = LEADERBOARD_REFRESH_MS,
  refreshKey?: number | null,
): LeaderboardState {
  const [state, setState] = useState<LeaderboardState>({
    rows: [],
    me: null,
    updatedAt: null,
    error: false,
  });
  const pollerRef = useRef<BoardPoller | null>(null);
  const firstKey = useRef(true);

  useEffect(() => {
    const poller = createBoardPoller<LeaderboardSnapshot>({
      load: source,
      intervalMs,
      jitter: LEADERBOARD_JITTER,
      onData: (snapshot) =>
        setState({
          rows: snapshot.rows.map((r) => ({ rank: r.rank, teamId: r.teamId, score: r.score })),
          me: snapshot.me,
          updatedAt: Date.now(),
          error: false,
        }),
      onError: () => setState((prev) => ({ ...prev, error: true })),
    });
    pollerRef.current = poller;
    poller.start();
    return () => {
      pollerRef.current = null;
      poller.stop();
    };
  }, [source, intervalMs]);

  useEffect(() => {
    if (firstKey.current) {
      firstKey.current = false;
      return;
    }
    if (refreshKey !== undefined && refreshKey !== null) pollerRef.current?.refreshSoon();
  }, [refreshKey]);

  return state;
}

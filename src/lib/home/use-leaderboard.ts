"use client";

import { useEffect, useState } from "react";

import {
  LEADERBOARD_REFRESH_MS,
  rankEntries,
  type LeaderboardRow,
  type LeaderboardSource,
} from "./leaderboard";

export interface LeaderboardState {
  rows: LeaderboardRow[];
  /** Epoch ms of the last successful refresh; `null` before the first one. */
  updatedAt: number | null;
  error: boolean;
}

/**
 * Polls `source` once on mount and then every `intervalMs` (default 1 minute).
 * Polling is the source of truth (realtime is only an enhancement): it pauses while the tab is hidden,
 * refreshes right away when the tab becomes visible and is stale, keeps the last good rows on failure,
 * and ignores responses that arrive after unmount.
 */
export function useLeaderboard(
  source: LeaderboardSource,
  intervalMs: number = LEADERBOARD_REFRESH_MS,
): LeaderboardState {
  const [state, setState] = useState<LeaderboardState>({ rows: [], updatedAt: null, error: false });

  useEffect(() => {
    let alive = true;
    let lastRun = 0;

    const refresh = async () => {
      lastRun = Date.now();
      try {
        const entries = await source();
        if (alive) setState({ rows: rankEntries(entries), updatedAt: Date.now(), error: false });
      } catch {
        if (alive) setState((prev) => ({ ...prev, error: true }));
      }
    };

    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, intervalMs);
    const onVisibility = () => {
      if (!document.hidden && Date.now() - lastRun >= intervalMs) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [source, intervalMs]);

  return state;
}

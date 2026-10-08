"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { TeamState } from "@/lib/contracts/runtime";
import { fetchTeamState } from "@/lib/gameplay/client";
import { clockOffset, isNewer, serverTime } from "@/lib/gameplay/derive";

/** Until realtime ships (REALTIME_SPEC), polling is the whole sync path: 5 s ± 1 s while the tab is visible. */
export const POLL_MS = 5000;
const JITTER_MS = 1000;
/** After a deadline passes, refetch shortly after so the server's own view (timeouts, themes) replaces the estimate. */
const DEADLINE_SLACK_MS = 400;
/** A full page load, so no stale page or router cache survives the end of the session. */
const navigate = (url: string) => window.location.assign(url);

export interface GameValue {
  /** The latest authoritative snapshot; `null` until the first one arrives. */
  state: TeamState | null;
  /** True once the first load has failed (and until a later one succeeds): show a retry, not a blank page. */
  loadFailed: boolean;
  /** True while the last refresh failed (offline / server unreachable): the screen shows "reconnecting". */
  reconnecting: boolean;
  /** Estimated server time (epoch ms) right now. */
  serverNow: () => number;
  refresh: () => Promise<void>;
  /** Adopt a snapshot returned by an action (ignored if an even newer one is already held). */
  apply: (snapshot: TeamState, receivedAt?: number) => void;
}

const GameContext = createContext<GameValue | null>(null);

/**
 * Holds the team snapshot for every participant page (it lives in the layout, so it survives client-side navigation).
 * The database is the only source of truth: the snapshot is replaced wholesale by whatever the server last said, with
 * the database clock deciding which of two snapshots is newer (so an out-of-order response can never roll the screen
 * back). It refetches on a jittered 5 s poll, when the tab becomes visible or focused, when the network returns, and
 * shortly after the soonest deadline it knows about.
 */
export function GameProvider({
  initial,
  children,
}: {
  initial: TeamState | null;
  children: ReactNode;
}) {
  const [state, setState] = useState<TeamState | null>(initial);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const stateRef = useRef<TeamState | null>(initial);
  const offsetRef = useRef<number | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const alive = useRef(true);

  const adopt = useCallback((snapshot: TeamState, sentAt: number, receivedAt: number) => {
    if (!isNewer(snapshot, stateRef.current)) return;
    stateRef.current = snapshot;
    // the response was produced somewhere inside [sentAt, receivedAt]: assume the middle
    offsetRef.current = clockOffset(snapshot.server_now, (sentAt + receivedAt) / 2);
    setState(snapshot);
  }, []);

  const refresh = useCallback((): Promise<void> => {
    if (inflight.current) return inflight.current;
    const run = (async () => {
      const sentAt = Date.now();
      const r = await fetchTeamState();
      if (!alive.current) return;
      if (r.ok) {
        adopt(r.data, sentAt, Date.now());
        setLoadFailed(false);
        setReconnecting(false);
        return;
      }
      if (r.status === 401) {
        // The session ended (signed out elsewhere, revoked, expired): leave through the normal login page.
        navigate("/login/participant");
        return;
      }
      if (stateRef.current) setReconnecting(true);
      else setLoadFailed(true);
    })().finally(() => {
      inflight.current = null;
    });
    inflight.current = run;
    return run;
  }, [adopt]);

  const apply = useCallback(
    (snapshot: TeamState, receivedAt: number = Date.now()) =>
      adopt(snapshot, receivedAt, receivedAt),
    [adopt],
  );

  const serverNow = useCallback(() => {
    // Before the first fetch completes, align to the snapshot the page was rendered with (the first refresh then
    // replaces this with a measured offset).
    if (offsetRef.current === null) {
      if (!stateRef.current) return Date.now();
      offsetRef.current = clockOffset(stateRef.current.server_now, Date.now());
    }
    return serverTime(Date.now(), offsetRef.current);
  }, []);

  // initial alignment + polling + wake-up triggers
  useEffect(() => {
    alive.current = true;
    void refresh();
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          if (!document.hidden) void refresh();
          schedule();
        },
        POLL_MS + (Math.random() * 2 - 1) * JITTER_MS,
      );
    };
    schedule();
    const wake = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => {
      alive.current = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [refresh]);

  // one-shot refetch right after the soonest known deadline (team end or an ACTIVE question)
  useEffect(() => {
    if (!state) return;
    const deadlines = [
      state.team.status === "RUNNING" ? state.team.ends_at : null,
      ...state.themes.flatMap((t) =>
        t.questions.map((q) => (q.state === "ACTIVE" ? (q.deadline ?? null) : null)),
      ),
    ].filter((d): d is number => d !== null);
    if (state.competition.status !== "RUNNING" || deadlines.length === 0) return;
    const wait = Math.min(...deadlines) - serverNow() + DEADLINE_SLACK_MS;
    if (wait <= 0 || wait > 2 ** 31 - 1) return;
    const t = setTimeout(() => void refresh(), wait);
    return () => clearTimeout(t);
  }, [state, refresh, serverNow]);

  const value = useMemo<GameValue>(
    () => ({ state, loadFailed, reconnecting, serverNow, refresh, apply }),
    [state, loadFailed, reconnecting, serverNow, refresh, apply],
  );
  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame(): GameValue {
  const v = useContext(GameContext);
  if (!v) throw new Error("useGame must be used inside <GameProvider>");
  return v;
}

/** Server-aligned "now" (epoch ms), re-rendered every `everyMs`. The first render is deterministic for hydration. */
export function useServerNow(everyMs = 500): number {
  const { state, serverNow } = useGame();
  const [now, setNow] = useState<number>(state?.server_now ?? 0);
  useEffect(() => {
    const first = setTimeout(() => setNow(serverNow()), 0);
    const t = setInterval(() => setNow(serverNow()), everyMs);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [serverNow, everyMs]);
  return now;
}

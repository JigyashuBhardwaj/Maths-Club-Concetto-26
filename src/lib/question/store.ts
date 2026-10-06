"use client";

/**
 * Client-side demo store (sessionStorage + useSyncExternalStore). Lets the home page and the
 * question page share the demo state in one browser tab. Replaced by server snapshots later.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

import { initialState, settle, type DemoState } from "./engine";

const KEY = "concetto-demo-v1";
const listeners = new Set<() => void>();
let state: DemoState | null = null;
let loaded = false;

function read(now: number): DemoState {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DemoState;
      if (
        parsed &&
        parsed.version === 1 &&
        Array.isArray(parsed.unlocked) &&
        typeof parsed.coins === "number"
      ) {
        return parsed;
      }
    }
  } catch {
    /* storage unavailable or corrupt: start fresh */
  }
  return initialState(now);
}

function persist(next: DemoState) {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* works in memory only */
  }
}

function getSnapshot(): DemoState | null {
  if (typeof window === "undefined") return null;
  if (!loaded) {
    loaded = true;
    state = settle(read(Date.now()), Date.now());
  }
  return state;
}

const getServerSnapshot = (): DemoState | null => null;

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Apply a pure engine function to the shared state. */
export function dispatch(fn: (s: DemoState, now: number) => DemoState) {
  const current = getSnapshot();
  if (!current) return;
  const now = Date.now();
  const next = fn(current, now);
  if (next === current) return;
  state = next;
  persist(next);
  listeners.forEach((l) => l());
}

export function resetDemo() {
  loaded = true;
  state = initialState(Date.now());
  persist(state);
  listeners.forEach((l) => l());
}

/** Test helper: forget everything, including what sessionStorage holds. */
export function __resetDemoStoreForTests() {
  loaded = false;
  state = null;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

/** Null on the server and during hydration, then the live demo state. */
export function useDemoState(): DemoState | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Epoch ms, updated every `ms`; null until mounted. Also times out expired questions. */
export function useClock(ms = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => {
      const t = Date.now();
      setNow(t);
      dispatch((s) => settle(s, t));
    };
    tick();
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

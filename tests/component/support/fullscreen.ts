import { vi } from "vitest";

import type { FullscreenDriver, FullscreenFailure } from "@/lib/fullscreen/driver";

/**
 * A controllable stand-in for the browser's Fullscreen API (jsdom has none). It is a MOCK: tests that use it prove the
 * application's rules, not the browser's behaviour; the real-browser behaviour is covered by tests/e2e/fullscreen.spec.ts.
 */
export function makeFullscreenDriver(
  initial: { supported?: boolean; active?: boolean; mode?: "ok" | "reject" | "noop" } = {},
) {
  let active = initial.active ?? false;
  let supported = initial.supported ?? true;
  let mode: "ok" | "reject" | "noop" = initial.mode ?? "ok";
  const listeners = new Set<() => void>();
  const fire = () => [...listeners].forEach((l) => l());

  const request = vi.fn(
    async (): Promise<{ ok: true } | { ok: false; reason: FullscreenFailure }> => {
      if (!supported) return { ok: false, reason: "UNSUPPORTED" };
      if (active) return { ok: true };
      if (mode === "reject") return { ok: false, reason: "DENIED" };
      if (mode === "noop") return { ok: false, reason: "NOT_ESTABLISHED" };
      active = true;
      fire();
      return { ok: true };
    },
  );
  const driver: FullscreenDriver = {
    supported: () => supported,
    active: () => active,
    request,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    driver,
    request,
    listenerCount: () => listeners.size,
    /** The participant (or the browser) leaves fullscreen: Escape, a browser control, anything. Fires `fullscreenchange`. */
    exit() {
      active = false;
      fire();
    },
    /** Leaves fullscreen WITHOUT any event: what a page that is restored from the back/forward cache can find. */
    silentExit() {
      active = false;
    },
    /** Fires `fullscreenchange` without changing the state (browsers can deliver duplicate events). */
    duplicateEvent: fire,
    set(next: { supported?: boolean; mode?: "ok" | "reject" | "noop" }) {
      if (next.supported !== undefined) supported = next.supported;
      if (next.mode !== undefined) mode = next.mode;
    },
    isActive: () => active,
  };
}
export type FullscreenHarness = ReturnType<typeof makeFullscreenDriver>;

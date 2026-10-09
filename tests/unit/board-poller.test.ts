// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBoardPoller } from "@/lib/home/board-poller";

/**
 * The polling rhythm of every live leaderboard (B16 review): 15 s with jitter, never two requests at once, nothing while
 * the tab is hidden, a prompt (throttled, coalesced) refresh after the team's own events, back-off on failure.
 */
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

interface Setup {
  random?: () => number;
  load?: () => Promise<number>;
  immediate?: boolean;
  jitter?: number;
}

function setup(o: Setup = {}) {
  let hidden = false;
  const seen: number[] = [];
  let errors = 0;
  let n = 0;
  const load = vi.fn(o.load ?? (async () => ++n));
  const poller = createBoardPoller<number>({
    load,
    onData: (d) => seen.push(d),
    onError: () => errors++,
    intervalMs: 15_000,
    jitter: o.jitter ?? 0.2,
    random: o.random ?? (() => 0.5),
    isHidden: () => hidden,
    immediate: o.immediate,
  });
  return {
    poller,
    load,
    seen,
    errors: () => errors,
    hide() {
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    show() {
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
}
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("createBoardPoller", () => {
  it("fetches at once, then every 15 s", async () => {
    const t = setup();
    t.poller.start();
    await tick(0);
    expect(t.load).toHaveBeenCalledTimes(1);
    await tick(14_999);
    expect(t.load).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(t.load).toHaveBeenCalledTimes(2);
    await tick(15_000);
    expect(t.load).toHaveBeenCalledTimes(3);
    t.poller.stop();
  });

  it("randomises every wait by +/- 20 % so clients do not arrive together", async () => {
    for (const [random, wait] of [
      [0, 12_000],
      [1, 18_000],
    ] as const) {
      const t = setup({ random: () => random });
      t.poller.start();
      await tick(0);
      await tick(wait - 1);
      expect(t.load).toHaveBeenCalledTimes(1);
      await tick(1);
      expect(t.load).toHaveBeenCalledTimes(2);
      t.poller.stop();
    }
    // and 300 clients with different random draws spread over the whole 12-18 s window
    const waits = Array.from({ length: 300 }, (_, i) =>
      Math.round(15_000 * (1 + 0.2 * (2 * (i / 299) - 1))),
    );
    expect(Math.min(...waits)).toBe(12_000);
    expect(Math.max(...waits)).toBe(18_000);
    expect(new Set(waits.map((w) => Math.floor(w / 1000))).size).toBeGreaterThanOrEqual(6);
  });

  it("with a server-rendered first paint the first refresh is one interval away", async () => {
    const t = setup({ immediate: false });
    t.poller.start();
    await tick(14_000);
    expect(t.load).not.toHaveBeenCalled();
    await tick(1_000);
    expect(t.load).toHaveBeenCalledTimes(1);
    t.poller.stop();
  });

  it("never has two requests in flight: a slow response delays the next one, it does not overlap it", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    let inFlightNow = 0;
    let maxInFlight = 0;
    const t = setup({
      load: () =>
        new Promise<number>((resolve) => {
          calls++;
          inFlightNow++;
          maxInFlight = Math.max(maxInFlight, inFlightNow);
          release = () => {
            inFlightNow--;
            resolve(calls);
          };
        }),
    });
    t.poller.start();
    await tick(0);
    await tick(17_000); // past the 15 s interval (and the throttle), the first request is still pending
    expect(calls).toBe(1);
    t.poller.refreshSoon(); // an event while in flight
    t.poller.refreshSoon();
    await tick(2_500);
    expect(calls).toBe(1);
    release!();
    await tick(2_100); // exactly ONE follow-up for the event(s), after the first settled
    expect(calls).toBe(2);
    release!();
    expect(maxInFlight).toBe(1);
    t.poller.stop();
  });

  it("an event refreshes soon, throttled to one per 2 s and coalesced", async () => {
    const t = setup();
    t.poller.start();
    await tick(0);
    expect(t.load).toHaveBeenCalledTimes(1);
    t.poller.refreshSoon();
    t.poller.refreshSoon();
    t.poller.refreshSoon();
    await tick(1_900);
    expect(t.load).toHaveBeenCalledTimes(1);
    await tick(200);
    expect(t.load).toHaveBeenCalledTimes(2); // three events, one request
    // an event long after the last request is answered immediately
    await tick(8_000);
    t.poller.refreshSoon();
    await tick(0);
    expect(t.load).toHaveBeenCalledTimes(3);
    t.poller.stop();
  });

  it("sends nothing while the tab is hidden and refreshes when it comes back (stale data)", async () => {
    const t = setup();
    t.poller.start();
    await tick(0);
    t.hide();
    await tick(120_000);
    expect(t.load).toHaveBeenCalledTimes(1); // two minutes hidden: no request at all
    t.poller.refreshSoon(); // an event while hidden waits too
    await tick(10_000);
    expect(t.load).toHaveBeenCalledTimes(1);
    t.show();
    await tick(1_000); // within the 0-1 s return jitter
    expect(t.load).toHaveBeenCalledTimes(2);
    await tick(15_000); // and the normal rhythm resumes
    expect(t.load).toHaveBeenCalledTimes(3);
    t.poller.stop();
  });

  it("a short absence does not trigger an extra request", async () => {
    const t = setup();
    t.poller.start();
    await tick(0);
    await tick(3_000);
    t.hide();
    await tick(1_000);
    t.show();
    await tick(500);
    expect(t.load).toHaveBeenCalledTimes(1);
    await tick(12_000);
    expect(t.load).toHaveBeenCalledTimes(2);
    t.poller.stop();
  });

  it("keeps going after a failure, backs off (x2, x4, ... up to 60 s) and recovers", async () => {
    let fail = true;
    const t = setup({
      load: async () => {
        if (fail) throw new Error("down");
        return 7;
      },
    });
    t.poller.start();
    await tick(0);
    expect(t.errors()).toBe(1);
    await tick(29_999); // 15 s x 2
    expect(t.load).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(t.load).toHaveBeenCalledTimes(2);
    await tick(59_999); // 15 s x 4
    expect(t.load).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(t.load).toHaveBeenCalledTimes(3);
    fail = false;
    await tick(60_000); // capped at 60 s
    expect(t.load).toHaveBeenCalledTimes(4);
    expect(t.seen).toEqual([7]);
    await tick(15_000); // back to the normal rhythm
    expect(t.load).toHaveBeenCalledTimes(5);
    t.poller.stop();
  });

  it("abandons a request that never settles and ignores its late answer", async () => {
    let n = 0;
    let late: ((v: number) => void) | undefined;
    const t = setup({
      load: () =>
        ++n === 1
          ? new Promise<number>((r) => {
              late = r;
            })
          : Promise.resolve(n),
    });
    t.poller.start();
    await tick(0);
    await tick(20_000);
    expect(t.errors()).toBe(1);
    await tick(60_000);
    const before = [...t.seen];
    expect(before.length).toBeGreaterThan(0);
    late!(999); // the abandoned request answers much later
    await tick(0);
    expect(t.seen).toEqual(before); // not shown
    t.poller.stop();
  });

  it("stop() cancels everything", async () => {
    const t = setup();
    t.poller.start();
    await tick(0);
    t.poller.refreshSoon();
    t.poller.stop();
    t.poller.refreshSoon();
    await tick(120_000);
    expect(t.load).toHaveBeenCalledTimes(1);
  });
});

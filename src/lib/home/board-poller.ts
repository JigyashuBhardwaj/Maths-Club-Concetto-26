/**
 * The one polling loop of every live leaderboard (participant, Admin, Super Admin). Framework-free so it can be tested with
 * a fake clock. It never ranks or computes anything: it only decides WHEN to ask the server for the next snapshot.
 *
 *  - Regular refresh: one request per `intervalMs`, each wait randomised by +/- `jitter` (so clients desynchronise).
 *  - Never two requests at once. An event that arrives while a request is in flight is remembered and answered by ONE
 *    follow-up request after it settles (the running one may have been read before the event).
 *  - Hidden tab: nothing is sent. On return, a refresh is made (after a short random delay) if the data is older than the
 *    interval or an event was missed; otherwise the normal rhythm resumes.
 *  - Event refresh (`refreshSoon`): the team's own purchase / approval / theme completion / finalisation. Throttled to one
 *    per `minGapMs`.
 *  - Failure: the last good rows stay on screen (the caller's `onError` only flags it); the next wait doubles up to
 *    `maxBackoffMs`, so a struggling server is not hammered. A request that never settles is abandoned after `watchdogMs`.
 */
export interface BoardPollerOptions<T> {
  load: () => Promise<T>;
  onData: (data: T) => void;
  onError: () => void;
  intervalMs: number;
  /** Ratio of `intervalMs` (0.2 = +/- 20 %). */
  jitter?: number;
  minGapMs?: number;
  maxBackoffMs?: number;
  watchdogMs?: number;
  /** Fetch at once on `start` (default) or wait one interval first (the first paint was rendered by the server). */
  immediate?: boolean;
  /** Replaced in tests. */
  random?: () => number;
  isHidden?: () => boolean;
  now?: () => number;
}

export interface BoardPoller {
  start(): void;
  stop(): void;
  /** Ask for a refresh soon (throttled, coalesced, never overlapping). */
  refreshSoon(): void;
}

export function createBoardPoller<T>(options: BoardPollerOptions<T>): BoardPoller {
  const {
    load,
    onData,
    onError,
    intervalMs,
    jitter = 0.2,
    minGapMs = 2000,
    maxBackoffMs = 60_000,
    watchdogMs = 20_000,
    immediate = true,
    random = Math.random,
    isHidden = () => typeof document !== "undefined" && document.hidden,
    now = Date.now,
  } = options;

  let alive = false;
  let inFlight = false;
  let queued = false;
  let missedWhileHidden = false;
  let failures = 0;
  let requestId = 0;
  let lastStart = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let returning: ReturnType<typeof setTimeout> | undefined;

  const nextDelay = () => {
    const base = failures === 0 ? intervalMs : Math.min(maxBackoffMs, intervalMs * 2 ** failures);
    return Math.max(0, Math.round(base * (1 + jitter * (2 * random() - 1))));
  };

  const schedule = () => {
    if (!alive) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!alive) return;
      if (isHidden()) {
        missedWhileHidden = true; // the visibility handler resumes the rhythm
        return;
      }
      void run();
    }, nextDelay());
  };

  const settle = () => {
    if (!alive) return;
    if (queued) {
      queued = false;
      refreshSoon();
    }
    schedule();
  };

  async function run(): Promise<void> {
    if (!alive) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    const id = ++requestId;
    lastStart = now();
    watchdog = setTimeout(() => {
      if (id !== requestId || !inFlight) return;
      inFlight = false;
      requestId += 1; // whatever this request returns later is ignored
      failures += 1;
      onError();
      settle();
    }, watchdogMs);
    try {
      const data = await load();
      if (id !== requestId || !alive) return;
      failures = 0;
      onData(data);
    } catch {
      if (id !== requestId || !alive) return;
      failures += 1;
      onError();
    }
    if (id === requestId) {
      if (watchdog) clearTimeout(watchdog);
      inFlight = false;
      settle();
    }
  }

  function refreshSoon(): void {
    if (!alive) return;
    if (isHidden()) {
      missedWhileHidden = true;
      return;
    }
    if (inFlight) {
      queued = true;
      return;
    }
    if (trailing) return;
    trailing = setTimeout(
      () => {
        trailing = undefined;
        void run();
      },
      Math.max(0, minGapMs - (now() - lastStart)),
    );
  }

  const onVisibility = () => {
    if (!alive || isHidden()) return;
    const stale = now() - lastStart >= intervalMs * (1 - jitter);
    if (missedWhileHidden || stale) {
      missedWhileHidden = false;
      if (returning) clearTimeout(returning);
      // many tabs may come back together (a projector, a lock screen): spread them over a second
      returning = setTimeout(
        () => {
          returning = undefined;
          void run();
        },
        Math.round(random() * 1000),
      );
    } else if (!timer && !inFlight) {
      schedule();
    }
  };

  return {
    start() {
      if (alive) return;
      alive = true;
      if (typeof document !== "undefined")
        document.addEventListener("visibilitychange", onVisibility);
      if (immediate) void run();
      else {
        lastStart = now();
        schedule();
      }
    },
    stop() {
      alive = false;
      for (const t of [timer, trailing, watchdog, returning]) if (t) clearTimeout(t);
      timer = trailing = watchdog = returning = undefined;
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", onVisibility);
    },
    refreshSoon,
  };
}

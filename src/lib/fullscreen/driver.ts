/**
 * The browser's Fullscreen API behind a small interface, so the rules built on it (when fullscreen counts as
 * established, when leaving it ends a session) can be tested without a real browser, and so nothing else in the app
 * touches `document.fullscreenElement` directly.
 *
 * Fullscreen can only be entered from a user gesture (a click); the page never tries on load. The whole document is
 * the fullscreen element, so dialogs (which live in the top layer) stay visible.
 */
export type FullscreenFailure =
  /** The browser has no document Fullscreen API (e.g. iPhone Safari), or fullscreen is disabled for this page. */
  | "UNSUPPORTED"
  /** The request was rejected: no user gesture, a permissions policy, or the browser said no. */
  | "DENIED"
  /** The request resolved, but the document is not in fullscreen afterwards. */
  | "NOT_ESTABLISHED";

export type FullscreenRequest = { ok: true } | { ok: false; reason: FullscreenFailure };

export interface FullscreenDriver {
  supported(): boolean;
  /** True while the document is actually in fullscreen. */
  active(): boolean;
  /** Request fullscreen; resolves ok only if the document really is in fullscreen afterwards. */
  request(): Promise<FullscreenRequest>;
  /** Calls `listener` on every fullscreen change (enter or exit). Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export const browserFullscreen: FullscreenDriver = {
  supported() {
    return (
      typeof document !== "undefined" &&
      document.fullscreenEnabled === true &&
      typeof document.documentElement.requestFullscreen === "function"
    );
  },
  active() {
    return typeof document !== "undefined" && document.fullscreenElement != null;
  },
  async request() {
    if (!browserFullscreen.supported()) return { ok: false, reason: "UNSUPPORTED" };
    if (browserFullscreen.active()) return { ok: true };
    try {
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    } catch {
      return { ok: false, reason: "DENIED" };
    }
    return browserFullscreen.active() ? { ok: true } : { ok: false, reason: "NOT_ESTABLISHED" };
  },
  subscribe(listener) {
    document.addEventListener("fullscreenchange", listener);
    return () => document.removeEventListener("fullscreenchange", listener);
  },
};

/** What the participant reads when fullscreen could not be established. Fixed wording by reason. */
export function fullscreenErrorText(reason: FullscreenFailure): string {
  switch (reason) {
    case "UNSUPPORTED":
      return "This browser can't show the competition in fullscreen, so you can't start here. Use a current desktop browser such as Chrome, Edge or Firefox.";
    case "DENIED":
      return "The browser didn't allow fullscreen. Allow it for this site if asked, then press the button again.";
    default:
      return "Fullscreen didn't start. Press the button again.";
  }
}

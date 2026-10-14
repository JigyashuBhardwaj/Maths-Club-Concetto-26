import type { BrowserContext, Page } from "@playwright/test";

/**
 * A stand-in for the participant's fullscreen, for the specs that test the COMPETITION (gameplay, economy, scoring ...),
 * not the browser. Since B19 a participant must enter fullscreen before anything else; those specs would otherwise all
 * have to click the gate and live inside a real fullscreen window. With this installed in a browser context:
 *
 * - `requestFullscreen()` always succeeds, `document.fullscreenElement` / `fullscreenEnabled` report it, and
 *   `exitFullscreen()` leaves it (firing `fullscreenchange`), exactly as the API's shape goes;
 * - the "Enter fullscreen" button of the gate for an already-running team is pressed for the participant, the way
 *   the person would press it. (The first member's "Enter competition" button is still pressed by the spec itself.)
 *
 * - Reloads and typed addresses do not end the session under the mock. In a real browser they leave fullscreen, and
 *   since B19-r2 the application then ends the session (a `keepalive` logout while the page unloads, and a per-tab
 *   hint read by the next page). Specs that merely navigate between pages are about the competition, not about that,
 *   so the mock drops the unload-time logout request and forgets the hint at the start of every document.
 *
 * THIS IS A MOCK. Nothing here proves anything about real fullscreen: that is tests/e2e/fullscreen.spec.ts, which
 * never installs it.
 */
export async function installFullscreenShim(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      window.sessionStorage.removeItem("mc26.fullscreen.member");
    } catch {
      // no storage: nothing to forget
    }
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) =>
      init?.keepalive && String(input).endsWith("/api/auth/logout")
        ? Promise.resolve(new Response("{}", { status: 200 })) // the unload-time logout of a mocked fullscreen
        : realFetch(input, init);
    let element: Element | null = null;
    const fire = () => document.dispatchEvent(new Event("fullscreenchange"));
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => true });
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => element,
    });
    Element.prototype.requestFullscreen = function (this: Element) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- the mock records which element asked
      element = this;
      fire();
      return Promise.resolve();
    };
    document.exitFullscreen = () => {
      element = null;
      fire();
      return Promise.resolve();
    };
    new MutationObserver(() => {
      for (const b of document.querySelectorAll<HTMLButtonElement>("dialog.entry-gate button")) {
        if (b.textContent?.trim() === "Enter fullscreen" && !b.disabled) b.click();
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
}

/**
 * Waits until the mocked fullscreen gate has been passed (the shim presses it once the server snapshot has arrived).
 * Specs that press something on the page right after `goto` call it first, so their action cannot land under the gate.
 */
export const fullscreenSettled = (page: Page) =>
  page.waitForFunction(() => document.fullscreenElement !== null);

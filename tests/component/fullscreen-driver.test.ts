// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browserFullscreen, fullscreenErrorText } from "@/lib/fullscreen/driver";
import {
  FULLSCREEN_NOTICE,
  markFullscreenEnded,
  participantLoginUrl,
  resetFullscreenEnded,
} from "@/lib/fullscreen/session-end";

/** The real browser driver, against a jsdom `document` whose Fullscreen API is replaced by controllable properties. */
let fullscreenElement: Element | null = null;
let enabled = true;

function defineApi(request?: () => Promise<void>) {
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => enabled });
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  });
  Object.defineProperty(document.documentElement, "requestFullscreen", {
    configurable: true,
    value: request,
    writable: true,
  });
}

beforeEach(() => {
  fullscreenElement = null;
  enabled = true;
  resetFullscreenEnded();
});
afterEach(() => vi.restoreAllMocks());

describe("browserFullscreen", () => {
  it("is unsupported without the API or when the browser disables it for the page", async () => {
    defineApi(undefined);
    expect(browserFullscreen.supported()).toBe(false);
    expect(await browserFullscreen.request()).toEqual({ ok: false, reason: "UNSUPPORTED" });
    defineApi(vi.fn(async () => undefined));
    enabled = false;
    expect(browserFullscreen.supported()).toBe(false);
    expect(await browserFullscreen.request()).toEqual({ ok: false, reason: "UNSUPPORTED" });
  });

  it("requests fullscreen on the whole document, and is ok only when the document really is fullscreen afterwards", async () => {
    const request = vi.fn(async () => {
      fullscreenElement = document.documentElement;
    });
    defineApi(request);
    expect(await browserFullscreen.request()).toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(browserFullscreen.active()).toBe(true);
  });

  it("an already-fullscreen document needs no request", async () => {
    const request = vi.fn(async () => undefined);
    defineApi(request);
    fullscreenElement = document.documentElement;
    expect(await browserFullscreen.request()).toEqual({ ok: true });
    expect(request).not.toHaveBeenCalled();
  });

  it("a rejected request is DENIED; a request that resolves without fullscreen is NOT_ESTABLISHED", async () => {
    defineApi(vi.fn(async () => Promise.reject(new TypeError("Permissions check failed"))));
    expect(await browserFullscreen.request()).toEqual({ ok: false, reason: "DENIED" });
    defineApi(vi.fn(async () => undefined));
    expect(await browserFullscreen.request()).toEqual({ ok: false, reason: "NOT_ESTABLISHED" });
  });

  it("subscribe listens to fullscreenchange and unsubscribe really removes the listener", () => {
    defineApi(async () => undefined);
    const listener = vi.fn();
    const off = browserFullscreen.subscribe(listener);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("fixed wording and the sign-in redirect", () => {
  it("each failure reason has its own fixed sentence", () => {
    const texts = (["UNSUPPORTED", "DENIED", "NOT_ESTABLISHED"] as const).map(fullscreenErrorText);
    expect(new Set(texts).size).toBe(3);
    expect(texts[0]).toMatch(/can't show the competition in fullscreen/);
    expect(texts[1]).toMatch(/didn't allow fullscreen/);
  });

  it("the participant sign-in URL carries the notice only after a fullscreen-exit logout began", () => {
    expect(participantLoginUrl()).toBe("/login/participant");
    markFullscreenEnded();
    expect(participantLoginUrl()).toBe(`/login/participant?notice=${FULLSCREEN_NOTICE}`);
  });
});

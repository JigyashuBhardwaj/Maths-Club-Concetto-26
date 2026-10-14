"use client";

import { useEffect, useSyncExternalStore } from "react";

import { forgetFullscreen, FULLSCREEN_NOTICE } from "@/lib/fullscreen/session-end";

const NOTICES: Record<string, string> = {
  [FULLSCREEN_NOTICE]:
    "Your session ended because you exited fullscreen. Sign in again to continue.",
};

const subscribe = () => () => undefined; // the query string cannot change without a page load
const read = () => new URLSearchParams(window.location.search).get("notice") ?? "";
const server = () => "";

/**
 * Says why a session ended, on the sign-in page. The page is static (it reads no cookie and no request), so the reason
 * is read in the browser from `?notice=`. The value only SELECTS one of the fixed sentences above; anything else shows
 * nothing, and the value is never rendered. Also drops the stale reload hint of the previous session.
 */
export function LoginNotice() {
  const notice = useSyncExternalStore(subscribe, read, server);
  // Nobody is signed in on this page, so a leftover "this tab was in fullscreen" hint (see session-end.ts) is stale and
  // must not end the NEXT person's session on this tab.
  useEffect(() => forgetFullscreen(), []);
  const text = Object.hasOwn(NOTICES, notice) ? NOTICES[notice] : undefined;
  if (!text) return null;
  return (
    <p
      role="status"
      className="mt-4 rounded-row border border-line px-3 py-2 text-sm text-ink"
      data-testid="login-notice"
    >
      {text}
    </p>
  );
}

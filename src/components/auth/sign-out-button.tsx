"use client";

import { useRef, useState } from "react";

import { postJson } from "@/lib/auth/client";
import { cn } from "@/lib/utils";

interface SignOutButtonProps {
  /** Where to go once the server has confirmed the session is revoked (the role's sign-in page). */
  redirectTo: string;
  className?: string;
  /** Replaced in tests; the default does a full page load so no stale page or router cache survives. */
  navigate?: (url: string) => void;
}

const defaultNavigate = (url: string) => window.location.assign(url);

/**
 * Signs out through `POST /api/auth/logout`, which revokes the session in the database and clears the cookie. The page
 * leaves only after the server says so: if the request fails the person stays signed in and is told, rather than
 * being shown a sign-in page while the session is still live.
 */
export function SignOutButton({
  redirectTo,
  className,
  navigate = defaultNavigate,
}: SignOutButtonProps) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);

  async function signOut() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    const result = await postJson<unknown>("/api/auth/logout");
    if (result.ok) {
      navigate(redirectTo);
      return; // stay "busy" while the browser navigates
    }
    inFlight.current = false;
    setBusy(false);
    setFailed(true);
  }

  return (
    <div className={cn("grid gap-1", className)}>
      <button
        type="button"
        onClick={signOut}
        disabled={busy}
        aria-busy={busy}
        className="rounded-row border border-line px-3 py-2 text-left text-xs font-semibold tracking-[0.22em] text-ink-dim uppercase transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange/70 disabled:opacity-60"
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
      {failed ? (
        <p role="alert" className="text-xs text-[#ffb08a]">
          Couldn&apos;t sign out. Please try again.
        </p>
      ) : null}
    </div>
  );
}

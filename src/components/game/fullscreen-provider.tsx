"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { postJson } from "@/lib/auth/client";
import {
  browserFullscreen,
  type FullscreenDriver,
  type FullscreenRequest,
} from "@/lib/fullscreen/driver";
import {
  forgetFullscreen,
  fullscreenWasEstablishedFor,
  markFullscreenEnded,
  participantLoginUrl,
  rememberFullscreen,
} from "@/lib/fullscreen/session-end";
import { teamFrozen } from "@/lib/gameplay/derive";

import { useGame } from "./game-provider";

/** A full page load, so no stale page or router cache survives the end of the session. */
const defaultNavigate = (url: string) => window.location.assign(url);

export interface FullscreenValue {
  /**
   * Fullscreen is enforced for this participant: the team is RUNNING and not frozen. That is the existing state model
   * (frozen = final submission, ended, disqualified, or time up), so a participant who has legitimately finished is
   * never enforced. The browser never decides this on its own: it only reads the server's snapshot.
   */
  required: boolean;
  /** This page passed the fullscreen gate (a click that really produced fullscreen) and has not left it since. */
  established: boolean;
  /**
   * Nothing that starts or reads competition content may run until this is true: fullscreen is established, or the team
   * has legitimately finished (the server's `frozen`: final submission, ended, disqualified, time up), where the
   * content is read-only. Before the snapshot has arrived, before the team has started, and after leaving fullscreen
   * it is false (fail closed), so a question cannot be entered or read behind the gate.
   */
  ready: boolean;
  /** Leaving fullscreen was detected: the session is being ended and the page is blocked. */
  ending: boolean;
  /** Request fullscreen from a click handler. Resolves ok only when the document is really in fullscreen. */
  enter: () => Promise<FullscreenRequest>;
}

const FullscreenContext = createContext<FullscreenValue | null>(null);

interface FullscreenProviderProps {
  children: ReactNode;
  /** Replaced in tests; the default is the browser's Fullscreen API. */
  driver?: FullscreenDriver;
  /** Replaced in tests; the default does a full page load. */
  navigate?: (url: string) => void;
  /** Replaced in tests; the default is `fetch`. */
  fetchImpl?: typeof fetch;
}

type EndPhase = "working" | "failed" | null;

/**
 * Participant fullscreen enforcement (B19).
 *
 * - Fullscreen is entered only from a click (`enter`, used by the entry gate) and counts as established only when the
 *   document really is in fullscreen afterwards.
 * - While it is enforced (see `required`) and established, a `fullscreenchange` that leaves fullscreen ends the
 *   session exactly once through the existing `POST /api/auth/logout` (the server revokes the session found in the
 *   cookie and clears the cookie; nothing the page knows is sent). The page is blocked by a modal meanwhile. The
 *   redirect happens only after the server says the session is revoked; a failure is shown and can be retried by hand,
 *   never silently looped, and never reported as success.
 * - Leaving fullscreen while nothing is enforced (before the team has started, after it has finished) only clears the
 *   established flag. A page load that is not in fullscreen is simply "not established": it asks for the click again.
 * - A reload (or a typed address) also leaves fullscreen, but no `fullscreenchange` reaches a page that is being
 *   destroyed. Two things cover it, and neither is a guarantee: (1) on `pagehide` a `keepalive` logout request is sent
 *   (best effort: the browser may drop it, and the page never learns the outcome); (2) a per-tab hint, written when
 *   fullscreen was established, makes the NEXT page load end the session if the team is still enforced and the hint
 *   names the same member. Same-document route changes fire neither and are not exits.
 */
export function FullscreenProvider({
  children,
  driver = browserFullscreen,
  navigate = defaultNavigate,
  fetchImpl,
}: FullscreenProviderProps) {
  const { state, serverNow } = useGame();
  const [established, setEstablished] = useState(false);
  const [phase, setPhase] = useState<EndPhase>(null);
  const armed = useRef(false);
  const endStarted = useRef(false);
  const logoutInFlight = useRef(false);
  const entering = useRef<Promise<FullscreenRequest> | null>(null);
  const stateRef = useRef(state);
  const bootChecked = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const required = state !== null && state.team.status === "RUNNING" && !state.team.frozen;
  const frozen = state !== null && state.team.frozen;

  /** Enforcement at the moment of an event, with the server-aligned clock (time may have run out since the snapshot). */
  const enforcedNow = useCallback(() => {
    const s = stateRef.current;
    return s !== null && s.team.status === "RUNNING" && !teamFrozen(s, serverNow());
  }, [serverNow]);

  const signOut = useCallback(async () => {
    if (logoutInFlight.current) return;
    logoutInFlight.current = true;
    const result = await postJson<unknown>("/api/auth/logout", undefined, fetchImpl);
    if (result.ok) {
      forgetFullscreen(); // the server confirmed: the next sign-in on this tab starts clean
      navigate(participantLoginUrl());
      return; // stay blocked while the browser navigates
    }
    logoutInFlight.current = false;
    setPhase("failed");
  }, [fetchImpl, navigate]);

  const beginEnd = useCallback(() => {
    if (endStarted.current) return; // at most once per page: repeated events and rerenders change nothing
    endStarted.current = true;
    armed.current = false;
    markFullscreenEnded();
    setEstablished(false);
    setPhase("working");
    void signOut();
  }, [signOut]);

  const check = useCallback(() => {
    if (driver.active() || !armed.current) return;
    if (enforcedNow()) {
      beginEnd();
      return;
    }
    // left fullscreen while nothing is enforced: not a violation, but no longer established
    armed.current = false;
    forgetFullscreen();
    setEstablished(false);
  }, [driver, enforcedNow, beginEnd]);

  // one listener per provider; React re-runs this only if the driver or the handler identity changes
  useEffect(() => driver.subscribe(check), [driver, check]);

  // enforcement can begin while already established (a teammate started the team, or the start call just returned):
  // a participant who is no longer in fullscreen at that moment is handled the same way
  useEffect(() => {
    if (!established || !required) return;
    const t = setTimeout(check, 0);
    return () => clearTimeout(t);
  }, [established, required, check]);

  // The page is going away (reload, typed address, closing the tab) while fullscreen is enforced: that leaves
  // fullscreen too, and no `fullscreenchange` will reach this page. Ask the server to end the session, best effort.
  const onPageHide = useCallback(() => {
    if (!armed.current || endStarted.current || !enforcedNow()) return;
    markFullscreenEnded();
    const send = fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
    try {
      void Promise.resolve(
        send("/api/auth/logout", { method: "POST", credentials: "same-origin", keepalive: true }),
      ).catch(() => undefined);
    } catch {
      // nothing more can be done from a dying page; the hint ends the session on the next load
    }
  }, [enforcedNow, fetchImpl]);

  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) check(); // restored from the back/forward cache: it may no longer be in fullscreen
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onShow);
    };
  }, [onPageHide, check]);

  // A new page load: if the hint says this member had fullscreen on this tab and the team is still enforced, the page
  // was left (a reload or a typed address) and the unload-time request may not have arrived. End the session now.
  // Not enforced any more (finished, or never started): the hint is stale and is dropped.
  useEffect(() => {
    if (state === null || bootChecked.current) return;
    const t = setTimeout(() => {
      if (bootChecked.current) return;
      bootChecked.current = true;
      if (!fullscreenWasEstablishedFor(state.me.member_id)) return;
      if (driver.active()) return; // still in fullscreen (a restored page): the normal rules apply
      if (enforcedNow()) beginEnd();
      else forgetFullscreen();
    }, 0);
    return () => clearTimeout(t);
  }, [state, driver, enforcedNow, beginEnd]);

  // the team finished while established (final submission, time up): the hint no longer means anything. (Not merely
  // "not required": before the team has started the hint must survive, because the start is about to make it count.)
  useEffect(() => {
    if (established && frozen) forgetFullscreen();
  }, [established, frozen]);

  const enter = useCallback((): Promise<FullscreenRequest> => {
    if (endStarted.current) return Promise.resolve({ ok: false, reason: "DENIED" });
    if (entering.current) return entering.current;
    const run = driver
      .request()
      .then((r) => {
        if (r.ok && !endStarted.current) {
          armed.current = true;
          const member = stateRef.current?.me.member_id;
          if (member) rememberFullscreen(member);
          setEstablished(true);
        }
        return r;
      })
      .finally(() => {
        entering.current = null;
      });
    entering.current = run;
    return run;
  }, [driver]);

  const retry = useCallback(() => {
    setPhase("working");
    void signOut();
  }, [signOut]);

  const value = useMemo<FullscreenValue>(
    () => ({
      required,
      established,
      ready: phase === null && (established || frozen),
      ending: phase !== null,
      enter,
    }),
    [required, established, frozen, phase, enter],
  );

  return (
    <FullscreenContext.Provider value={value}>
      {children}
      <ExitNotice phase={phase} onRetry={retry} />
    </FullscreenContext.Provider>
  );
}

export function useFullscreen(): FullscreenValue {
  const v = useContext(FullscreenContext);
  if (!v) throw new Error("useFullscreen must be used inside <FullscreenProvider>");
  return v;
}

/** Blocks the whole page (a modal dialog makes everything behind it inert) from the moment fullscreen is left. */
function ExitNotice({ phase, onRetry }: { phase: EndPhase; onRetry: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = dialog.current;
    if (el && phase && !el.open) el.showModal();
  }, [phase]);

  if (!phase) return null;
  return (
    <dialog
      ref={dialog}
      className="modal-dialog entry-gate fullscreen-exit"
      aria-labelledby={titleId}
      onCancel={(e) => e.preventDefault()}
    >
      <div className="dialog-body">
        <h2 id={titleId} className="dialog-title" tabIndex={-1}>
          You left fullscreen
        </h2>
        {phase === "working" ? (
          <p className="dialog-text" role="status">
            Your session is ending because fullscreen was exited. You will be taken to the sign-in
            page.
          </p>
        ) : (
          <p className="dialog-text entry-error" role="alert">
            Fullscreen was exited, but we couldn&apos;t confirm that your session ended. Check your
            connection and try again.
          </p>
        )}
      </div>
      {phase === "failed" ? (
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}
    </dialog>
  );
}

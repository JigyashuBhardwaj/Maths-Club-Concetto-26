"use client";

import { useEffect, useId, useRef, useState } from "react";

import { fullscreenErrorText } from "@/lib/fullscreen/driver";
import { enterCompetition } from "@/lib/gameplay/client";
import { gameErrorText, isRetryable } from "@/lib/gameplay/messages";
import { describeDuration } from "@/lib/home/format";
import { newIdempotencyKey } from "@/lib/provisioning/client";

import { useFullscreen } from "./fullscreen-provider";
import { useGame } from "./game-provider";

/**
 * "Enter competition". Signing in does NOT start the team timer: the first valid member of the team to press this
 * button does, once, on the server (`POST /api/p/start`, idempotent). Until then the participant pages stay behind
 * this gate, so no theme or question can be reached with a stopped clock. It cannot be dismissed: Escape is ignored.
 *
 * B19: the same click first puts the browser in fullscreen, and the team is started only if that really worked. The
 * gate also stands in front of a team that is ALREADY running (a teammate who signs in later, a reload, a new tab):
 * there the button only enters fullscreen and starts nothing, because the clock is the team's and already running.
 * Fullscreen is requested only from this click, never on load.
 */
export function EntryGate() {
  const { state, apply, refresh } = useGame();
  const fullscreen = useFullscreen();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsStart = state !== null && state.team.status === "NOT_STARTED";
  const needsFullscreen = fullscreen.required && !fullscreen.established;
  // once the page is blocked for leaving fullscreen, the exit notice takes over
  const needed = (needsStart || needsFullscreen) && !fullscreen.ending;
  const competition = state?.competition.status;
  // starting the team needs an open competition; entering fullscreen for a running team is only a display mode
  const canEnter = needsStart ? competition === "RUNNING" : true;

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (needed && !el.open) el.showModal();
    if (!needed && el.open) el.close();
  }, [needed]);

  if (!needed) return null;

  const enter = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // Fullscreen first, from this click. If it did not really happen nothing is started and the button can be pressed again.
    const shown = await fullscreen.enter();
    if (!shown.ok) {
      setBusy(false);
      setError(fullscreenErrorText(shown.reason));
      return;
    }
    if (!needsStart) {
      setBusy(false); // a running team: fullscreen was all this gate needed, and it closes now
      return;
    }
    key.current ??= newIdempotencyKey();
    const r = await enterCompetition(key.current);
    setBusy(false);
    if (r.ok) {
      key.current = null;
      apply(r.data);
      return;
    }
    // A definitive answer ends this intent; a lost connection keeps the key so the retry cannot start twice.
    if (!isRetryable(r.code)) key.current = null;
    setError(gameErrorText(r.code));
    void refresh();
  };

  return (
    <dialog
      ref={dialog}
      className="modal-dialog entry-gate"
      aria-labelledby={titleId}
      onCancel={(e) => e.preventDefault()}
    >
      <div className="dialog-body">
        <h2 id={titleId} className="dialog-title" tabIndex={-1}>
          {needsStart ? "Enter the competition" : "Enter fullscreen to continue"}
        </h2>
        <p className="dialog-text">
          {!needsStart
            ? "Your team's competition is running. Return to fullscreen to continue."
            : canEnter
              ? `Your team has ${describeDuration(state.team.duration_seconds)} in total. The team timer starts for everyone the moment the first member enters, and it keeps running until the time is up.`
              : competition === "PAUSED"
                ? "The competition is paused. You can enter once the organisers resume it."
                : "The competition is not open yet. This page will update when it opens."}
        </p>
        <p className="dialog-text">
          The competition runs in fullscreen. You must enter fullscreen before you start
          {needsStart ? ": the timer starts only after fullscreen succeeds" : ""}. If you exit
          fullscreen while the competition is running, your session ends and you are signed out.
        </p>
        {error ? (
          <p className="dialog-text entry-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canEnter || busy}
          onClick={() => void enter()}
        >
          {busy ? "Entering…" : needsStart ? "Enter competition" : "Enter fullscreen"}
        </button>
      </div>
    </dialog>
  );
}

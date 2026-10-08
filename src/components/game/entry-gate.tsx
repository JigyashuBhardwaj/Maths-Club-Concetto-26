"use client";

import { useEffect, useId, useRef, useState } from "react";

import { enterCompetition } from "@/lib/gameplay/client";
import { gameErrorText, isRetryable } from "@/lib/gameplay/messages";
import { newIdempotencyKey } from "@/lib/provisioning/client";

import { useGame } from "./game-provider";

/**
 * "Enter competition". Signing in does NOT start the team timer: the first valid member of the team to press this
 * button does, once, on the server (`POST /api/p/start`, idempotent). Until then the participant pages stay behind
 * this gate, so no theme or question can be reached with a stopped clock. It cannot be dismissed: Escape is ignored.
 */
export function EntryGate() {
  const { state, apply, refresh } = useGame();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needed = state !== null && state.team.status === "NOT_STARTED";
  const competition = state?.competition.status;
  const canEnter = competition === "RUNNING";

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
          Enter the competition
        </h2>
        <p className="dialog-text">
          {canEnter
            ? "Your team has 2 hours in total. The team timer starts for everyone the moment the first member enters, and it keeps running until the time is up."
            : competition === "PAUSED"
              ? "The competition is paused. You can enter once the organisers resume it."
              : "The competition is not open yet. This page will update when it opens."}
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
          {busy ? "Entering…" : "Enter competition"}
        </button>
      </div>
    </dialog>
  );
}

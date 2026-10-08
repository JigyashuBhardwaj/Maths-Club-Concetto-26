"use client";

import { useId, useRef, useState } from "react";

import { useGame } from "@/components/game/game-provider";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { finalSubmitCall } from "@/lib/economy/client";
import { canPlay } from "@/lib/gameplay/derive";
import { gameErrorText, isRetryable } from "@/lib/gameplay/messages";
import { newIdempotencyKey } from "@/lib/provisioning/client";

interface FinalSubmitDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * "Final Submit": the team's irreversible end. Confirming freezes the whole team for everybody, exactly like the timer
 * reaching zero: no more answers, hints, purchases or unlocks, and the remaining time is kept as it is. Answers that
 * are already waiting for review are still reviewed. One click is one request with one idempotency key, reused if the
 * connection fails so a retry cannot submit twice. The result is the server's frozen snapshot.
 */
export function FinalSubmitDialog({ open, onClose }: FinalSubmitDialogProps) {
  const titleId = useId();
  const { state, apply, refresh, serverNow } = useGame();
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = (state?.themes ?? []).reduce(
    (n, t) => n + t.questions.filter((q) => q.state === "PENDING_APPROVAL").length,
    0,
  );
  const submitted = state?.team.status === "FINAL_SUBMITTED";
  const playable = state ? canPlay(state, serverNow()) : false;

  const close = () => {
    if (busy) return;
    setError(null);
    onClose();
  };

  const confirm = async () => {
    if (busy || !playable) return;
    setBusy(true);
    setError(null);
    key.current ??= newIdempotencyKey();
    const r = await finalSubmitCall(key.current);
    setBusy(false);
    if (r.ok) {
      key.current = null;
      apply(r.data);
      onClose();
      return;
    }
    // A definitive answer ends this intent; a lost connection keeps the key so the retry cannot submit twice.
    if (!isRetryable(r.code)) key.current = null;
    setError(gameErrorText(r.code));
    void refresh();
  };

  return (
    <ModalDialog open={open} onClose={close} labelledBy={titleId}>
      {open ? (
        <>
          <div className="dialog-body">
            <h2 id={titleId} className="dialog-title" tabIndex={-1} data-autofocus>
              Final Submit
            </h2>
            {submitted ? (
              <p className="dialog-text" role="status">
                Your team has already made its final submission. Nothing more can be changed.
              </p>
            ) : !playable ? (
              <p className="dialog-text" role="status">
                Your team can&apos;t make a final submission right now.
              </p>
            ) : (
              <>
                <p className="dialog-text">
                  This ends the competition for your whole team and cannot be undone. Your
                  team&apos;s timer stops and nobody on your team can answer, buy hints or time, or
                  unlock themes any more.
                </p>
                {pending > 0 ? (
                  <p className="dialog-text">
                    {pending === 1
                      ? "1 answer is still waiting for review and will be reviewed as usual."
                      : `${pending} answers are still waiting for review and will be reviewed as usual.`}
                  </p>
                ) : null}
                <p className="dialog-text">Are you sure you want to submit?</p>
              </>
            )}
            {error ? (
              <p className="dialog-text" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <div className="dialog-actions">
            {submitted || !playable ? (
              <button type="button" className="btn btn-primary" onClick={close}>
                Close
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void confirm()}
                >
                  {busy ? "Submitting…" : "Yes, submit"}
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={close}>
                  Go back
                </button>
              </>
            )}
          </div>
        </>
      ) : null}
    </ModalDialog>
  );
}

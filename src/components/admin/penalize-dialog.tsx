"use client";

import { useId, useRef, useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import { isRetryable } from "@/lib/gameplay/messages";
import { newIdempotencyKey } from "@/lib/provisioning/client";
import { penalizeTeamCall } from "@/lib/scoring/client";

interface PenalizeDialogProps {
  team: { id: string; team_code: string; status: string; ufm_penalized: boolean };
  /** Called after the penalty was applied (or found to be applied already), so the board can re-read at once. */
  onChanged: () => void;
  onClose: () => void;
  /** Replaced in tests. */
  fetchImpl?: typeof fetch;
}

/** What the Admin reads when the penalty fails. Fixed wording chosen by the error code only. */
const TEXT: Record<string, string> = {
  NETWORK_ERROR: "Can't reach the server. Check your connection and try again.",
  BAD_RESPONSE: "Something went wrong on our side. Please try again.",
  SERVICE_UNAVAILABLE: "Something went wrong on our side. Please try again.",
  TEAM_NOT_STARTED: "This team has not started yet, so there is nothing to penalise.",
  FORBIDDEN: "Only the Admin who manages this team can penalise it.",
  NOT_FOUND: "This team is not one of yours.",
  UNAUTHENTICATED: "Your session has ended. Please sign in again.",
};
const errorText = (code: string) => TEXT[code] ?? TEXT.BAD_RESPONSE!;

/**
 * "Penalise this team" (UFM): opened from a Team ID in My Teams. "Yes" sets the team's official score to 0 and freezes it
 * for good - it can't play any more - while everything it did (answers, submissions, coins) is kept. "No" simply closes the
 * dialog; nothing is sent. One "Yes" is one request with one idempotency key, reused if the connection fails, so a retry
 * or a double click can never penalise twice. Who may do this is decided by the server (the owner Admin only).
 */
export function PenalizeDialog({ team, onChanged, onClose, fetchImpl }: PenalizeDialogProps) {
  const titleId = useId();
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (busy) return;
    onClose();
  };

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    key.current ??= newIdempotencyKey();
    const r = await penalizeTeamCall(team.id, { key: key.current, fetchImpl });
    setBusy(false);
    if (r.ok) {
      key.current = null;
      onChanged();
      onClose();
      return;
    }
    // A definitive answer ends this intent; a lost connection keeps the key so the retry cannot penalise twice.
    if (!isRetryable(r.code)) key.current = null;
    setError(errorText(r.code));
  };

  const already = team.ufm_penalized;

  return (
    <ModalDialog open onClose={close} labelledBy={titleId}>
      <div className="dialog-body">
        <h2 id={titleId} className="dialog-title" tabIndex={-1} data-autofocus>
          Penalise this team
        </h2>
        {already ? (
          <p className="dialog-text" role="status">
            {team.team_code} has already been penalised. Its official score is 0 and it can&apos;t
            play any more.
          </p>
        ) : (
          <>
            <p className="dialog-text">
              Penalise <strong>{team.team_code}</strong> for using unfair means?
            </p>
            <p className="dialog-text">
              Its official score becomes 0 and the team is frozen: it can&apos;t answer, buy or
              unlock anything any more. Everything it has done so far is kept. This can&apos;t be
              undone.
            </p>
          </>
        )}
        {error ? (
          <p className="dialog-text" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="dialog-actions">
        {already ? (
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
              {busy ? "Penalising…" : "Yes"}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={close}>
              No
            </button>
          </>
        )}
      </div>
    </ModalDialog>
  );
}

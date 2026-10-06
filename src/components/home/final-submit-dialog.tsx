"use client";

import { useId } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import { LOREM_IPSUM, type FinalTicket } from "@/lib/home/themes";

interface FinalSubmitDialogProps {
  ticket: FinalTicket;
  open: boolean;
  onClose: () => void;
}

/**
 * "Final Submit" confirmation. Visual demo: "Yes, submit" only closes the dialog; the real
 * final submission (freeze, scoring, idempotency) is server-side work for a later milestone.
 */
export function FinalSubmitDialog({ open, onClose }: FinalSubmitDialogProps) {
  const titleId = useId();

  return (
    <ModalDialog open={open} onClose={onClose} labelledBy={titleId}>
      <div className="dialog-body">
        <h2 id={titleId} className="dialog-title" tabIndex={-1} data-autofocus>
          Final Submit
        </h2>
        <p className="dialog-text">{LOREM_IPSUM}</p>
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Yes, submit
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Go back
        </button>
      </div>
    </ModalDialog>
  );
}

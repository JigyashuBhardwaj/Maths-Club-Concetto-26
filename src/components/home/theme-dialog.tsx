"use client";

import { useId } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import { UNLOCK_COST_PLACEHOLDER, type ThemeTicket } from "@/lib/home/themes";

interface ThemeDialogProps {
  /** The theme to show; kept after closing so the dialog does not go blank while it closes. */
  ticket: ThemeTicket | null;
  open: boolean;
  unlocked: boolean;
  onUnlock: () => void;
  onClose: () => void;
}

/**
 * "THEME X" dialog. Visual demo: unlocking only flips the button label locally; it does not deduct
 * coins, start a question timer or save anything (those arrive with the server-side engine).
 */
export function ThemeDialog({ ticket, open, unlocked, onUnlock, onClose }: ThemeDialogProps) {
  const titleId = useId();
  if (!ticket) return null;

  return (
    <ModalDialog open={open} onClose={onClose} labelledBy={titleId}>
      <div className="dialog-body">
        <h2 id={titleId} className="dialog-title" tabIndex={-1} data-autofocus>
          {ticket.label}
        </h2>
        <p className="dialog-text">{ticket.description}</p>
      </div>
      <div className="dialog-actions">
        {unlocked ? (
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Let&apos;s solve
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onUnlock}>
            Unlock with {UNLOCK_COST_PLACEHOLDER} coins
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Explore other themes
        </button>
      </div>
    </ModalDialog>
  );
}

"use client";

import Link from "next/link";
import { useId } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import { UNLOCK_COST_PLACEHOLDER, type ThemeTicket } from "@/lib/home/themes";

interface ThemeDialogProps {
  /** The theme to show; kept after closing so the dialog does not go blank while it closes. */
  ticket: ThemeTicket | null;
  open: boolean;
  unlocked: boolean;
  /** Where "Let's solve" goes: the member's current question in this theme. */
  solveHref: string;
  onUnlock: () => void;
  onClose: () => void;
}

/**
 * "THEME X" dialog. Demo: unlocking only flips the button to "Let's solve" (a link to the question
 * page); it does not deduct coins or save anything server-side (that arrives with the engine).
 */
export function ThemeDialog({
  ticket,
  open,
  unlocked,
  solveHref,
  onUnlock,
  onClose,
}: ThemeDialogProps) {
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
          <Link href={solveHref} className="btn btn-primary btn-link">
            Let&apos;s solve
          </Link>
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

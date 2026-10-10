"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";

import { useGame } from "@/components/game/game-provider";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { currentOrdinal, isUnlocked } from "@/lib/gameplay/derive";
import { unlockThemeCall } from "@/lib/gameplay/client";
import { gameErrorText, isRetryable } from "@/lib/gameplay/messages";
import type { ThemeTicket } from "@/lib/home/themes";
import { newIdempotencyKey } from "@/lib/provisioning/client";

interface ThemeDialogProps {
  /** The theme to show; kept after closing so the dialog does not go blank while it closes. */
  ticket: ThemeTicket | null;
  open: boolean;
  onClose: () => void;
}

const STATUS_NOTE: Record<string, string> = {
  COMPLETED: "All five questions are approved.",
  FAILED: "Time ran out on a question in this theme.",
};

/**
 * Theme dialog: the heading is the theme's official name; the description, price and unlocked state all come from the team snapshot. Unlocking
 * is TEAM-WIDE and charged once, on the server: this dialog only asks (`POST /api/p/themes/:id/unlock`) and then shows
 * whatever the server answers. If a teammate unlocked it first, the snapshot flips this dialog to "Let's solve" with
 * no charge. The Idempotency-Key of one click is kept until the server answers, so a lost response can be retried
 * without paying twice.
 */
export function ThemeDialog({ ticket, open, onClose }: ThemeDialogProps) {
  const titleId = useId();
  const { state, apply, refresh } = useGame();
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!ticket) return null;

  const theme = state?.themes.find((t) => t.code === ticket.id);
  const unlocked = theme ? isUnlocked(theme) : false;
  const coins = state?.team.coins ?? 0;
  const cost = theme?.unlock_cost ?? null;
  const live =
    state?.competition.status === "RUNNING" &&
    state.team.status === "RUNNING" &&
    !state.team.frozen;
  const affordable = cost !== null && coins >= cost;
  const solveHref = `/participant/theme/${ticket.id}/${theme ? currentOrdinal(theme) : 1}`;

  const unlock = async () => {
    if (!theme || busy) return;
    setBusy(true);
    setError(null);
    key.current ??= newIdempotencyKey();
    const r = await unlockThemeCall(theme.id, key.current);
    setBusy(false);
    if (r.ok) {
      key.current = null;
      apply(r.data);
      return;
    }
    if (!isRetryable(r.code)) key.current = null;
    setError(gameErrorText(r.code));
    // a teammate may have unlocked it, or the balance changed: show the server's current picture
    void refresh();
  };

  return (
    <ModalDialog open={open} onClose={onClose} labelledBy={titleId}>
      <div className="dialog-body">
        <h2 id={titleId} className="dialog-title" tabIndex={-1} data-autofocus>
          {ticket.label}
        </h2>
        {theme ? (
          <>
            <p className="dialog-text">{theme.description}</p>
            {unlocked && STATUS_NOTE[theme.status] ? (
              <p className="ticket-note">{STATUS_NOTE[theme.status]}</p>
            ) : null}
            {!unlocked && !affordable && cost !== null ? (
              <p className="ticket-note">
                This theme costs {cost} coins and your team has {coins}.
              </p>
            ) : null}
          </>
        ) : (
          <p className="dialog-text">Loading…</p>
        )}
        {error ? (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="dialog-actions">
        {unlocked ? (
          <Link href={solveHref} className="btn btn-primary btn-link">
            Let&apos;s solve
          </Link>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!theme || busy || !live || !affordable}
            onClick={() => void unlock()}
          >
            {busy ? "Unlocking…" : cost === null ? "Unlock" : `Unlock with ${cost} coins`}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Explore other themes
        </button>
      </div>
    </ModalDialog>
  );
}

"use client";

import { useId, useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import type { BuyTimeOption } from "@/lib/contracts/gameplay";
import { formatMinSec, packLabel } from "@/lib/home/format";

interface BuyTimeDialogProps {
  open: boolean;
  /** The packs, exactly as the server sent them (seconds, price, caps): nothing is hard-coded here. */
  options: readonly BuyTimeOption[];
  coins: number;
  /** False when the question or the team can't be extended right now (frozen, paused, not ACTIVE). */
  canBuy: boolean;
  /** Seconds left on the team timer and on this question, to warn when bought time could not be used in full. */
  teamRemainingSeconds: number;
  questionRemainingSeconds: number;
  busy: boolean;
  /** A fixed-wording failure message from the last attempt. */
  error: string | null;
  onClose: () => void;
  /** Called only after the member confirms with "Yes". */
  onConfirm: (option: BuyTimeOption) => void;
}

const unavailable = (o: BuyTimeOption) =>
  o.remaining_purchases !== null && o.remaining_purchases <= 0;

/** Menu of time packs; picking one asks "Are you sure?" (Yes buys, No goes back). Packs and prices come from props. */
export function BuyTimeDialog({
  open,
  options,
  coins,
  canBuy,
  teamRemainingSeconds,
  questionRemainingSeconds,
  busy,
  error,
  onClose,
  onConfirm,
}: BuyTimeDialogProps) {
  const titleId = useId();
  const [pickedId, setPickedId] = useState<number | null>(null);
  const picked = options.find((o) => o.id === pickedId) ?? null;

  // After a refusal (a teammate bought first, not enough coins, ...) the member picks again from the fresh packs.
  // Adjusted during render (not in an effect) so the list is back in the same paint as the message.
  const [seenError, setSeenError] = useState<string | null>(null);
  if (error !== seenError) {
    setSeenError(error);
    if (error) setPickedId(null);
  }

  const close = () => {
    setPickedId(null);
    onClose();
  };

  const buyable = options.filter((o) => !unavailable(o));
  const cheapest = buyable.length ? Math.min(...buyable.map((o) => o.cost)) : 0;
  // Bought time moves THIS question's deadline only; the team's own end is not moved, so part of a pack can be wasted.
  const usable = picked
    ? Math.max(0, Math.min(picked.seconds, teamRemainingSeconds - questionRemainingSeconds))
    : 0;

  return (
    <ModalDialog open={open} onClose={close} labelledBy={titleId}>
      {open ? (
        <>
          <div className="dialog-body">
            <h2 id={titleId} className="dialog-title" tabIndex={-1} data-autofocus>
              Buy time
            </h2>
            {picked ? (
              <>
                <p className="dialog-text" role="status">
                  Add {packLabel(picked.seconds)} to this question for {picked.cost} coins? Are you
                  sure?
                </p>
                {usable < picked.seconds ? (
                  <p className="dialog-text">
                    Your team&apos;s total time does not change, so only {formatMinSec(usable)} of
                    this pack can be used before your team&apos;s time runs out.
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <ul className="q-options" aria-label="Time packs">
                  {options.map((opt) => (
                    <li key={opt.id}>
                      <button
                        type="button"
                        className="btn q-option"
                        disabled={!canBuy || busy || coins < opt.cost || unavailable(opt)}
                        onClick={() => setPickedId(opt.id)}
                      >
                        <span>{packLabel(opt.seconds)}</span>
                        <span className="q-option-cost">{opt.cost} coins</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="dialog-text">
                  Extra time applies to this question only and is added for your whole team.
                </p>
              </>
            )}
            {!picked && canBuy && buyable.length > 0 && coins < cheapest ? (
              <p className="dialog-text">Not enough coins.</p>
            ) : null}
            {!canBuy ? <p className="dialog-text">Time can&apos;t be bought right now.</p> : null}
            {error ? (
              <p className="dialog-text" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <div className="dialog-actions">
            {picked ? (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || !canBuy}
                  onClick={() => onConfirm(picked)}
                >
                  {busy ? "Buying…" : "Yes"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => setPickedId(null)}
                >
                  No
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-ghost" onClick={close}>
                Cancel
              </button>
            )}
          </div>
        </>
      ) : null}
    </ModalDialog>
  );
}

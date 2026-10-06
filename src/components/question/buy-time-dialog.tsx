"use client";

import { useId, useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import { BUY_TIME_OPTIONS, type BuyTimeOption } from "@/lib/question/constants";

interface BuyTimeDialogProps {
  open: boolean;
  coins: number;
  onClose: () => void;
  /** Called only after the member confirms with "Yes". */
  onConfirm: (minutes: number) => void;
}

/** Menu of time packs; picking one asks "Are you sure?" (Yes buys, No just closes). */
export function BuyTimeDialog({ open, coins, onClose, onConfirm }: BuyTimeDialogProps) {
  const titleId = useId();
  const [picked, setPicked] = useState<BuyTimeOption | null>(null);

  const close = () => {
    setPicked(null);
    onClose();
  };

  return (
    <ModalDialog open={open} onClose={close} labelledBy={titleId}>
      <div className="dialog-body">
        <h2 id={titleId} className="dialog-title" tabIndex={-1} data-autofocus>
          Buy time
        </h2>
        {picked ? (
          <p className="dialog-text" role="status">
            Add {picked.minutes} minutes for {picked.cost} coins? Are you sure?
          </p>
        ) : (
          <ul className="q-options" aria-label="Time packs">
            {BUY_TIME_OPTIONS.map((opt) => (
              <li key={opt.minutes}>
                <button
                  type="button"
                  className="btn q-option"
                  disabled={coins < opt.cost}
                  onClick={() => setPicked(opt)}
                >
                  <span>{opt.minutes} mins</span>
                  <span className="q-option-cost">{opt.cost} coins</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {!picked && coins < BUY_TIME_OPTIONS[0].cost ? (
          <p className="dialog-text">Not enough coins.</p>
        ) : null}
      </div>
      <div className="dialog-actions">
        {picked ? (
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                onConfirm(picked.minutes);
                close();
              }}
            >
              Yes
            </button>
            <button type="button" className="btn btn-ghost" onClick={close}>
              No
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={close}>
            Cancel
          </button>
        )}
      </div>
    </ModalDialog>
  );
}

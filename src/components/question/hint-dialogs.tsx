"use client";

import { useId } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import { HINT_COSTS, PLACEHOLDER_HINT } from "@/lib/question/constants";

interface HintDialogsProps {
  /** Which hint is open and in which mode; null = none. */
  active: { tier: 1 | 2; mode: "buy" | "view" } | null;
  coins: number;
  /** `mode` says which of the two dialogs closed, so a late close of one cannot close the other. */
  onClose: (mode: "buy" | "view") => void;
  onBuy: (tier: 1 | 2) => void;
}

/** "Do you want to purchase this hint for N coins?" (Yes/No) and the unlocked-hint viewer (Close). */
export function HintDialogs({ active, coins, onClose, onBuy }: HintDialogsProps) {
  const buyId = useId();
  const viewId = useId();
  const tier = active?.tier ?? 1;
  const cost = HINT_COSTS[tier - 1]!;

  return (
    <>
      <ModalDialog open={active?.mode === "buy"} onClose={() => onClose("buy")} labelledBy={buyId}>
        <div className="dialog-body">
          <h2 id={buyId} className="dialog-title" tabIndex={-1} data-autofocus>
            Hint {tier}
          </h2>
          <p className="dialog-text">Do you want to purchase this hint for {cost} coins?</p>
          {coins < cost ? <p className="dialog-text">Not enough coins.</p> : null}
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={coins < cost}
            onClick={() => onBuy(tier)}
          >
            Yes
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => onClose("buy")}>
            No
          </button>
        </div>
      </ModalDialog>

      <ModalDialog
        open={active?.mode === "view"}
        onClose={() => onClose("view")}
        labelledBy={viewId}
      >
        <div className="dialog-body">
          <h2 id={viewId} className="dialog-title" tabIndex={-1} data-autofocus>
            Hint {tier}
          </h2>
          <p className="dialog-text">{PLACEHOLDER_HINT}</p>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={() => onClose("view")}>
            Close
          </button>
        </div>
      </ModalDialog>
    </>
  );
}

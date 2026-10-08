"use client";

import { useId } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import type { Hint } from "@/lib/contracts/gameplay";

interface HintDialogsProps {
  /** Which hint is open and in which mode; null = none. */
  active: { tier: 1 | 2; mode: "buy" | "view" } | null;
  /** The question's hints exactly as the server sent them: price, ownership and (only if owned) the text. */
  hints: readonly Hint[];
  coins: number;
  busy: boolean;
  /** A fixed-wording failure message from the last attempt. */
  error: string | null;
  /** `mode` says which of the two dialogs closed, so a late close of one cannot close the other. */
  onClose: (mode: "buy" | "view") => void;
  onBuy: (tier: 1 | 2) => void;
}

/** "Do you want to purchase this hint for N coins?" (Yes/No) and the unlocked-hint viewer (Close). */
export function HintDialogs({
  active,
  hints,
  coins,
  busy,
  error,
  onClose,
  onBuy,
}: HintDialogsProps) {
  const buyId = useId();
  const viewId = useId();
  const tier = active?.tier ?? 1;
  const hint = hints.find((h) => h.tier === tier);
  const cost = hint?.cost ?? 0;

  return (
    <>
      <ModalDialog open={active?.mode === "buy"} onClose={() => onClose("buy")} labelledBy={buyId}>
        {active?.mode === "buy" ? (
          <>
            <div className="dialog-body">
              <h2 id={buyId} className="dialog-title" tabIndex={-1} data-autofocus>
                Hint {tier}
              </h2>
              <p className="dialog-text">
                Do you want to purchase this hint for {cost} coins? Your whole team will be able to
                read it.
              </p>
              {coins < cost ? <p className="dialog-text">Not enough coins.</p> : null}
              {error ? (
                <p className="dialog-text" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || coins < cost || !hint?.purchasable}
                onClick={() => onBuy(tier)}
              >
                {busy ? "Buying…" : "Yes"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => onClose("buy")}
              >
                No
              </button>
            </div>
          </>
        ) : null}
      </ModalDialog>

      <ModalDialog
        open={active?.mode === "view"}
        onClose={() => onClose("view")}
        labelledBy={viewId}
      >
        {active?.mode === "view" ? (
          <>
            <div className="dialog-body">
              <h2 id={viewId} className="dialog-title" tabIndex={-1} data-autofocus>
                Hint {tier}
              </h2>
              <p className="dialog-text q-hint-body">{hint?.body_md ?? ""}</p>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-primary" onClick={() => onClose("view")}>
                Close
              </button>
            </div>
          </>
        ) : null}
      </ModalDialog>
    </>
  );
}

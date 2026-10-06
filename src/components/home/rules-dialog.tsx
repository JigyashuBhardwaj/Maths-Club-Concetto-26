"use client";

import { useId, useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import { LOREM_IPSUM } from "@/lib/home/themes";

import { InfoIcon } from "./icons";

/** "Rules and regulations" stat + its dialog. The rules text is placeholder lorem ipsum for now. */
export function RulesButton() {
  const [open, setOpen] = useState(false);
  const titleId = useId();

  return (
    <>
      <button
        type="button"
        className="stat stat-button"
        aria-label="Rules and regulations"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <InfoIcon className="stat-icon stat-icon-info" />
        <span className="stat-text">
          <span className="stat-label">rules and</span>
          <span className="stat-label">regulations</span>
        </span>
      </button>

      <ModalDialog
        open={open}
        onClose={() => setOpen(false)}
        labelledBy={titleId}
        className="dialog-wide"
      >
        <div className="dialog-body">
          <h2 id={titleId} className="dialog-title" tabIndex={-1} data-autofocus>
            Rules and Regulations
          </h2>
          <div className="dialog-scroll">
            {[0, 1, 2, 3, 4].map((n) => (
              <p key={n} className="dialog-text">
                {LOREM_IPSUM}
              </p>
            ))}
          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </ModalDialog>
    </>
  );
}

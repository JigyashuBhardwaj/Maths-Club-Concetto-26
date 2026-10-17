"use client";

import { useId, useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import { OFFICIAL_RULES } from "@/lib/content/official-public";

import { InfoIcon } from "./icons";

interface RulesButtonProps {
  /**
   * The rules in force, in order (the Super Admin's renewed rules, else the official ones). Omitted: the built-in official rules.
   * `null`: they could not be read from the database, and the dialog says so instead of showing text that may be out of date.
   */
  rules?: readonly string[] | null;
}

/** "Rules and regulations" stat + its dialog: the rules in force, in order, word for word. */
export function RulesButton({ rules = OFFICIAL_RULES }: RulesButtonProps) {
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
            {rules === null ? (
              <p className="dialog-text" role="alert">
                The rules could not be loaded. Reload the page to try again.
              </p>
            ) : (
              <ol className="rules-list">
                {rules.map((rule, i) => (
                  <li key={`${i}-${rule}`} className="rules-item">
                    {rule}
                  </li>
                ))}
              </ol>
            )}
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

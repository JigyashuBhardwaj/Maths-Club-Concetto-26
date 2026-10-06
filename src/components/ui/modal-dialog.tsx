"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

interface ModalDialogProps {
  open: boolean;
  onClose: () => void;
  /** id of the element that names the dialog (its heading). */
  labelledBy: string;
  children: ReactNode;
  className?: string;
}

/**
 * Accessible modal built on the native <dialog>: focus is trapped, the page behind is inert,
 * Escape closes it and focus returns to the opener. Clicking the dimmed backdrop also closes it.
 * Put `data-autofocus` on the element that should receive focus when it opens (default: the dialog).
 */
export function ModalDialog({ open, onClose, labelledBy, children, className }: ModalDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      el.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onClose={(e) => {
        // `close` fires asynchronously; ignore a stale one that arrives after the dialog was re-opened.
        if (!e.currentTarget.open) onClose();
      }}
      onClick={(e) => {
        // A click on the <dialog> element itself (not its content) is a click on the backdrop.
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
      className={cn("modal-dialog", className)}
    >
      {children}
    </dialog>
  );
}

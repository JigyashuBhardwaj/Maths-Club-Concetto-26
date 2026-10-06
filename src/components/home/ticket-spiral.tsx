"use client";

import { useRef, useState, type CSSProperties } from "react";

import { currentQuestionNumber, isUnlocked, unlockTheme } from "@/lib/question/engine";
import { dispatch, useDemoState } from "@/lib/question/store";

import { cn } from "@/lib/utils";
import { STEP_DEG } from "@/lib/home/spiral";
import { FINAL_TICKET, TICKETS, type ThemeId, type Ticket } from "@/lib/home/themes";

import { FinalSubmitDialog } from "./final-submit-dialog";
import { ThemeDialog } from "./theme-dialog";
import { useSpiralMotion } from "./use-spiral-motion";

/**
 * The 10 theme tickets (A–J) + the Final Submit ticket (11 in total), on a slowly turning helix.
 * Demo: "unlocked" themes live in the browser tab's demo store only (no coins are deducted, nothing is saved server-side).
 */
export function TicketSpiral() {
  const ringRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Ticket>(TICKETS[0]!);
  const [open, setOpen] = useState(false);
  const demo = useDemoState();

  const { handlers, consumeDragClick } = useSpiralMotion(ringRef, open);

  const choose = (ticket: Ticket) => {
    if (consumeDragClick()) return;
    setSelected(ticket);
    setOpen(true);
  };
  const close = () => setOpen(false);

  return (
    <section className="spiral-area" aria-label="Themes">
      <div className="spiral" {...handlers}>
        <div
          ref={ringRef}
          className="spiral-ring"
          style={{ "--rot": 0, "--n": TICKETS.length } as CSSProperties}
        >
          {TICKETS.map((ticket, i) => (
            <button
              key={ticket.id}
              type="button"
              className={cn(
                "ticket",
                ticket.kind === "final" && "ticket-final",
                ticket.kind === "theme" && demo && isUnlocked(demo, ticket.id) && "is-unlocked",
              )}
              style={{ "--i": i, "--a": i * STEP_DEG } as CSSProperties}
              data-index={i}
              aria-haspopup="dialog"
              onClick={() => choose(ticket)}
            >
              <svg
                className="ticket-shape"
                viewBox="0 0 200 84"
                preserveAspectRatio="none"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  className="ticket-body"
                  d="M10 1h180a9 9 0 0 0 9 9v22a10 10 0 0 0 0 20v22a9 9 0 0 0-9 9H10a9 9 0 0 0-9-9V52a10 10 0 0 0 0-20V10a9 9 0 0 0 9-9z"
                  vectorEffect="non-scaling-stroke"
                />
                <line
                  className="ticket-perf"
                  x1="34"
                  y1="9"
                  x2="34"
                  y2="75"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <span className="ticket-stub" aria-hidden="true">
                {ticket.kind === "final" ? "★" : ticket.id}
              </span>
              <span className="ticket-label">{ticket.label}</span>
            </button>
          ))}
        </div>
      </div>

      <ThemeDialog
        ticket={selected.kind === "theme" ? selected : null}
        open={open && selected.kind === "theme"}
        unlocked={selected.kind === "theme" && !!demo && isUnlocked(demo, selected.id)}
        solveHref={
          selected.kind === "theme"
            ? `/participant/theme/${selected.id}/${demo ? currentQuestionNumber(demo, selected.id) : 1}`
            : "/participant"
        }
        onUnlock={() => {
          if (selected.kind === "theme") dispatch((s) => unlockTheme(s, selected.id as ThemeId));
        }}
        onClose={close}
      />
      <FinalSubmitDialog
        ticket={FINAL_TICKET}
        open={open && selected.kind === "final"}
        onClose={close}
      />
    </section>
  );
}

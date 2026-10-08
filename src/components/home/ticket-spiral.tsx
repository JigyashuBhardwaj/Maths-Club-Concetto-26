"use client";

import { useRef, useState, type CSSProperties } from "react";

import { useGame } from "@/components/game/game-provider";
import { cn } from "@/lib/utils";
import { STEP_DEG } from "@/lib/home/spiral";
import { FINAL_TICKET, TICKETS, type Ticket } from "@/lib/home/themes";

import { FinalSubmitDialog } from "./final-submit-dialog";
import { ThemeDialog } from "./theme-dialog";
import { useSpiralMotion } from "./use-spiral-motion";

/**
 * The 10 theme tickets (A–J) + the Final Submit ticket (11 in total), on a slowly turning helix.
 * A theme ticket glows when the team's snapshot says the theme is unlocked (for the whole team, not per browser).
 */
export function TicketSpiral() {
  const ringRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Ticket>(TICKETS[0]!);
  const [open, setOpen] = useState(false);
  const { state } = useGame();
  const unlockedCodes = new Set(
    (state?.themes ?? []).filter((t) => t.status !== "LOCKED").map((t) => t.code),
  );

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
                ticket.kind === "theme" && unlockedCodes.has(ticket.id) && "is-unlocked",
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

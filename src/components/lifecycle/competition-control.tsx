"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import type { CompetitionAction, CompetitionStatusValue } from "@/lib/contracts/runtime";
import { isRetryable } from "@/lib/gameplay/messages";
import { newIdempotencyKey } from "@/lib/provisioning/client";
import { setCompetitionStatusCall } from "@/lib/runtime/client";

interface CompetitionControlProps {
  /** The server-rendered first read; `null` when it could not be read (the control then offers a reload instead of guessing). */
  initial: { status: CompetitionStatusValue; teams: number } | null;
  /** Replaced in tests. */
  fetchImpl?: typeof fetch;
}

const STATUS_LABEL: Record<CompetitionStatusValue, string> = {
  SETUP: "Setup",
  RUNNING: "Running",
  PAUSED: "Paused",
  ENDED: "Ended",
};

const STATUS_HELP: Record<CompetitionStatusValue, string> = {
  SETUP: "Not open. Participants cannot sign in until you open the competition.",
  RUNNING: "Open. Participants can sign in and play.",
  PAUSED: "Paused. Gameplay is on hold; team timers are held until you resume.",
  ENDED: "Ended. This competition is over and cannot be reopened.",
};

const DONE_TEXT: Record<CompetitionAction, string> = {
  open: "The competition is open. Participants can now sign in.",
  pause: "The competition is paused.",
  resume: "The competition is running again.",
  end: "The competition has ended.",
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const isStatus = (v: unknown): v is CompetitionStatusValue =>
  v === "SETUP" || v === "RUNNING" || v === "PAUSED" || v === "ENDED";

/** Fixed wording chosen by the error CODE only: nothing the server sends is shown verbatim. */
function errorText(code: string, details?: Record<string, unknown>): string {
  switch (code) {
    case "COMPETITION_NOT_READY":
      return details?.teams === 0
        ? "Nothing was changed. The competition cannot open yet: no team exists. Have an Admin create at least one team first."
        : "Nothing was changed. The competition cannot open yet: it needs at least one team and all 10 themes with 5 questions each.";
    case "INVALID_COMPETITION_TRANSITION":
      return "Nothing was changed. That is not allowed in the competition's current state.";
    case "FORBIDDEN":
      return "Nothing was changed. Only the Superadmin can change the competition's status.";
    case "UNAUTHENTICATED":
      return "Nothing was changed. Your session has ended. Sign in again to continue.";
    case "NETWORK_ERROR":
      return "Couldn't reach the server, so we can't tell whether the change happened. Try again: the same request is never applied twice.";
    case "IDEMPOTENCY_KEY_REUSED":
      return "That request was already used for something else. Please try again.";
    default:
      return "Something went wrong on our side. Nothing was reported as changed. Please try again.";
  }
}

/**
 * The Super Admin's competition lifecycle control (Patch B10's `POST /api/super/competition/status`, which until now had no screen).
 * It shows the CURRENT status as read by the server and offers only the actions the database allows from it:
 *   SETUP → Open · RUNNING → Pause, End · PAUSED → Resume, End · ENDED → nothing (the backend has no way back).
 * The status shown is never an authority: the database re-checks the role and the transition on every call, and a refusal for a
 * state that changed in another tab corrects the display from the state the server reports. Ending is irreversible and asks first;
 * the other actions do not. One request at a time; one `Idempotency-Key` per intent, reused only when the outcome is unknown.
 */
export function CompetitionControl({ initial, fetchImpl }: CompetitionControlProps) {
  const headingId = useId();
  const dialogTitleId = useId();
  const [status, setStatus] = useState<CompetitionStatusValue | null>(initial?.status ?? null);
  const [teams] = useState<number | null>(initial?.teams ?? null);
  const [busy, setBusy] = useState<CompetitionAction | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inFlight = useRef(false);
  const attempt = useRef<{ action: CompetitionAction; key: string } | null>(null);

  const run = async (action: CompetitionAction) => {
    if (inFlight.current) return; // a double click / double Enter sends one request
    if (attempt.current?.action !== action) attempt.current = { action, key: newIdempotencyKey() };
    inFlight.current = true;
    setBusy(action);
    setNotice(null);
    setError(null);
    const result = await setCompetitionStatusCall(action, {
      key: attempt.current.key,
      fetchImpl,
    });
    inFlight.current = false;
    setBusy(null);
    setConfirmEnd(false);

    if (result.ok) {
      attempt.current = null;
      setStatus(result.data.competition.status);
      setNotice(
        result.data.changed
          ? DONE_TEXT[action]
          : `Nothing changed: the competition was already ${STATUS_LABEL[result.data.competition.status].toLowerCase()}.`,
      );
      return;
    }
    if (!isRetryable(result.code)) attempt.current = null;
    // The state changed behind this page (another tab): show the state the server says it is in, so the right actions appear.
    if (result.code === "INVALID_COMPETITION_TRANSITION" && isStatus(result.details?.from)) {
      setStatus(result.details.from);
    }
    setError(errorText(result.code, result.details));
  };

  const working = busy !== null;

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={working}
      data-testid="competition-control"
      className="mt-6 border-t border-line pt-6"
    >
      <h2
        id={headingId}
        className="text-[11px] font-semibold tracking-[0.18em] text-ink-dim uppercase"
      >
        Competition
      </h2>

      {status === null ? (
        <div className="mt-3" data-testid="competition-unavailable">
          <p className="text-sm leading-relaxed text-ink" role="alert">
            The competition&apos;s status could not be read, so no action is offered. Reload the
            page to try again.
          </p>
          <Button className="mt-3" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      ) : (
        <>
          <p className="mt-3 text-sm text-ink">
            Status:{" "}
            <strong data-testid="competition-status" data-status={status} className="font-semibold">
              {STATUS_LABEL[status]}
            </strong>
          </p>
          <p className="mt-1 text-sm leading-relaxed text-ink-dim" data-testid="competition-help">
            {STATUS_HELP[status]}
            {status === "SETUP" && teams !== null
              ? ` ${teams} ${plural(teams, "team is", "teams are")} registered.`
              : ""}
          </p>
          {status === "ENDED" ? (
            <p className="mt-2 text-sm leading-relaxed text-ink-dim">
              To prepare the next one, use{" "}
              <Link href="/superadmin/renew" className="text-ink underline underline-offset-2">
                Renew the competition
              </Link>
              .
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-3">
            {status === "SETUP" ? (
              <Button disabled={working} onClick={() => void run("open")}>
                {busy === "open" ? "Opening…" : "Open competition"}
              </Button>
            ) : null}
            {status === "RUNNING" ? (
              <Button disabled={working} onClick={() => void run("pause")}>
                {busy === "pause" ? "Pausing…" : "Pause"}
              </Button>
            ) : null}
            {status === "PAUSED" ? (
              <Button disabled={working} onClick={() => void run("resume")}>
                {busy === "resume" ? "Resuming…" : "Resume"}
              </Button>
            ) : null}
            {status === "RUNNING" || status === "PAUSED" ? (
              <Button variant="ghost" disabled={working} onClick={() => setConfirmEnd(true)}>
                End competition
              </Button>
            ) : null}
          </div>
        </>
      )}

      {notice ? (
        <p
          role="status"
          data-testid="competition-notice"
          className="mt-4 rounded-row border border-line bg-white/5 px-3 py-2 text-sm text-ink"
        >
          {notice}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          data-testid="competition-error"
          className="mt-4 rounded-row border border-orange/40 bg-orange/10 px-3 py-2 text-sm text-ink"
        >
          {error}
        </p>
      ) : null}

      <ModalDialog
        open={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        labelledBy={dialogTitleId}
      >
        <div className="dialog-body">
          <h2 id={dialogTitleId} className="dialog-title" tabIndex={-1} data-autofocus>
            End the competition?
          </h2>
          <p className="dialog-text">
            Ending closes the competition for every team that is still playing. This cannot be
            undone: an ended competition cannot be reopened.
          </p>
          {busy === "end" ? (
            <p className="dialog-text" role="status">
              Ending the competition… Please keep this page open.
            </p>
          ) : null}
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="btn btn-primary disabled:opacity-60"
            disabled={working}
            onClick={() => void run("end")}
          >
            {busy === "end" ? "Ending…" : "Yes, end competition"}
          </button>
          <button
            type="button"
            className="btn disabled:opacity-60"
            disabled={working}
            onClick={() => setConfirmEnd(false)}
          >
            Go back
          </button>
        </div>
      </ModalDialog>
    </section>
  );
}

"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import type { TeamThemeResult, ThemeQuestion } from "@/lib/contracts/matrix";
import { gameErrorText } from "@/lib/gameplay/messages";
import { fetchTeamTheme, reviewSubmission, type Verdict } from "@/lib/matrix/client";
import { newIdempotencyKey } from "@/lib/provisioning/client";

interface Props {
  team: { id: string; team_code: string };
  themeCode: string;
  onClose: () => void;
  /** Called after a decision so the board behind re-reads the database at once. */
  onChanged: () => void;
  /** Replaced in tests. */
  fetchImpl?: typeof fetch;
  intervalMs: number;
}

/** A full page load, so no stale page or router cache outlives the end of the session. */
const navigate = (url: string) => window.location.assign(url);
const COLOR_CLASS = { WHITE: "", RED: "mx-red", GREEN: "mx-green" } as const;
const STATE_WORD: Record<ThemeQuestion["state"], string> = {
  LOCKED: "Locked",
  AVAILABLE: "Open",
  ACTIVE: "In progress",
  PENDING_APPROVAL: "Review",
  APPROVED: "Approved",
  TIMED_OUT: "Timed out",
};

/**
 * The drill-down of one theme cell: its five questions (green = approved, red = a submission waits for the Admin,
 * white = anything else), and from a red question the submission review with Approve / Disapprove.
 *
 * It holds no game state. It re-reads the theme from the database while open (so a teammate's submit or another tab's
 * decision shows up), and Approve / Disapprove call the EXISTING authenticated B13 endpoints: the transition, the
 * configured reward, the next question, the ledger row and the idempotency all happen on the server. The
 * `Idempotency-Key` of one decision is kept until the server answers definitively, so a double click or a retry after a
 * lost response is a replay, never a second approval. The reference answer is never sent to the browser: the Admin
 * compares the submission with the official answer they hold separately.
 */
export function ThemeReviewDialog({
  team,
  themeCode,
  onClose,
  onChanged,
  fetchImpl,
  intervalMs,
}: Props) {
  const titleId = useId();
  const [data, setData] = useState<TeamThemeResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [reviewing, setReviewing] = useState<number | null>(null); // question id
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  const alive = useRef(true);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const r = await fetchTeamTheme(team.id, themeCode, fetchImpl);
    if (!alive.current) return;
    if (r.ok) {
      if (r.data.server_now >= latest.current) {
        latest.current = r.data.server_now;
        setData(r.data);
      }
      setFailed(false);
    } else if (r.status === 401) {
      navigate("/login/admin");
    } else {
      setFailed(true);
    }
  }, [team.id, themeCode, fetchImpl]);

  useEffect(() => {
    alive.current = true;
    const first = setTimeout(() => void load(), 0);
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, intervalMs);
    return () => {
      alive.current = false;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load, intervalMs]);

  const question = data?.questions.find((q) => q.id === reviewing) ?? null;
  const submission = question?.submission ?? null;
  // a decision made elsewhere (another tab) leaves nothing to review: fall back to the list with an explanation
  const gone = reviewing !== null && data !== null && !submission;

  async function decide(verdict: Verdict) {
    if (!submission || !question || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    const slot = `${verdict}:${submission.id}:${verdict === "disapprove" ? note.trim() : ""}`;
    const key = keys.current.get(slot) ?? newIdempotencyKey();
    keys.current.set(slot, key);
    const result = await reviewSubmission(submission.id, verdict, { key, note, fetchImpl });
    let done = false;
    if (result.ok) {
      done = true;
      const reward =
        typeof (result.data as { reward_awarded?: unknown })?.reward_awarded === "number"
          ? (result.data as { reward_awarded: number }).reward_awarded
          : null;
      setMessage(
        verdict === "approve"
          ? `${question.label} approved${reward !== null ? `: +${reward} coins for ${team.team_code}` : ""}.`
          : `${question.label} disapproved. ${team.team_code} can correct and submit again.`,
      );
      setReviewing(null);
      setNote("");
    } else {
      setMessage(
        result.code === "SUBMISSION_NOT_PENDING"
          ? "That submission was already reviewed."
          : gameErrorText(result.code),
      );
      // a definitive answer (anything but a lost response / server fault) ends this decision; keep the key otherwise
      done = result.status > 0 && result.status < 500;
    }
    if (done) keys.current.delete(slot);
    inFlight.current = false;
    setBusy(false);
    await load();
    onChanged();
  }

  return (
    <ModalDialog open onClose={onClose} labelledBy={titleId} className="dialog-wide">
      <div className="dialog-body">
        <h2 id={titleId} className="dialog-title" tabIndex={-1} data-autofocus>
          {team.team_code} · Theme {themeCode}
          {data ? ` · ${data.theme.name}` : ""}
        </h2>
        <div className="dialog-scroll grid gap-4 pb-2">
          {message ? (
            <p role="status" className="text-sm text-ink">
              {message}
            </p>
          ) : null}
          {failed ? (
            <p role="alert" className="text-sm text-ink">
              Could not load this theme. Retrying…
            </p>
          ) : null}
          {!data && !failed ? <p className="text-sm text-ink-dim">Loading…</p> : null}

          {data && (reviewing === null || gone) ? (
            <>
              {gone ? (
                <p role="status" className="text-sm text-ink">
                  That submission is no longer waiting for review.
                </p>
              ) : null}
              <div className="mx-qgrid" role="group" aria-label={`Questions of theme ${themeCode}`}>
                {data.questions.map((q) => {
                  const color = COLOR_CLASS[q.color];
                  const inner = (
                    <>
                      <span>{q.label}</span>
                      <small>{STATE_WORD[q.state]}</small>
                    </>
                  );
                  const label = `${q.label}: ${
                    q.color === "RED"
                      ? "submission waiting for review"
                      : q.color === "GREEN"
                        ? "approved"
                        : STATE_WORD[q.state].toLowerCase()
                  }`;
                  return q.color === "RED" ? (
                    <button
                      key={q.id}
                      type="button"
                      className={`mx-q ${color}`}
                      aria-label={label}
                      data-testid={`question-${q.label}`}
                      data-color={q.color}
                      onClick={() => {
                        setReviewing(q.id);
                        setMessage(null);
                        setNote("");
                      }}
                    >
                      {inner}
                    </button>
                  ) : (
                    <div
                      key={q.id}
                      className={`mx-q ${color}`}
                      role="img"
                      aria-label={label}
                      data-testid={`question-${q.label}`}
                      data-color={q.color}
                    >
                      {inner}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-ink-dim">
                Green: approved. Red: a submission is waiting. White: not currently pending.
              </p>
            </>
          ) : null}

          {data && submission && question && !gone ? (
            <div className="grid gap-4" aria-label={`Review ${question.label}`}>
              <p className="text-sm text-ink-dim">
                {team.team_code} · {question.label}
                {submission.submitted_by_slot
                  ? ` · submitted by M${submission.submitted_by_slot}`
                  : ""}
                {" · "}
                {new Date(submission.submitted_at).toLocaleString()}
              </p>
              <div>
                <p className="text-[11px] tracking-[0.2em] text-ink-dim uppercase">Question</p>
                <p className="text-sm whitespace-pre-wrap text-ink">{submission.body_md}</p>
              </div>
              <div>
                <p className="text-[11px] tracking-[0.2em] text-ink-dim uppercase">
                  Submitted answer
                </p>
                <p className="text-sm whitespace-pre-wrap text-ink" data-testid="review-answer">
                  {submission.answer}
                </p>
              </div>
              {submission.explanation ? (
                <div>
                  <p className="text-[11px] tracking-[0.2em] text-ink-dim uppercase">
                    Submitted explanation
                  </p>
                  <p
                    className="text-sm whitespace-pre-wrap text-ink"
                    data-testid="review-explanation"
                  >
                    {submission.explanation}
                  </p>
                </div>
              ) : null}
              <p className="text-xs text-ink-dim">
                Compare with the official answer you were given. Approve pays +
                {submission.reward_coins} coins once and opens the next question.
              </p>
              <label className="grid gap-1">
                <span className="text-[11px] tracking-[0.2em] text-ink-dim uppercase">
                  Note for the team (optional, used if you disapprove)
                </span>
                <input
                  className="rounded-lg border border-line bg-transparent px-3 py-2 text-sm text-ink"
                  maxLength={500}
                  value={note}
                  disabled={busy}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
            </div>
          ) : null}
        </div>
      </div>
      <div className="dialog-actions">
        {data && submission && question && !gone ? (
          <>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void decide("approve")}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void decide("disapprove")}
            >
              Disapprove
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setReviewing(null);
                setMessage(null);
              }}
            >
              Back to {themeCode}
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </ModalDialog>
  );
}

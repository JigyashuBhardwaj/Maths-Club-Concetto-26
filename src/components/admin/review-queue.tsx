"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { queueResultSchema, type PendingSubmission } from "@/lib/contracts/gameplay";
import { gameErrorText } from "@/lib/gameplay/messages";
import { newIdempotencyKey } from "@/lib/provisioning/client";

const REFRESH_MS = 5000;

interface ReviewQueueProps {
  /** Replaced in tests. */
  fetchImpl?: typeof fetch;
  intervalMs?: number;
}

type Verdict = "approve" | "disapprove";

/**
 * A THIN TESTING SURFACE for the B13 approval path, not the Admin dashboard: it lists the pending submissions of the
 * Admin's teams and calls the existing authenticated endpoints (`POST /api/admin/submissions/:id/approve|disapprove`),
 * so every click runs the real database functions. It holds no game state: after each action it re-reads the queue.
 * The Idempotency-Key of one click is kept until the server answers definitively, so a lost response can be retried.
 */
export function ReviewQueue({ fetchImpl, intervalMs = REFRESH_MS }: ReviewQueueProps) {
  const doFetch = fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const [rows, setRows] = useState<PendingSubmission[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    try {
      const res = await doFetch("/api/admin/queue", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const body = (await res.json()) as { ok?: unknown; data?: unknown };
      const parsed = res.ok && body.ok === true ? queueResultSchema.safeParse(body.data) : null;
      if (!parsed?.success) throw new Error("queue");
      setRows(parsed.data.submissions);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- doFetch is stable per mount (props are fixed)
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load, intervalMs]);

  const act = async (row: PendingSubmission, verdict: Verdict) => {
    if (busy) return;
    const slot = `${verdict}:${row.id}:${verdict === "disapprove" ? note.trim() : ""}`;
    const key = keys.current.get(slot) ?? newIdempotencyKey();
    keys.current.set(slot, key);
    setBusy(row.id);
    setMessage(null);
    let definitive = true;
    try {
      const res = await doFetch(`/api/admin/submissions/${row.id}/${verdict}`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body:
          verdict === "disapprove" && note.trim() ? JSON.stringify({ note: note.trim() }) : "{}",
      });
      const body = (await res.json()) as { ok?: unknown; error?: { code?: string } };
      if (res.ok && body.ok === true) {
        setMessage(verdict === "approve" ? "Approved." : "Disapproved.");
        setOpen(null);
        setNote("");
      } else {
        const code = body.error?.code ?? "";
        definitive = res.status < 500;
        setMessage(
          code === "SUBMISSION_NOT_PENDING"
            ? "Someone already reviewed that submission."
            : gameErrorText(code),
        );
      }
    } catch {
      definitive = false;
      setMessage("Could not reach the server. Try again.");
    }
    if (definitive) keys.current.delete(slot);
    setBusy(null);
    await load();
  };

  return (
    <section aria-label="Pending submissions">
      <p className="text-sm text-ink-dim">
        Temporary review page for testing. Approve pays the question&apos;s fixed reward once and
        opens the next question; Disapprove returns the question to the team with its remaining
        time.
      </p>
      {message ? (
        <p className="mt-4 text-sm text-ink" role="status">
          {message}
        </p>
      ) : null}
      {loadError ? (
        <p className="mt-4 text-sm text-ink" role="alert">
          Could not load the queue.
        </p>
      ) : null}
      {rows === null ? (
        <p className="mt-6 text-sm text-ink-dim">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-6 text-sm text-ink-dim">No submissions are waiting for review.</p>
      ) : (
        <ul className="mt-6 grid gap-3">
          {rows.map((row) => {
            const isOpen = open === row.id;
            return (
              <li key={row.id} className="rounded-xl border border-line p-4 text-sm text-ink">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    <strong>{row.team_code}</strong> · Theme {row.theme_code} · Q{row.ordinal}
                    {row.submitted_by_slot ? ` · member ${row.submitted_by_slot}` : ""}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost max-w-32"
                    aria-expanded={isOpen}
                    onClick={() => {
                      setOpen(isOpen ? null : row.id);
                      setNote("");
                    }}
                  >
                    {isOpen ? "Close" : "Open"}
                  </button>
                </div>
                {isOpen ? (
                  <div className="mt-4 grid gap-3">
                    <div>
                      <p className="text-[11px] tracking-[0.2em] text-ink-dim uppercase">
                        Question
                      </p>
                      <p className="whitespace-pre-wrap">{row.body_md}</p>
                    </div>
                    <div>
                      <p className="text-[11px] tracking-[0.2em] text-ink-dim uppercase">Answer</p>
                      <p className="whitespace-pre-wrap" data-testid="review-answer">
                        {row.answer}
                      </p>
                      {row.explanation ? (
                        <p className="whitespace-pre-wrap">{row.explanation}</p>
                      ) : null}
                    </div>
                    <label className="grid gap-1">
                      <span className="text-[11px] tracking-[0.2em] text-ink-dim uppercase">
                        Note for the team (optional)
                      </span>
                      <input
                        className="rounded-lg border border-line bg-transparent px-3 py-2"
                        maxLength={500}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                      />
                    </label>
                    <div className="flex flex-wrap gap-3">
                      <button
                        type="button"
                        className="btn btn-primary max-w-40"
                        disabled={busy !== null}
                        onClick={() => void act(row, "approve")}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost max-w-40"
                        disabled={busy !== null}
                        onClick={() => void act(row, "disapprove")}
                      >
                        Disapprove
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

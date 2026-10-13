"use client";

import Link from "next/link";
import { useCallback, useId, useMemo, useRef, useState } from "react";

import { GlassPanel } from "@/components/ui/glass-panel";
import { ModalDialog } from "@/components/ui/modal-dialog";
import {
  MAX_DELETE_SELECTION,
  type DeletableAdmin,
  type DeletableTeam,
} from "@/lib/contracts/deletion";
import {
  deleteAdminsCall,
  deleteTeamsCall,
  fetchDeletableAdmins,
  fetchDeletableTeams,
  type DeletionKind,
} from "@/lib/deletion/client";
import { isRetryable } from "@/lib/gameplay/messages";
import { newIdempotencyKey } from "@/lib/provisioning/client";

type Row = { id: string; primary: string; secondary: string; meta: string; teams: number };

interface DeletionScreenProps {
  kind: DeletionKind;
  /** The server-rendered first list; `null` when it could not be read (the screen then shows its error state). */
  initialAdmins?: DeletableAdmin[] | null;
  initialTeams?: DeletableTeam[] | null;
  /** Replaced in tests. */
  fetchImpl?: typeof fetch;
}

const COPY = {
  admins: {
    title: "Delete Admins",
    noun: "admin",
    nouns: "admins",
    intro:
      "Select the Admins to remove for good. An Admin's teams and everything those teams did are deleted with it.",
    empty: "There are no admins to delete.",
  },
  teams: {
    title: "Delete Teams",
    noun: "team",
    nouns: "teams",
    intro:
      "Select the teams to remove for good, whichever Admin they belong to. Their members, progress, submissions, purchases and coin history are deleted.",
    empty: "There are no teams to delete.",
  },
} as const;

/** Fixed wording chosen by the error CODE only: nothing the server sends is shown verbatim. */
function errorText(code: string, plural: string): string {
  switch (code) {
    case "NOT_FOUND":
      return `Some of the selected ${plural} no longer exist, so nothing was deleted. The list has been refreshed.`;
    case "FORBIDDEN":
      return "You are not allowed to delete these.";
    case "UNAUTHENTICATED":
      return "Your session has ended. Sign in again to continue.";
    case "DELETE_BLOCKED":
      return `Nothing was deleted: some of these ${plural} are still referenced by other records.`;
    case "VALIDATION_FAILED":
      return `Select between 1 and ${MAX_DELETE_SELECTION} ${plural}.`;
    case "NETWORK_ERROR":
      return "Couldn't reach the server, so we can't tell whether the deletion happened. Try again: the same request is never applied twice.";
    case "IDEMPOTENCY_KEY_REUSED":
      return "That request was already used for something else. Please try again.";
    default:
      return "Something went wrong on our side. Nothing was reported as deleted. Please try again.";
  }
}

function TrashIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * "Delete Admins" / "Delete Teams" (Super Admin). A selectable list, a trash button with the selected count, and a
 * confirmation dialog. Nothing is sent until "Yes". "No", Escape and the backdrop close the dialog and change nothing.
 * One "Yes" is one request with one Idempotency-Key (reused only when the outcome is unknown), the buttons are disabled
 * while it runs, and success is reported only after the server confirmed it. After a success the list is read again from
 * the server and the selection is cleared; after a failure the dialog's selection stays so the person can retry.
 */
export function DeletionScreen({
  kind,
  initialAdmins,
  initialTeams,
  fetchImpl,
}: DeletionScreenProps) {
  const copy = COPY[kind];
  const titleId = useId();
  const dialogTitleId = useId();
  const toRows = useCallback(
    (
      admins: DeletableAdmin[] | null | undefined,
      teams: DeletableTeam[] | null | undefined,
    ): Row[] | null => {
      if (kind === "admins") {
        if (!admins) return null;
        return admins.map((a) => ({
          id: a.id,
          primary: a.username,
          secondary: `${a.team_count} ${plural(a.team_count, "team", "teams")}`,
          meta: a.is_active ? "Active" : "Disabled",
          teams: a.team_count,
        }));
      }
      if (!teams) return null;
      return teams.map((t) => ({
        id: t.id,
        primary: `${t.team_code} · ${t.name}`,
        secondary: `Login ID ${t.login_id} · Admin ${t.admin_username}`,
        meta: `${t.status.replaceAll("_", " ").toLowerCase()} · ${t.member_count} members`,
        teams: 1,
      }));
    },
    [kind],
  );

  const [rows, setRows] = useState<Row[] | null>(() => toRows(initialAdmins, initialTeams));
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const attempt = useRef<{ key: string; fingerprint: string } | null>(null);
  /** Set when the dialog is closed BY an error message that must outlive it (the selection no longer exists). */
  const keepErrorOnClose = useRef(false);

  const ids = useMemo(() => new Set((rows ?? []).map((r) => r.id)), [rows]);
  const count = selected.size;
  const atLimit = count >= MAX_DELETE_SELECTION;

  /** Reads the list again; the selection is cut down to the records that still exist. */
  const reload = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    const r =
      kind === "admins"
        ? await fetchDeletableAdmins(fetchImpl)
        : await fetchDeletableTeams(fetchImpl);
    setLoading(false);
    if (!r.ok) return false;
    const next = toRows(
      kind === "admins" ? (r.data as DeletableAdmin[]) : undefined,
      kind === "teams" ? (r.data as DeletableTeam[]) : undefined,
    );
    if (!next) return false;
    setRows(next);
    const live = new Set(next.map((x) => x.id));
    setSelected((prev) => new Set([...prev].filter((id) => live.has(id))));
    return true;
  }, [kind, fetchImpl, toRows]);

  const toggle = (id: string) => {
    if (busy) return;
    setNotice(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_DELETE_SELECTION) next.add(id);
      return next;
    });
  };

  const allSelectable = !!rows && rows.length > 0 && rows.length <= MAX_DELETE_SELECTION;
  const allSelected = allSelectable && rows.every((r) => selected.has(r.id));
  const toggleAll = () => {
    if (busy || !rows) return;
    setNotice(null);
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  };

  const closeDialog = () => {
    setOpen(false);
    if (keepErrorOnClose.current) {
      keepErrorOnClose.current = false; // the native `close` event arrives after this and must not erase the message
      return;
    }
    if (!inFlight.current) setError(null);
  };

  const confirm = async () => {
    if (inFlight.current || count === 0) return; // a double click / double Enter sends one request
    const chosen = [...selected].filter((id) => ids.has(id)).sort();
    if (chosen.length === 0) return;
    const fingerprint = chosen.join(",");
    if (attempt.current?.fingerprint !== fingerprint) {
      attempt.current = { key: newIdempotencyKey(), fingerprint };
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const opts = { key: attempt.current.key, fetchImpl };
    const result =
      kind === "admins"
        ? await deleteAdminsCall(chosen, opts)
        : await deleteTeamsCall(chosen, opts);
    inFlight.current = false;
    setBusy(false);

    if (result.ok) {
      attempt.current = null;
      const data = result.data as { deleted: { admins?: number; teams: number } };
      setSelected(new Set());
      setOpen(false);
      setError(null);
      const refreshed = await reload();
      const text =
        kind === "admins"
          ? `Deleted ${data.deleted.admins ?? 0} ${plural(data.deleted.admins ?? 0, "admin", "admins")} and ${data.deleted.teams} ${plural(data.deleted.teams, "team", "teams")}.`
          : `Deleted ${data.deleted.teams} ${plural(data.deleted.teams, "team", "teams")}.`;
      setNotice(refreshed ? text : `${text} The list could not be refreshed: reload the page.`);
      return;
    }

    // Only an unknown outcome keeps the key, so a retry replays a request that did succeed instead of repeating it.
    if (!isRetryable(result.code)) attempt.current = null;
    setError(errorText(result.code, copy.nouns));
    if (result.code === "NOT_FOUND") {
      keepErrorOnClose.current = true;
      setOpen(false);
      await reload();
    }
  };

  const openDialog = () => {
    if (busy || count === 0) return;
    keepErrorOnClose.current = false;
    setError(null);
    setNotice(null);
    setOpen(true);
  };

  const dialogPhrase = `Do you want to permanently delete the selected ${count === 1 ? copy.noun : copy.nouns}?`;
  const teamsAffected = (rows ?? [])
    .filter((r) => selected.has(r.id))
    .reduce((n, r) => n + r.teams, 0);

  return (
    <section aria-labelledby={titleId} aria-busy={busy || loading}>
      <GlassPanel className="max-w-3xl p-6 md:p-8">
        <Link
          href="/superadmin"
          className="inline-flex items-center gap-2 text-sm text-ink-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange/70"
        >
          <span aria-hidden="true">←</span> Go back
        </Link>
        <h1 id={titleId} className="mt-4 text-2xl font-semibold text-ink">
          {copy.title}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-dim">{copy.intro}</p>

        {notice ? (
          <p
            role="status"
            className="mt-4 rounded-row border border-line bg-white/5 px-3 py-2 text-sm text-ink"
          >
            {notice}
          </p>
        ) : null}
        {error && !open ? (
          <p
            role="alert"
            className="mt-4 rounded-row border border-orange/40 bg-orange/10 px-3 py-2 text-sm text-ink"
          >
            {error}
          </p>
        ) : null}

        {rows === null ? (
          <div className="mt-6" data-testid="deletion-error">
            <p role="alert" className="text-sm text-ink">
              The list could not be loaded.
            </p>
            <button
              type="button"
              className="btn mt-3 !flex-none"
              disabled={loading}
              onClick={() => void reload()}
            >
              {loading ? "Loading…" : "Try again"}
            </button>
          </div>
        ) : rows.length === 0 ? (
          <p className="mt-6 text-sm text-ink-dim" data-testid="deletion-empty">
            {copy.empty}
          </p>
        ) : (
          <>
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
              <div className="flex items-center gap-3">
                {allSelectable ? (
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer accent-orange"
                      checked={allSelected}
                      disabled={busy}
                      onChange={toggleAll}
                    />
                    Select all
                  </label>
                ) : (
                  <span className="text-xs text-ink-dim">
                    Select up to {MAX_DELETE_SELECTION} at a time.
                  </span>
                )}
                <span
                  className="text-sm text-ink-dim"
                  aria-live="polite"
                  data-testid="selected-count"
                >
                  {count} selected
                </span>
              </div>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-row border border-orange/40 px-3 py-2 text-sm text-ink hover:border-orange/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange/70 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={count === 0 || busy}
                onClick={openDialog}
                aria-label={`Delete selected ${count === 1 ? copy.noun : copy.nouns} (${count})`}
              >
                <TrashIcon />
                <span aria-hidden="true">Delete ({count})</span>
              </button>
            </div>
            <ul className="mt-2 grid gap-1" aria-label={copy.title}>
              {rows.map((r) => {
                const checked = selected.has(r.id);
                const blocked = !checked && atLimit;
                return (
                  <li key={r.id}>
                    <label
                      className={`flex cursor-pointer items-start gap-3 rounded-row px-3 py-2.5 hover:bg-white/5 ${checked ? "bg-white/5" : ""} ${blocked ? "cursor-not-allowed opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-orange"
                        checked={checked}
                        disabled={busy || blocked}
                        onChange={() => toggle(r.id)}
                        aria-label={`Select ${r.primary}`}
                      />
                      <span className="grid min-w-0 gap-0.5">
                        <span className="truncate text-sm font-semibold text-ink">{r.primary}</span>
                        <span className="truncate text-xs text-ink-dim">{r.secondary}</span>
                        <span className="text-[11px] tracking-wide text-ink-dim uppercase">
                          {r.meta}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </GlassPanel>

      <ModalDialog open={open} onClose={closeDialog} labelledBy={dialogTitleId}>
        <div className="dialog-body">
          <h2 id={dialogTitleId} className="dialog-title" tabIndex={-1} data-autofocus>
            {count === 1 ? `Delete ${copy.noun}?` : `Delete ${count} ${copy.nouns}?`}
          </h2>
          <p className="dialog-text">{dialogPhrase}</p>
          <p className="dialog-text">
            {kind === "admins"
              ? `${teamsAffected} ${plural(teamsAffected, "team", "teams")} and all ${plural(teamsAffected, "its", "their")} members, progress, submissions, purchases and coin history will be deleted with ${count === 1 ? "this admin" : "these admins"}. This can't be undone. The usernames can be used again.`
              : "Their members, progress, submissions, purchases and coin history will be deleted. This can't be undone. The Login IDs can be used again."}
          </p>
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
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? "Deleting…" : "Yes"}
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={closeDialog}>
            No
          </button>
        </div>
      </ModalDialog>
    </section>
  );
}

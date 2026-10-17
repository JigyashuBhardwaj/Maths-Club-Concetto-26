"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { GlassPanel } from "@/components/ui/glass-panel";
import { ModalDialog } from "@/components/ui/modal-dialog";
import {
  BLOCK_REASON_TEXT,
  RENEWAL_LIMITS,
  contentToDraft,
  draftProblems,
  draftToContent,
  questionKey,
  type Draft,
  type DraftTheme,
  type Problems,
  type RenewalRead,
  type RenewalReadiness,
} from "@/lib/contracts/renewal";
import { isRetryable } from "@/lib/gameplay/messages";
import { newIdempotencyKey } from "@/lib/provisioning/client";
import { fetchRenewal, renewCall } from "@/lib/renewal/client";

interface RenewScreenProps {
  /** The server-rendered first read; `null` when it could not be read (the screen then shows an error state with a retry). */
  initial: RenewalRead | null;
  /** Replaced in tests. */
  fetchImpl?: typeof fetch;
}

/** A rule being edited. The key is local (React identity while rules are added and removed); it is never sent. */
interface RuleRow {
  k: number;
  text: string;
}

/** The exact words of the specification's confirmation dialog. */
const DIALOG_TITLE = "Apply Changes";
const DIALOG_MESSAGE =
  "Are you sure you want to apply the changes? Doing so will delete all admins created by the Superadmin and, consequently, all teams created by those admins. The edited competition content will also be applied.";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Fixed wording chosen by the error CODE only: nothing the server sends is shown verbatim. */
function errorText(code: string): string {
  switch (code) {
    case "RENEWAL_BLOCKED":
      return "Nothing was changed. Some teams are still playing. Wait until every team has submitted its final answer or its overall timer has run out, then apply again.";
    case "CONTENT_CHANGED":
      return "Nothing was changed. The competition content was changed by someone else after you opened this page. Load the latest content, then make your edits again.";
    case "RENEWAL_INCOMPLETE":
      return "Nothing was changed. Some admins were not created by the Superadmin, so a renewal cannot remove them. Remove them with “Delete admins” first, then apply again.";
    case "VALIDATION_FAILED":
      return "Nothing was changed. Some of the content is not acceptable. The fields to fix are marked.";
    case "FORBIDDEN":
      return "Nothing was changed. Only the Superadmin can renew the competition.";
    case "UNAUTHENTICATED":
      return "Nothing was changed. Your session has ended. Sign in again to continue.";
    case "DELETE_BLOCKED":
      return "Nothing was changed: some of the admins or teams are still referenced by other records.";
    case "NETWORK_ERROR":
      return "Couldn't reach the server, so we can't tell whether the renewal happened. Apply again: the same request is never applied twice.";
    case "IDEMPOTENCY_KEY_REUSED":
      return "That request was already used for something else. Please try again.";
    default:
      return "Something went wrong on our side. Nothing was reported as applied. Please try again.";
  }
}

let ruleKeySeed = 0;
const toRuleRows = (rules: readonly string[]): RuleRow[] =>
  rules.map((text) => ({ k: ++ruleKeySeed, text }));

/** Same text-wrapping field for every editable value. Visibly an input (border, tinted fill), unlike the plain labels. */
const FIELD_CLASS =
  "w-full resize-y rounded-row border border-dashed border-orange/45 bg-white/5 px-3 py-2 text-sm leading-relaxed text-ink placeholder:text-ink-dim focus-visible:border-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange/70 disabled:opacity-60 aria-[invalid=true]:border-solid aria-[invalid=true]:border-[#ff8a5c]";

const LABEL_CLASS = "text-[11px] font-semibold tracking-[0.18em] text-ink-dim uppercase";

const rowsFor = (value: string, min: number) =>
  Math.min(14, Math.max(min, value.split("\n").length));

function Badge({ children }: { children: string }) {
  return (
    <span className="inline-flex min-w-10 items-center justify-center rounded-row bg-[#c2410c] px-3 py-1 text-lg font-semibold text-white">
      {children}
    </span>
  );
}

interface FieldRowProps {
  id: string;
  label: string;
  ariaLabel: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  disabled: boolean;
  minRows?: number;
  numeric?: boolean;
}

/** One `label | value` row of the editor's tables. */
function FieldRow({
  id,
  label,
  ariaLabel,
  value,
  onChange,
  error,
  disabled,
  minRows = 2,
  numeric,
}: FieldRowProps) {
  const errId = `${id}-error`;
  return (
    <div className="grid border-b border-line last:border-b-0 sm:grid-cols-[8.5rem_1fr]">
      <label htmlFor={id} className={`${LABEL_CLASS} px-3 pt-3 sm:py-3`}>
        {label}
      </label>
      <div className="grid gap-1 px-3 py-2">
        {numeric ? (
          <input
            id={id}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            aria-label={ariaLabel}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errId : undefined}
            className={`${FIELD_CLASS} sm:max-w-48`}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <textarea
            id={id}
            aria-label={ariaLabel}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errId : undefined}
            className={FIELD_CLASS}
            rows={rowsFor(value, minRows)}
            value={value}
            disabled={disabled}
            spellCheck
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {error ? (
          <p id={errId} className="text-xs text-[#ffb08a]">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The data-loss sentence of the confirmation dialog: always explicit about how many submissions are affected. */
function pendingWarning(n: number): string {
  return n > 0
    ? `Warning: ${n} ${plural(n, "submission", "submissions")} still awaiting approval will be permanently discarded together with ${plural(n, "its team", "their teams")}. ${plural(n, "It", "They")} will not be reviewed, scored or paid.`
    : "No submissions are awaiting approval, so none will be discarded.";
}

function readinessLine(r: RenewalReadiness, withPending = true): string {
  const people = `${r.admins} ${plural(r.admins, "admin", "admins")} and ${r.teams} ${plural(r.teams, "team", "teams")}`;
  const pending =
    withPending && r.pending_submissions > 0
      ? ` ${r.pending_submissions} ${plural(r.pending_submissions, "submission", "submissions")} still awaiting approval will be discarded with them.`
      : "";
  return r.ready
    ? `Ready to apply. ${people} created by the Superadmin will be deleted.${pending}`
    : `Not ready: ${r.blocked_count} ${plural(r.blocked_count, "team is", "teams are")} still playing. ${people} would be deleted once every team has submitted or timed out.${pending}`;
}

/**
 * "Renew the Competition" (Super Admin only; the route's layout and the API both enforce that). A scrollable editor for the
 * fixed structure — 10 themes (A–J) × 5 questions × 2 hints, rewards, and a list of rules — with RESET and APPLY CHANGES at the end.
 *
 * - Only texts, rewards and rules can be edited; identifiers are labels. The draft is held in memory only.
 * - RESET restores what was loaded from the server (no request is sent).
 * - APPLY CHANGES validates locally and opens the "Apply Changes" dialog. "GO BACK" closes it and keeps every edit. "YES, APPLY
 *   CHANGES" sends ONE request with one Idempotency-Key (reused only when the outcome is unknown); everything is disabled while
 *   it runs, and success is reported only after the server confirmed that the whole renewal was applied.
 * - Leaving the page with edits (links, the browser's Back button, reload, closing the tab) asks first.
 */
export function RenewScreen({ initial, fetchImpl }: RenewScreenProps) {
  const router = useRouter();
  const titleId = useId();
  const dialogTitleId = useId();
  const leaveTitleId = useId();
  const base = useId();

  const [snap, setSnap] = useState<RenewalRead | null>(initial);
  const [themes, setThemes] = useState<DraftTheme[]>(() =>
    initial ? contentToDraft(initial.content).themes : [],
  );
  const [rules, setRules] = useState<RuleRow[]>(() =>
    initial ? toRuleRows(initial.content.rules) : [],
  );
  const [showErrors, setShowErrors] = useState(false);
  const [serverProblems, setServerProblems] = useState<Problems>({});
  const [dialog, setDialog] = useState<"apply" | "leave" | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  /** The Apply dialog re-reads the server when it opens, so the number of discarded submissions it shows is current. */
  const [checked, setChecked] = useState<"pending" | "yes" | "failed">("pending");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState<RenewalRead | "unknown" | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  const inFlight = useRef(false);
  const attempt = useRef<{ key: string; fingerprint: string } | null>(null);
  const root = useRef<HTMLElement>(null);
  /** Where the person was heading when the "leave without applying?" dialog opened (null = the browser's Back). */
  const leaveTo = useRef<string | null>(null);
  const bypassGuard = useRef(false);
  const guardPushed = useRef(false);

  const draft: Draft = useMemo(
    () => ({ themes, rules: rules.map((r) => r.text) }),
    [themes, rules],
  );
  const original = useMemo(() => (snap ? contentToDraft(snap.content) : null), [snap]);
  const dirty = !!original && !sameDraft(draft, original);
  const localProblems = useMemo(() => draftProblems(draft), [draft]);
  const problems: Problems = showErrors ? { ...serverProblems, ...localProblems } : serverProblems;
  const problemCount = Object.keys(localProblems).length;

  // ---- leaving with unsaved edits ------------------------------------------------------------------------------------------

  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current || bypassGuard.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  useEffect(() => {
    /** In-app links (the sidebar, "Go back", the logo...): intercepted while there are edits, in the capture phase. */
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current || bypassGuard.current || e.defaultPrevented) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      let url: URL;
      try {
        url = new URL(a.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search)
        return; // same page (an in-page anchor): nothing is lost
      e.preventDefault();
      e.stopPropagation();
      leaveTo.current = url.pathname + url.search + url.hash;
      setDialog("leave");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    /** The Back button: one extra history entry is kept while there are edits, so Back lands here and can be answered. */
    if (dirty && !guardPushed.current) {
      window.history.pushState(window.history.state, "", window.location.href);
      guardPushed.current = true;
    }
  }, [dirty]);

  useEffect(() => {
    const onPop = () => {
      if (!guardPushed.current || bypassGuard.current) return;
      if (!dirtyRef.current) {
        guardPushed.current = false;
        bypassGuard.current = true;
        window.history.back(); // the extra entry only: nothing to ask
        return;
      }
      guardPushed.current = false;
      leaveTo.current = null;
      setDialog("leave");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const stayHere = () => {
    setDialog(null);
    if (leaveTo.current === null && dirtyRef.current && !guardPushed.current) {
      window.history.pushState(window.history.state, "", window.location.href);
      guardPushed.current = true;
    }
    leaveTo.current = null;
  };
  const leaveNow = () => {
    const to = leaveTo.current;
    bypassGuard.current = true;
    setDialog(null);
    if (to === null) window.history.back();
    else router.push(to);
  };

  // ---- editing --------------------------------------------------------------------------------------------------------------

  const setTheme = (i: number, patch: Partial<Pick<DraftTheme, "name" | "description">>) =>
    setThemes((prev) => prev.map((t, x) => (x === i ? { ...t, ...patch } : t)));
  const setQuestion = (
    i: number,
    j: number,
    patch: Partial<
      Pick<DraftTheme["questions"][number], "question" | "hint1" | "hint2" | "reward">
    >,
  ) =>
    setThemes((prev) =>
      prev.map((t, x) =>
        x === i
          ? { ...t, questions: t.questions.map((q, y) => (y === j ? { ...q, ...patch } : q)) }
          : t,
      ),
    );
  const setRule = (k: number, text: string) =>
    setRules((prev) => prev.map((r) => (r.k === k ? { ...r, text } : r)));
  const removeRule = (k: number) => setRules((prev) => prev.filter((r) => r.k !== k));
  const addRule = () =>
    setRules((prev) =>
      prev.length >= RENEWAL_LIMITS.maxRules ? prev : [...prev, ...toRuleRows([""])],
    );

  /** Puts a server snapshot into the editor (the edits it replaces are gone). */
  const adopt = useCallback((r: RenewalRead) => {
    const d = contentToDraft(r.content);
    setSnap(r);
    setThemes(d.themes);
    setRules(toRuleRows(d.rules));
    setShowErrors(false);
    setServerProblems({});
    setStale(null);
    attempt.current = null;
  }, []);

  const reset = () => {
    if (busy || !original) return;
    setThemes(
      original.themes.map((t) => ({ ...t, questions: t.questions.map((q) => ({ ...q })) })),
    );
    setRules(toRuleRows(original.rules));
    setShowErrors(false);
    setServerProblems({});
    setError(null);
    setNotice(
      "The content was restored to what it was when this page was loaded. Nothing was sent.",
    );
    attempt.current = null;
  };

  // ---- reading --------------------------------------------------------------------------------------------------------------

  /** Reads the server again. `keepEdits`: only the readiness is taken (and a changed token is reported); else all is replaced. */
  const knownToken = snap?.token ?? null;
  const reload = useCallback(
    async (keepEdits: boolean): Promise<boolean> => {
      setLoading(true);
      const r = await fetchRenewal(fetchImpl);
      setLoading(false);
      if (!r.ok) return false;
      if (!keepEdits) {
        adopt(r.data);
        return true;
      }
      setSnap((prev) => (prev ? { ...prev, readiness: r.data.readiness } : prev));
      if (knownToken !== r.data.token) {
        setStale(r.data);
        // the content changed while the Apply dialog was being opened: the stale banner takes over, nothing is confirmed
        setDialog((d) => (d === "apply" ? null : d));
      }
      return true;
    },
    [adopt, fetchImpl, knownToken],
  );

  // ---- applying -------------------------------------------------------------------------------------------------------------

  useEffect(() => {
    if (focusTick === 0) return;
    root.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
  }, [focusTick]);

  const openApply = () => {
    if (busy || !snap || stale) return;
    setNotice(null);
    setError(null);
    setServerProblems({});
    setShowErrors(true);
    if (problemCount > 0) {
      setError(
        `Fix ${problemCount} ${plural(problemCount, "field", "fields")} before applying. They are marked below.`,
      );
      setFocusTick((t) => t + 1);
      return;
    }
    setChecked("pending");
    setDialog("apply");
    void reload(true).then((ok) => setChecked(ok ? "yes" : "failed"));
  };

  const closeApply = () => {
    if (dialog === "apply") setDialog(null);
  };

  const confirm = async () => {
    if (inFlight.current || !snap || problemCount > 0 || checked !== "yes" || stale) return; // a double click / double Enter sends one request
    const body = { content: draftToContent(draft), expectedToken: snap.token };
    const fingerprint = JSON.stringify(body);
    if (attempt.current?.fingerprint !== fingerprint) {
      attempt.current = { key: newIdempotencyKey(), fingerprint };
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await renewCall(body, { key: attempt.current.key, fetchImpl });
    inFlight.current = false;
    setBusy(false);

    if (result.ok) {
      attempt.current = null;
      setDialog(null);
      const d = result.data;
      const text =
        `The competition was renewed. Deleted ${d.deleted.admins} ${plural(d.deleted.admins, "admin", "admins")} ` +
        `and ${d.deleted.teams} ${plural(d.deleted.teams, "team", "teams")}` +
        (d.discarded.pending_submissions > 0
          ? `, and discarded ${d.discarded.pending_submissions} ${plural(d.discarded.pending_submissions, "submission", "submissions")} still awaiting approval`
          : "") +
        "; the edited content is now live.";
      const r = await fetchRenewal(fetchImpl);
      if (r.ok) {
        adopt(r.data);
        setNotice(text);
      } else {
        // The renewal is done; only the refresh failed. The editor keeps showing what was applied.
        setSnap((prev) =>
          prev
            ? {
                content: { themes: draftToContent(draft).themes, rules: draft.rules },
                token: d.token,
                readiness: {
                  ...prev.readiness,
                  ready: true,
                  blocked_count: 0,
                  blockers: [],
                  admins: 0,
                  teams: 0,
                  pending_submissions: 0,
                },
              }
            : prev,
        );
        setNotice(`${text} The page could not be refreshed: reload it to see the current state.`);
      }
      return;
    }

    if (!isRetryable(result.code)) attempt.current = null;
    setDialog(null);
    setError(errorText(result.code));
    if (result.code === "VALIDATION_FAILED") {
      const fields = result.details?.fields;
      if (Array.isArray(fields)) {
        const next: Problems = {};
        for (const f of fields) if (typeof f === "string") next[f] = "Not acceptable.";
        setServerProblems(next);
        setShowErrors(true);
        setFocusTick((t) => t + 1);
      }
    }
    if (result.code === "RENEWAL_BLOCKED") await reload(true);
    if (result.code === "CONTENT_CHANGED") {
      setStale("unknown");
      await reload(true);
    }
  };

  const loadLatest = async () => {
    if (busy) return;
    const r = await fetchRenewal(fetchImpl);
    if (!r.ok) {
      setError("The latest content could not be loaded. Try again.");
      return;
    }
    adopt(r.data);
    setError(null);
    setNotice("The latest content was loaded. Your earlier edits were discarded.");
  };

  // ---- rendering ------------------------------------------------------------------------------------------------------------

  const fid = (path: string) => `${base}-${path}`;
  const err = (path: string) => problems[path];

  if (!snap) {
    return (
      <section aria-labelledby={titleId} className="grid gap-4">
        <GlassPanel className="max-w-3xl p-6 md:p-8">
          <Link
            href="/superadmin"
            className="inline-flex items-center gap-2 text-sm text-ink-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange/70"
          >
            <span aria-hidden="true">←</span> Go back
          </Link>
          <h1 id={titleId} className="mt-4 text-2xl font-semibold text-ink">
            Renew the Competition
          </h1>
          <div className="mt-6" data-testid="renew-load-error">
            <p role="alert" className="text-sm text-ink">
              The competition content could not be loaded.
            </p>
            <button
              type="button"
              className="btn mt-3 !flex-none"
              disabled={loading}
              onClick={() => void reload(false)}
            >
              {loading ? "Loading…" : "Try again"}
            </button>
          </div>
        </GlassPanel>
      </section>
    );
  }

  const readiness = snap.readiness;

  return (
    <section
      ref={root}
      aria-labelledby={titleId}
      aria-busy={busy || loading}
      className="grid gap-5"
    >
      <GlassPanel className="max-w-5xl p-6 md:p-8">
        <div className="grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
          <Link
            href="/superadmin"
            className="inline-flex items-center gap-2 text-sm text-ink-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange/70 sm:justify-self-start"
          >
            <span aria-hidden="true">←</span> Go back
          </Link>
          <h1 id={titleId} className="text-2xl font-semibold text-ink sm:text-center">
            Renew the Competition
          </h1>
          <span aria-hidden="true" />
        </div>
        <p className="mt-3 text-sm leading-relaxed text-ink-dim">
          Edit the names, descriptions, questions, hints, rewards and rules, then apply. Applying
          also deletes every admin created by the Superadmin and their teams. The themes, questions
          and hints themselves (A–J, 5 questions each, 2 hints each) are fixed.
        </p>

        <div
          role="status"
          data-testid="renew-readiness"
          className={`mt-4 rounded-row border px-3 py-2 text-sm text-ink ${readiness.ready ? "border-line bg-white/5" : "border-orange/40 bg-orange/10"}`}
        >
          {readinessLine(readiness)}
          {readiness.blockers.length > 0 ? (
            <ul className="mt-2 grid gap-0.5 text-xs text-ink-dim">
              {readiness.blockers.slice(0, 10).map((b) => (
                <li key={b.team_code}>
                  {b.team_code} · {b.name} {BLOCK_REASON_TEXT[b.reason]}
                </li>
              ))}
              {readiness.blockers.length > 10 ? (
                <li>and {readiness.blockers.length - 10} more</li>
              ) : null}
            </ul>
          ) : null}
          <button
            type="button"
            className="mt-2 text-xs underline underline-offset-2 hover:text-ink disabled:opacity-50"
            disabled={loading || busy}
            onClick={() => void reload(true)}
          >
            {loading ? "Checking…" : "Check again"}
          </button>
        </div>

        {stale ? (
          <div
            role="alert"
            data-testid="renew-stale"
            className="mt-4 rounded-row border border-orange/40 bg-orange/10 px-3 py-2 text-sm text-ink"
          >
            <p>
              The competition content was changed by someone else after you opened this page. You
              can&apos;t apply edits made on the old version.
            </p>
            <button
              type="button"
              className="btn mt-2 !flex-none"
              disabled={busy}
              onClick={() => void loadLatest()}
            >
              Discard my edits and load the latest
            </button>
          </div>
        ) : null}

        {notice ? (
          <p
            role="status"
            data-testid="renew-notice"
            className="mt-4 rounded-row border border-line bg-white/5 px-3 py-2 text-sm text-ink"
          >
            {notice}
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            data-testid="renew-error"
            className="mt-4 rounded-row border border-orange/40 bg-orange/10 px-3 py-2 text-sm text-ink"
          >
            {error}
          </p>
        ) : null}
        {busy ? (
          <p role="status" data-testid="renew-progress" className="mt-4 text-sm text-ink">
            Applying changes… Please keep this page open.
          </p>
        ) : null}
      </GlassPanel>

      {themes.map((t, i) => (
        <GlassPanel key={t.id} className="max-w-5xl p-4 md:p-6">
          <section aria-label={`Theme ${t.id}`} className="grid gap-4">
            <div className="grid gap-2">
              <Badge>{t.id}</Badge>
              <div className="overflow-hidden rounded-row border border-line">
                <FieldRow
                  id={fid(`themes.${t.id}.name`)}
                  label="Theme name"
                  ariaLabel={`Theme ${t.id} name`}
                  value={t.name}
                  minRows={1}
                  disabled={busy}
                  error={err(`themes.${t.id}.name`)}
                  onChange={(v) => setTheme(i, { name: v })}
                />
                <FieldRow
                  id={fid(`themes.${t.id}.description`)}
                  label="Theme description"
                  ariaLabel={`Theme ${t.id} description`}
                  value={t.description}
                  minRows={3}
                  disabled={busy}
                  error={err(`themes.${t.id}.description`)}
                  onChange={(v) => setTheme(i, { description: v })}
                />
              </div>
            </div>
            {t.questions.map((q, j) => {
              const key = questionKey(t.id, j + 1);
              return (
                <div key={q.id} className="grid gap-2">
                  <Badge>{key}</Badge>
                  <div className="overflow-hidden rounded-row border border-line">
                    <FieldRow
                      id={fid(`questions.${key}.question`)}
                      label="Question"
                      ariaLabel={`Question ${key}`}
                      value={q.question}
                      minRows={3}
                      disabled={busy}
                      error={err(`questions.${key}.question`)}
                      onChange={(v) => setQuestion(i, j, { question: v })}
                    />
                    <FieldRow
                      id={fid(`questions.${key}.hint1`)}
                      label="Hint 1"
                      ariaLabel={`Hint 1 of ${key}`}
                      value={q.hint1}
                      disabled={busy}
                      error={err(`questions.${key}.hint1`)}
                      onChange={(v) => setQuestion(i, j, { hint1: v })}
                    />
                    <FieldRow
                      id={fid(`questions.${key}.hint2`)}
                      label="Hint 2"
                      ariaLabel={`Hint 2 of ${key}`}
                      value={q.hint2}
                      disabled={busy}
                      error={err(`questions.${key}.hint2`)}
                      onChange={(v) => setQuestion(i, j, { hint2: v })}
                    />
                    <FieldRow
                      id={fid(`questions.${key}.reward`)}
                      label="Reward"
                      ariaLabel={`Reward of ${key}`}
                      value={q.reward}
                      numeric
                      disabled={busy}
                      error={err(`questions.${key}.reward`)}
                      onChange={(v) => setQuestion(i, j, { reward: v })}
                    />
                  </div>
                </div>
              );
            })}
          </section>
        </GlassPanel>
      ))}

      <GlassPanel className="max-w-5xl p-4 md:p-6">
        <section aria-label="Rules and regulations" className="grid gap-3">
          <h2 className="inline-flex w-fit items-center rounded-row bg-[#c2410c] px-3 py-1 text-lg font-semibold tracking-wide text-white uppercase">
            Rules and regulations
          </h2>
          {err("rules") ? (
            <p role="alert" className="text-xs text-[#ffb08a]">
              {err("rules")}
            </p>
          ) : null}
          <ol className="grid gap-0 overflow-hidden rounded-row border border-line">
            {rules.map((r, n) => {
              const path = `rules.${n + 1}`;
              const id = fid(path);
              return (
                <li
                  key={r.k}
                  className="grid items-start gap-2 border-b border-line px-3 py-2 last:border-b-0 sm:grid-cols-[2.5rem_1fr_auto]"
                >
                  <span className="pt-2 text-sm font-semibold text-ink" aria-hidden="true">
                    {n + 1}.
                  </span>
                  <div className="grid gap-1">
                    <textarea
                      id={id}
                      aria-label={`Rule ${n + 1}`}
                      aria-invalid={err(path) ? true : undefined}
                      aria-describedby={err(path) ? `${id}-error` : undefined}
                      className={FIELD_CLASS}
                      rows={rowsFor(r.text, 2)}
                      value={r.text}
                      disabled={busy}
                      spellCheck
                      onChange={(e) => setRule(r.k, e.target.value)}
                    />
                    {err(path) ? (
                      <p id={`${id}-error`} className="text-xs text-[#ffb08a]">
                        {err(path)}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="rounded-row border border-line px-3 py-2 text-xs text-ink-dim hover:border-orange/60 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange/70 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={`Remove rule ${n + 1}`}
                    disabled={busy || rules.length <= 1}
                    onClick={() => removeRule(r.k)}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            className="rounded-row border border-dashed border-orange/45 px-4 py-3 text-sm text-ink hover:border-orange/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange/70 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={busy || rules.length >= RENEWAL_LIMITS.maxRules}
            onClick={addRule}
          >
            Add+ (a new rule)
          </button>
        </section>
      </GlassPanel>

      <div className="flex max-w-5xl flex-wrap items-center gap-3 pb-8">
        <button
          type="button"
          className="btn !flex-none"
          disabled={busy || !dirty}
          onClick={reset}
          data-testid="renew-reset"
        >
          RESET
        </button>
        <button
          type="button"
          className="btn btn-primary !flex-none"
          disabled={busy || !!stale}
          onClick={openApply}
          data-testid="renew-apply"
        >
          APPLY CHANGES
        </button>
        {dirty ? (
          <span className="text-xs text-ink-dim" data-testid="renew-dirty">
            You have unapplied edits.
          </span>
        ) : null}
      </div>

      <ModalDialog open={dialog === "apply"} onClose={closeApply} labelledBy={dialogTitleId}>
        <div className="dialog-body">
          <h2 id={dialogTitleId} className="dialog-title" tabIndex={-1} data-autofocus>
            {DIALOG_TITLE}
          </h2>
          <p className="dialog-text">{DIALOG_MESSAGE}</p>
          <p className="dialog-text text-ink-dim">{readinessLine(readiness, false)}</p>
          {checked === "yes" ? (
            <p
              className={`dialog-text ${readiness.pending_submissions > 0 ? "font-semibold text-ink" : "text-ink-dim"}`}
              role={readiness.pending_submissions > 0 ? "alert" : undefined}
              data-testid="renew-pending-warning"
              data-pending={readiness.pending_submissions}
            >
              {pendingWarning(readiness.pending_submissions)}
            </p>
          ) : checked === "failed" ? (
            <p className="dialog-text" role="alert" data-testid="renew-pending-check-failed">
              The current state could not be checked, so nothing can be applied right now. Go back
              and try again.
            </p>
          ) : (
            <p
              className="dialog-text text-ink-dim"
              role="status"
              data-testid="renew-pending-checking"
            >
              Checking how many submissions are awaiting approval…
            </p>
          )}
          {busy ? (
            <p className="dialog-text" role="status">
              Applying changes… Please keep this page open.
            </p>
          ) : null}
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || checked !== "yes" || !!stale}
            onClick={() => void confirm()}
          >
            {busy ? "Applying…" : "YES, APPLY CHANGES"}
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={closeApply}>
            GO BACK
          </button>
        </div>
      </ModalDialog>

      <ModalDialog open={dialog === "leave"} onClose={stayHere} labelledBy={leaveTitleId}>
        <div className="dialog-body">
          <h2 id={leaveTitleId} className="dialog-title" tabIndex={-1} data-autofocus>
            Leave without applying?
          </h2>
          <p className="dialog-text">
            You have edits that have not been applied. If you leave this page they are lost.
          </p>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={stayHere}>
            Stay on this page
          </button>
          <button type="button" className="btn btn-ghost" onClick={leaveNow}>
            Leave and discard
          </button>
        </div>
      </ModalDialog>
    </section>
  );
}

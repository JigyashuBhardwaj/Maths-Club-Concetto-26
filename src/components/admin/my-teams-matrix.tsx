"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { ThemeReviewDialog } from "@/components/admin/theme-review-dialog";
import { THEME_CODES, type MatrixResult, type MatrixTeam } from "@/lib/contracts/matrix";
import { fetchMatrix } from "@/lib/matrix/client";

/** How often the matrix re-reads the database while the tab is visible (±0.5 s). Realtime would only shorten this. */
export const MATRIX_POLL_MS = 3000;
const JITTER_MS = 500;
/** A full page load, so no stale page or router cache outlives the end of the session. */
const navigate = (url: string) => window.location.assign(url);

interface Props {
  /** The first paint, loaded on the server from the same database function (`null` if that read failed). */
  initial: MatrixResult | null;
  /** Replaced in tests. */
  fetchImpl?: typeof fetch;
  intervalMs?: number;
}

interface Selected {
  team: Pick<MatrixTeam, "id" | "team_code">;
  themeCode: string;
}

/**
 * "My Teams": the Admin's live control board. One row per team the Admin owns (the server decides which; this component
 * only draws what it is given). M1..M4 show member presence (IN / OUT), A..J the ten theme cells (red = something to
 * review, green = all five questions approved), then Final Submit. Clicking a theme cell opens its five questions and,
 * from there, the submission review with Approve / Disapprove.
 *
 * The database is the only source of truth: the board is replaced wholesale by each answer and holds no game state of
 * its own. It re-reads on a short poll, when the tab becomes visible or focused, when the network returns and right
 * after any review action (Realtime would only be another reason to re-read; the poll is the fallback the project ships).
 * An older answer can never replace a newer one.
 */
export function MyTeamsMatrix({ initial, fetchImpl, intervalMs = MATRIX_POLL_MS }: Props) {
  const [data, setData] = useState<MatrixResult | null>(initial);
  const [reconnecting, setReconnecting] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const latest = useRef<MatrixResult | null>(initial);
  const inflight = useRef<Promise<void> | null>(null);
  const alive = useRef(true);

  const refresh = useCallback((): Promise<void> => {
    if (inflight.current) return inflight.current;
    const run = (async () => {
      const r = await fetchMatrix(fetchImpl);
      if (!alive.current) return;
      if (r.ok) {
        if (!latest.current || r.data.server_now >= latest.current.server_now) {
          latest.current = r.data;
          setData(r.data);
        }
        setReconnecting(false);
        setLoadFailed(false);
        return;
      }
      if (r.status === 401) {
        navigate("/login/admin");
        return;
      }
      if (latest.current) setReconnecting(true);
      else setLoadFailed(true);
    })().finally(() => {
      inflight.current = null;
    });
    inflight.current = run;
    return run;
  }, [fetchImpl]);

  useEffect(() => {
    alive.current = true;
    const first = setTimeout(() => void refresh(), 0);
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          if (!document.hidden) void refresh();
          schedule();
        },
        intervalMs + (Math.random() * 2 - 1) * JITTER_MS,
      );
    };
    schedule();
    const wake = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => {
      alive.current = false;
      clearTimeout(first);
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [refresh, intervalMs]);

  const teams = data?.teams ?? [];

  return (
    <section aria-label="My teams" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-ink">My teams</h1>
        <Link href="/admin" className="btn btn-primary max-w-40">
          <span className="grid h-full place-items-center">Go back</span>
        </Link>
      </div>

      {reconnecting ? (
        <p role="status" className="text-sm text-ink-dim">
          Reconnecting… the board may be a few seconds behind.
        </p>
      ) : null}
      {loadFailed && !data ? (
        <p role="alert" className="text-sm text-ink">
          Could not load your teams. Retrying…
        </p>
      ) : null}

      {data && teams.length === 0 ? (
        <p className="text-sm text-ink-dim">
          You have not created a team yet. Use Create a team in the sidebar; it will appear here as
          a new row.
        </p>
      ) : null}

      {teams.length > 0 ? (
        <div className="mx-scroll" role="region" aria-label="My teams matrix" tabIndex={0}>
          <table className="mx-table" aria-label="Live team matrix">
            <thead>
              <tr>
                <th scope="col" className="mx-team">
                  Team ID
                </th>
                {[1, 2, 3, 4].map((n) => (
                  <th key={n} scope="col" className="whitespace-nowrap">
                    M{n}
                  </th>
                ))}
                {THEME_CODES.map((c) => (
                  <th key={c} scope="col" className="whitespace-nowrap">
                    {c}
                  </th>
                ))}
                <th scope="col" className="whitespace-nowrap">
                  Final submit
                </th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => (
                <tr key={team.id} data-team={team.team_code}>
                  <th scope="row" className="mx-team">
                    {team.team_code}
                    <span className="mx-name" title={team.name}>
                      {team.name}
                    </span>
                  </th>
                  {[1, 2, 3, 4].map((slot) => {
                    const member = team.members.find((m) => m.slot === slot);
                    const online = member?.presence === "ONLINE";
                    return (
                      <td key={slot}>
                        {member ? (
                          <span
                            className={`mx-presence ${online ? "mx-in" : "mx-out"}`}
                            aria-label={`${team.team_code} M${slot}: ${online ? "in" : "out"}`}
                            data-testid={`presence-${team.team_code}-M${slot}`}
                          >
                            {online ? "IN" : "OUT"}
                          </span>
                        ) : (
                          <span className="mx-static">—</span>
                        )}
                      </td>
                    );
                  })}
                  {team.themes.map((theme) => {
                    const label =
                      theme.state === "RED"
                        ? `${team.team_code} theme ${theme.code}: ${theme.pending} submission${theme.pending === 1 ? "" : "s"} waiting for review`
                        : theme.state === "GREEN"
                          ? `${team.team_code} theme ${theme.code}: completed`
                          : `${team.team_code} theme ${theme.code}: ${theme.approved} of 5 approved`;
                    return (
                      <td key={theme.code}>
                        <button
                          type="button"
                          className={`mx-cell ${
                            theme.state === "RED"
                              ? "mx-red"
                              : theme.state === "GREEN"
                                ? "mx-green"
                                : ""
                          }`}
                          aria-label={label}
                          title={label}
                          data-state={theme.state}
                          data-testid={`cell-${team.team_code}-${theme.code}`}
                          onClick={() =>
                            setSelected({
                              team: { id: team.id, team_code: team.team_code },
                              themeCode: theme.code,
                            })
                          }
                        >
                          {theme.state === "RED"
                            ? "REVIEW"
                            : theme.state === "GREEN"
                              ? "✓"
                              : theme.approved > 0
                                ? `${theme.approved}/5`
                                : ""}
                        </button>
                      </td>
                    );
                  })}
                  <td>
                    <span
                      className={`mx-static ${team.final_submitted ? "mx-green" : ""}`}
                      aria-label={`${team.team_code} final submit: ${team.final_submitted ? "submitted" : "not yet"}`}
                      data-testid={`final-${team.team_code}`}
                    >
                      {team.final_submitted ? "✓ Submitted" : "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="text-xs text-ink-dim">
        IN / OUT is each member&apos;s live connection (OUT after{" "}
        {data?.presence_timeout_seconds ?? 75} s without a sign of life). Red: a submission is
        waiting for you. Green: all five questions of the theme are approved.
      </p>

      {selected ? (
        <ThemeReviewDialog
          key={`${selected.team.id}:${selected.themeCode}`}
          team={selected.team}
          themeCode={selected.themeCode}
          fetchImpl={fetchImpl}
          intervalMs={intervalMs}
          onClose={() => setSelected(null)}
          onChanged={() => void refresh()}
        />
      ) : null}
    </section>
  );
}

/**
 * Browser-side calls of the Admin "My Teams" matrix (Patch B14). Reads (`GET /api/admin/matrix`, the theme drill-down)
 * and the two review actions, which are the EXISTING B13 endpoints (`POST /api/admin/submissions/:id/approve|disapprove`).
 * Nothing is persisted in the browser and nothing here is authority: the Admin comes from the session cookie, the ids in
 * a path are only selectors the database re-checks against ownership.
 */
import { call, checked, type CallResult } from "@/lib/gameplay/client";
import {
  matrixResultSchema,
  teamThemeResultSchema,
  type MatrixResult,
  type TeamThemeResult,
} from "@/lib/contracts/matrix";

export type { CallResult };
export type Verdict = "approve" | "disapprove";

export async function fetchMatrix(fetchImpl?: typeof fetch): Promise<CallResult<MatrixResult>> {
  return checked(await call("GET", "/api/admin/matrix", { fetchImpl }), (d) => {
    const p = matrixResultSchema.safeParse(d);
    return p.success ? p.data : null;
  });
}

export async function fetchTeamTheme(
  teamId: string,
  themeCode: string,
  fetchImpl?: typeof fetch,
): Promise<CallResult<TeamThemeResult>> {
  return checked(
    await call("GET", `/api/admin/teams/${encodeURIComponent(teamId)}/themes/${themeCode}`, {
      fetchImpl,
    }),
    (d) => {
      const p = teamThemeResultSchema.safeParse(d);
      return p.success ? p.data : null;
    },
  );
}

/** Approve or disapprove through the existing, authenticated, idempotent B13 endpoints. */
export async function reviewSubmission(
  submissionId: string,
  verdict: Verdict,
  opts: { key: string; note?: string; fetchImpl?: typeof fetch },
): Promise<CallResult<unknown>> {
  const note = opts.note?.trim();
  return call("POST", `/api/admin/submissions/${submissionId}/${verdict}`, {
    key: opts.key,
    body: verdict === "disapprove" && note ? { note } : {},
    fetchImpl: opts.fetchImpl,
  });
}

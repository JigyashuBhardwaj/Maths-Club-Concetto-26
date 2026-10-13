/**
 * Browser-side calls of the Super Admin deletion API (Patch B18). Same rules as the other clients: the session is the
 * HttpOnly cookie, nothing is persisted in the browser, every list and count on screen comes back from the server, and
 * every function returns a result instead of throwing. The caller owns the `Idempotency-Key`: one per user intent,
 * reused on a retry whose outcome is unknown, so a request that did succeed is replayed instead of repeated.
 */
import {
  deletableAdminsResultSchema,
  deletableTeamsResultSchema,
  deleteAdminsResultSchema,
  deleteTeamsResultSchema,
  type DeletableAdmin,
  type DeletableTeam,
  type DeleteAdminsResult,
  type DeleteTeamsResult,
} from "@/lib/contracts/deletion";
import { call, checked, type CallResult } from "@/lib/gameplay/client";

export type DeletionKind = "admins" | "teams";

export async function fetchDeletableAdmins(
  fetchImpl?: typeof fetch,
): Promise<CallResult<DeletableAdmin[]>> {
  return checked(await call("GET", "/api/super/admins", { fetchImpl }), (d) => {
    const p = deletableAdminsResultSchema.safeParse(d);
    return p.success ? p.data.admins : null;
  });
}

export async function fetchDeletableTeams(
  fetchImpl?: typeof fetch,
): Promise<CallResult<DeletableTeam[]>> {
  return checked(await call("GET", "/api/super/teams", { fetchImpl }), (d) => {
    const p = deletableTeamsResultSchema.safeParse(d);
    return p.success ? p.data.teams : null;
  });
}

export async function deleteAdminsCall(
  adminIds: readonly string[],
  opts: { key: string; fetchImpl?: typeof fetch },
): Promise<CallResult<Omit<DeleteAdminsResult, "replayed">>> {
  const r = await call("POST", "/api/super/admins/delete", {
    body: { adminIds },
    key: opts.key,
    fetchImpl: opts.fetchImpl,
  });
  return checked(r, (d) => {
    const p = deleteAdminsResultSchema.omit({ replayed: true }).safeParse(d);
    return p.success ? p.data : null;
  });
}

export async function deleteTeamsCall(
  teamIds: readonly string[],
  opts: { key: string; fetchImpl?: typeof fetch },
): Promise<CallResult<Omit<DeleteTeamsResult, "replayed">>> {
  const r = await call("POST", "/api/super/teams/delete", {
    body: { teamIds },
    key: opts.key,
    fetchImpl: opts.fetchImpl,
  });
  return checked(r, (d) => {
    const p = deleteTeamsResultSchema.omit({ replayed: true }).safeParse(d);
    return p.success ? p.data : null;
  });
}

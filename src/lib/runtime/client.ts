/**
 * Browser-side call of the Super Admin's competition lifecycle API (`POST /api/super/competition/status`, Patch B10). The session is
 * the HttpOnly cookie; the body is exactly what the strict request schema accepts (`{ action, confirm: true }`); nothing is
 * persisted in the browser. Returns a result instead of throwing. The caller owns the `Idempotency-Key`: one per user intent, reused
 * only when the outcome of a request is unknown, so a request that did succeed is replayed instead of repeated.
 */
import {
  statusResultSchema,
  type CompetitionAction,
  type StatusResult,
} from "@/lib/contracts/runtime";
import { call, checked, type CallResult } from "@/lib/gameplay/client";

export async function setCompetitionStatusCall(
  action: CompetitionAction,
  opts: { key: string; fetchImpl?: typeof fetch },
): Promise<CallResult<Omit<StatusResult, "replayed">>> {
  const r = await call("POST", "/api/super/competition/status", {
    body: { action, confirm: true },
    key: opts.key,
    fetchImpl: opts.fetchImpl,
  });
  return checked(r, (d) => {
    const p = statusResultSchema.omit({ replayed: true }).safeParse(d);
    return p.success ? p.data : null;
  });
}

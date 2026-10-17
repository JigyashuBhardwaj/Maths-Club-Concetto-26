/**
 * Browser-side calls of the Super Admin's renewal API (migration 21). Same rules as the other clients: the session is the HttpOnly
 * cookie, nothing is persisted in the browser, everything on screen that is not being typed comes back from the server, and
 * every function returns a result instead of throwing. The caller owns the `Idempotency-Key`: one per user intent, reused only
 * when the outcome of a request is unknown, so a request that did succeed is replayed instead of repeated.
 */
import {
  renewResultSchema,
  renewalReadSchema,
  type RenewRequest,
  type RenewResult,
  type RenewalRead,
} from "@/lib/contracts/renewal";
import { call, checked, type CallResult } from "@/lib/gameplay/client";

export async function fetchRenewal(fetchImpl?: typeof fetch): Promise<CallResult<RenewalRead>> {
  return checked(await call("GET", "/api/super/renew", { fetchImpl }), (d) => {
    const p = renewalReadSchema.safeParse(d);
    return p.success ? p.data : null;
  });
}

export async function renewCall(
  body: RenewRequest,
  opts: { key: string; fetchImpl?: typeof fetch },
): Promise<CallResult<Omit<RenewResult, "replayed">>> {
  const r = await call("POST", "/api/super/renew", {
    body,
    key: opts.key,
    fetchImpl: opts.fetchImpl,
  });
  return checked(r, (d) => {
    const p = renewResultSchema.omit({ replayed: true }).safeParse(d);
    return p.success ? p.data : null;
  });
}

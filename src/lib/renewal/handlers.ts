import { respond, success } from "@/lib/api/envelope";
import { ApiError, dbRaisedToApiError } from "@/lib/api/errors";
import { readJson, type AuthDeps } from "@/lib/auth/handlers";
import { buildClearedSessionCookie } from "@/lib/auth/cookies";
import { assertSameOrigin } from "@/lib/auth/origin";
import { resolvePrincipal, type Principal } from "@/lib/auth/principal";
import {
  MAX_RENEWAL_BODY_BYTES,
  renewRequestSchema,
  renewResultSchema,
  renewalReadDbSchema,
  renewalReadinessSchema,
  type RenewalRead,
} from "@/lib/contracts/renewal";
import { OFFICIAL_RULES } from "@/lib/content/official-public";
import { DbError, type Db } from "@/lib/db/adapter";
import { logDeleteBlocked } from "@/lib/deletion/handlers";
import { callDb, parseResult, readIdempotencyKey } from "@/lib/runtime/handlers";

/**
 * Handlers of "Renew the Competition" (migration 21). Same dependency bundle and the same order of checks as the deletion
 * handlers: Origin (POST) → session cookie → principal → role (SUPER_ADMIN only, for the read as well) → `Idempotency-Key`
 * (POST) → strict body → ONE database call → result validated against a whitelist → envelope.
 *
 * The staff id passed to the database is ALWAYS the one in the verified session. The body carries the content and the token of
 * the content the editor loaded, and nothing else: no staff id, role, admin id, team id or count can be supplied. The database
 * re-checks that the caller is an active SUPER_ADMIN, validates the content again, compares the token with the live content,
 * checks the preconditions on live rows, and does the deletion, publication and lifecycle reset in one transaction.
 */
export type RenewalDeps = AuthDeps;

function requireSuperAdmin(p: Principal): Extract<Principal, { role: "ADMIN" | "SUPER_ADMIN" }> {
  if (p.role !== "SUPER_ADMIN") throw new ApiError("FORBIDDEN", "You are not allowed to do that.");
  return p;
}

/** The database's answer as the editor needs it: the rules the participants see today when none were ever written. */
export function resolveRenewalRead(raw: unknown): RenewalRead {
  const db = parseResult(renewalReadDbSchema, raw);
  return {
    content: { themes: db.content.themes, rules: db.content.rules ?? [...OFFICIAL_RULES] },
    token: db.token,
    readiness: db.readiness,
  };
}

/** GET /api/super/renew — the current content, its concurrency token and whether a renewal could start now. */
export function createGetRenewalHandler(deps: RenewalDeps) {
  return (request: Request): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        const db = deps.db();
        const principal = requireSuperAdmin(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const raw = await callDb(db, "get_renewal_content", { p_staff_id: principal.staff.id });
        return success(resolveRenewalRead(raw), deps.now());
      },
      buildClearedSessionCookie,
    );
}

/**
 * `RENEWAL_BLOCKED` carries WHY (which teams, in which state) so the Super Admin knows what to wait for. The database's
 * report is passed through the whitelist schema; anything that does not fit it is dropped, and the browser gets the plain code.
 */
function blockedError(err: DbError): ApiError {
  const base = dbRaisedToApiError(err.appCode, undefined);
  const parsed = renewalReadinessSchema.safeParse(err.details);
  if (!parsed.success) return base;
  const r = parsed.data;
  return new ApiError("RENEWAL_BLOCKED", base.message, {
    details: {
      blocked_count: r.blocked_count,
      teams: r.teams,
      admins: r.admins,
      pending_submissions: r.pending_submissions,
      blockers: r.blockers.slice(0, 50),
    },
  });
}

/** Server-side diagnostics only (identifiers, never a value): the browser gets the fixed message of the API error. */
function logRenewalFault(err: DbError): void {
  if (err.appCode === "DELETE_BLOCKED") return logDeleteBlocked(err);
  if (err.appCode === "RENEWAL_INCOMPLETE" || err.appCode === "RENEWAL_CONTENT_MISMATCH") {
    console.error("renewal: rolled back by an internal invariant", { code: err.appCode });
  }
}

async function callRenew(db: Db, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await db.rpc("renew_competition", args);
  } catch (err) {
    if (err instanceof DbError) {
      if (err.appCode === "RENEWAL_BLOCKED") throw blockedError(err);
      logRenewalFault(err);
      throw dbRaisedToApiError(err.appCode, err.details);
    }
    throw err;
  }
}

/** POST /api/super/renew — `{ content, expectedToken }`. Atomically: publish, delete the previous admins and teams, reset. */
export function createRenewHandler(deps: RenewalDeps) {
  return (request: Request): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        assertSameOrigin(request, env.APP_ORIGIN);
        const db = deps.db();
        const principal = requireSuperAdmin(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const key = readIdempotencyKey(request);
        const input = await readJson(request, renewRequestSchema, MAX_RENEWAL_BODY_BYTES);
        const result = parseResult(
          renewResultSchema,
          await callRenew(db, {
            p_staff_id: principal.staff.id,
            p_content: input.content,
            p_expected_token: input.expectedToken,
            p_idem_key: key,
          }),
        );
        const { replayed, ...data } = result;
        return success(data, deps.now(), {
          headers: replayed ? { "Idempotent-Replay": "true" } : undefined,
        });
      },
      buildClearedSessionCookie,
    );
}

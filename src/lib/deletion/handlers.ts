import { respond, success } from "@/lib/api/envelope";
import { ApiError } from "@/lib/api/errors";
import { readJson, type AuthDeps } from "@/lib/auth/handlers";
import { buildClearedSessionCookie } from "@/lib/auth/cookies";
import { assertSameOrigin } from "@/lib/auth/origin";
import { resolvePrincipal, type Principal } from "@/lib/auth/principal";
import {
  deletableAdminsResultSchema,
  deletableTeamsResultSchema,
  deleteAdminsResultSchema,
  deleteAdminsSchema,
  deleteTeamsResultSchema,
  deleteTeamsSchema,
} from "@/lib/contracts/deletion";
import { DbError, type Db } from "@/lib/db/adapter";
import { callDb, parseResult, readIdempotencyKey } from "@/lib/runtime/handlers";

/**
 * Handlers of the Super Admin's permanent deletion of Admins and Teams (Patch B18). Same dependency bundle and the same
 * order of checks as the provisioning handlers: Origin (non-GET) → session cookie → principal → role (SUPER_ADMIN only)
 * → `Idempotency-Key` (state-changing calls) → strict body → ONE database call → result validated against a whitelist
 * → envelope.
 *
 * The staff id passed to the database is ALWAYS the one in the verified session. The body carries ids of the records to
 * delete and nothing else: no staff id, role, owner or count can be supplied, and the database re-checks that the caller
 * is an active SUPER_ADMIN, that every id exists and that none is protected, all inside the one transaction.
 */
export type DeletionDeps = AuthDeps;

/** A selection is at most 100 UUIDs (~4 KB of JSON); the 2 KB default of the login bodies is too small for it. */
const MAX_SELECTION_BODY_BYTES = 8 * 1024;

function requireSuperAdmin(p: Principal): Extract<Principal, { role: "ADMIN" | "SUPER_ADMIN" }> {
  if (p.role !== "SUPER_ADMIN") throw new ApiError("FORBIDDEN", "You are not allowed to do that.");
  return p;
}

/** A PostgreSQL identifier as the schema defines them here (lower-case, digits, underscore). Anything else is not logged. */
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Server-side diagnostics for `DELETE_BLOCKED`. The database names the foreign key that stopped a deletion (constraint
 * and referencing table, see migration 20) so an operator can find out WHAT blocked it; the browser only ever gets the
 * fixed 409 message (`DELETE_BLOCKED` is not on the list of codes that may carry details, `safeDetails`).
 *
 * Only two schema identifiers are logged, and only when they look like identifiers: never an id, a key value, a request
 * body, a username, a credential or a token, and never the raw database message.
 */
export function logDeleteBlocked(err: DbError): void {
  const identifier = (v: unknown): string | undefined =>
    typeof v === "string" && IDENTIFIER.test(v) ? v : undefined;
  console.error("deletion: blocked by a foreign key", {
    fn: err.fn,
    constraint: identifier(err.details?.constraint),
    table: identifier(err.details?.table),
  });
}

/** The same adapter, except that a `DELETE_BLOCKED` is logged (server side) on its way up. */
function withBlockedLog(db: Db): Db {
  return {
    async rpc(fn, args) {
      try {
        return await db.rpc(fn, args);
      } catch (err) {
        if (err instanceof DbError && err.appCode === "DELETE_BLOCKED") logDeleteBlocked(err);
        throw err;
      }
    },
  };
}

const replayHeaders = (replayed: boolean): HeadersInit | undefined =>
  replayed ? { "Idempotent-Replay": "true" } : undefined;

/** GET /api/super/admins — every Admin (never the Super Admin) with the number of teams that would go with it. */
export function createListDeletableAdminsHandler(deps: DeletionDeps) {
  return (request: Request): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        const db = deps.db();
        const principal = requireSuperAdmin(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const data = parseResult(
          deletableAdminsResultSchema,
          await callDb(db, "list_deletable_admins", { p_staff_id: principal.staff.id }),
        );
        return success(data, deps.now());
      },
      buildClearedSessionCookie,
    );
}

/** GET /api/super/teams — every team of every Admin. */
export function createListDeletableTeamsHandler(deps: DeletionDeps) {
  return (request: Request): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        const db = deps.db();
        const principal = requireSuperAdmin(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const data = parseResult(
          deletableTeamsResultSchema,
          await callDb(db, "list_deletable_teams", { p_staff_id: principal.staff.id }),
        );
        return success(data, deps.now());
      },
      buildClearedSessionCookie,
    );
}

/** POST /api/super/admins/delete — `{ adminIds: [...] }`. Deletes the admins, their teams and everything those own. */
export function createDeleteAdminsHandler(deps: DeletionDeps) {
  return (request: Request): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        assertSameOrigin(request, env.APP_ORIGIN);
        const db = withBlockedLog(deps.db());
        const principal = requireSuperAdmin(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const key = readIdempotencyKey(request);
        const input = await readJson(request, deleteAdminsSchema, MAX_SELECTION_BODY_BYTES);
        const result = parseResult(
          deleteAdminsResultSchema,
          await callDb(db, "delete_admins", {
            p_staff_id: principal.staff.id,
            p_admin_ids: input.adminIds,
            p_idem_key: key,
          }),
        );
        const { replayed, ...data } = result;
        return success(data, deps.now(), { headers: replayHeaders(replayed) });
      },
      buildClearedSessionCookie,
    );
}

/** POST /api/super/teams/delete — `{ teamIds: [...] }`. Deletes the teams and everything they own. */
export function createDeleteTeamsHandler(deps: DeletionDeps) {
  return (request: Request): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        assertSameOrigin(request, env.APP_ORIGIN);
        const db = withBlockedLog(deps.db());
        const principal = requireSuperAdmin(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const key = readIdempotencyKey(request);
        const input = await readJson(request, deleteTeamsSchema, MAX_SELECTION_BODY_BYTES);
        const result = parseResult(
          deleteTeamsResultSchema,
          await callDb(db, "delete_teams", {
            p_staff_id: principal.staff.id,
            p_team_ids: input.teamIds,
            p_idem_key: key,
          }),
        );
        const { replayed, ...data } = result;
        return success(data, deps.now(), { headers: replayHeaders(replayed) });
      },
      buildClearedSessionCookie,
    );
}

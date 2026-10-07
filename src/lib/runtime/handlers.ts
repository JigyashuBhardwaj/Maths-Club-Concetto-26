import type { z } from "zod";

import { respond, success } from "@/lib/api/envelope";
import { ApiError, dbRaisedToApiError } from "@/lib/api/errors";
import {
  idempotencyKeySchema,
  setCompetitionStatusSchema,
  startResultSchema,
  statusResultSchema,
  teamStateSchema,
} from "@/lib/contracts/runtime";
import { DbError, type Db, type DbFunction } from "@/lib/db/adapter";
import { readJson, type AuthDeps } from "@/lib/auth/handlers";
import { assertSameOrigin } from "@/lib/auth/origin";
import { resolvePrincipal, type Principal } from "@/lib/auth/principal";
import { buildClearedSessionCookie } from "@/lib/auth/cookies";

/**
 * Handlers of the competition runtime (docs/API_SPEC.md §4, §6; Patch B10). Same dependency bundle as the auth layer.
 *
 * Every handler: Origin check (non-GET) → session cookie → principal → role check → `Idempotency-Key` (state-changing
 * calls) → one database call → the result validated against a whitelist schema → envelope. The team, member and staff
 * ids sent to the database always come from the session, never from the body, path, query or headers (SEC-03); the
 * database re-checks them. No time, balance or remaining-seconds value is ever read from a request.
 */
export type RuntimeDeps = AuthDeps;

const FAULT = () => new ApiError("SERVICE_UNAVAILABLE", "Temporarily unavailable. Please retry.");

/** One database call; an error the engine raised on purpose becomes its API error, anything else a generic 503. */
async function callDb(db: Db, fn: DbFunction, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await db.rpc(fn, args);
  } catch (err) {
    if (err instanceof DbError) throw dbRaisedToApiError(err.appCode, err.details);
    throw err;
  }
}

/** A malformed database result is an infrastructure fault, never something to forward. */
function parseResult<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw FAULT();
  return parsed.data;
}

function requireParticipant(p: Principal): Extract<Principal, { role: "PARTICIPANT" }> {
  if (p.role !== "PARTICIPANT") throw new ApiError("FORBIDDEN", "Participants only.");
  return p;
}

function requireSuperAdmin(p: Principal): Extract<Principal, { role: "ADMIN" | "SUPER_ADMIN" }> {
  if (p.role !== "SUPER_ADMIN") throw new ApiError("FORBIDDEN", "Super Admin only.");
  return p;
}

/** The mandatory `Idempotency-Key` of every state-changing request (API_SPEC §1): missing or malformed → 400. */
export function readIdempotencyKey(request: Request): string {
  const parsed = idempotencyKeySchema.safeParse(
    request.headers.get("idempotency-key")?.trim() ?? "",
  );
  if (!parsed.success) {
    throw new ApiError("VALIDATION_FAILED", "A valid Idempotency-Key header is required.", {
      details: { fields: ["Idempotency-Key"] },
    });
  }
  return parsed.data.toLowerCase();
}

/** Endpoints without a body accept none (or an empty object): there is nothing a client may add. */
async function requireEmptyBody(request: Request): Promise<void> {
  const text = (await request.text()).trim();
  if (text.length > 64 || (text !== "" && text !== "{}")) {
    throw new ApiError("VALIDATION_FAILED", "This request takes no body.");
  }
}

const replayHeaders = (replayed: boolean): HeadersInit | undefined =>
  replayed ? { "Idempotent-Replay": "true" } : undefined;

/** POST /api/p/start — "Enter competition". Idempotent; never called by login. */
export function createStartTeamHandler(deps: RuntimeDeps) {
  return (request: Request): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        assertSameOrigin(request, env.APP_ORIGIN);
        const db = deps.db();
        const principal = requireParticipant(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const key = readIdempotencyKey(request);
        await requireEmptyBody(request);
        const result = parseResult(
          startResultSchema,
          await callDb(db, "start_team_competition", {
            p_team_id: principal.team.id,
            p_member_id: principal.member.id,
            p_idem_key: key,
          }),
        );
        return success(
          { started_now: result.started_now, ...result.state },
          result.state.server_now,
          {
            stateVersion: result.state.state_version,
            headers: replayHeaders(result.replayed),
          },
        );
      },
      buildClearedSessionCookie,
    );
}

/** GET /api/p/state — the authoritative snapshot of the caller's own team. */
export function createTeamStateHandler(deps: RuntimeDeps) {
  return (request: Request): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        const db = deps.db();
        const principal = requireParticipant(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const state = parseResult(
          teamStateSchema,
          await callDb(db, "get_team_state", {
            p_team_id: principal.team.id,
            p_member_id: principal.member.id,
          }),
        );
        return success(state, state.server_now, { stateVersion: state.state_version });
      },
      buildClearedSessionCookie,
    );
}

/** POST /api/super/competition/status — Super Admin only; `{ action, confirm: true }`. */
export function createCompetitionStatusHandler(deps: RuntimeDeps) {
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
        const input = await readJson(request, setCompetitionStatusSchema);
        const { replayed, ...data } = parseResult(
          statusResultSchema,
          await callDb(db, "set_competition_status", {
            p_staff_id: principal.staff.id,
            p_action: input.action,
            p_idem_key: key,
          }),
        );
        return success(data, deps.now(), {
          stateVersion: data.competition.state_version,
          headers: replayHeaders(replayed),
        });
      },
      buildClearedSessionCookie,
    );
}

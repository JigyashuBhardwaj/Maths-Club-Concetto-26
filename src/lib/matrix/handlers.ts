import { respond, success } from "@/lib/api/envelope";
import { ApiError } from "@/lib/api/errors";
import { buildClearedSessionCookie } from "@/lib/auth/cookies";
import type { AuthDeps } from "@/lib/auth/handlers";
import { assertSameOrigin } from "@/lib/auth/origin";
import { resolvePrincipal, type Principal } from "@/lib/auth/principal";
import {
  matrixResultSchema,
  teamIdParamSchema,
  teamThemeResultSchema,
  themeCodeParamSchema,
} from "@/lib/contracts/matrix";
import { callDb, parseResult, requireEmptyBody } from "@/lib/runtime/handlers";

/**
 * Handlers of the Admin "My Teams" live matrix and of the participant heartbeat (Patch B14). Same dependency bundle and
 * order of checks as every other handler: Origin (POST) → session cookie → principal → role → path selector → ONE
 * database call → result validated against a whitelist schema → envelope.
 *
 * The staff id sent to the database ALWAYS comes from the session. The team id and theme code in the path are selectors
 * only: the database re-checks that the team belongs to this Admin (anything else is a 404, exactly like an unknown id),
 * so a forged or guessed id reveals nothing. These are pure reads; every mutation (approve / disapprove) still goes
 * through the B13 endpoints.
 */
export type MatrixDeps = AuthDeps;

type RouteContext<P extends string> = { params: Promise<Record<P, string>> };

function requireAdmin(p: Principal): Extract<Principal, { role: "ADMIN" | "SUPER_ADMIN" }> {
  if (p.role !== "ADMIN") throw new ApiError("FORBIDDEN", "Admins only.");
  return p;
}

function requireParticipant(p: Principal): Extract<Principal, { role: "PARTICIPANT" }> {
  if (p.role !== "PARTICIPANT") throw new ApiError("FORBIDDEN", "Participants only.");
  return p;
}

/** GET /api/admin/matrix — the live matrix of the teams this Admin owns. */
export function createMatrixHandler(deps: MatrixDeps) {
  return (request: Request): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        const db = deps.db();
        const principal = requireAdmin(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const data = parseResult(
          matrixResultSchema,
          await callDb(db, "admin_matrix", { p_staff_id: principal.staff.id }),
        );
        return success(data, data.server_now);
      },
      buildClearedSessionCookie,
    );
}

/** GET /api/admin/teams/:teamId/themes/:themeCode — the five-question drill-down of one theme cell. */
export function createTeamThemeHandler(deps: MatrixDeps) {
  return (request: Request, ctx: RouteContext<"teamId" | "themeCode">): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        const db = deps.db();
        const principal = requireAdmin(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const params = await ctx.params;
        const teamId = teamIdParamSchema.safeParse(params.teamId);
        const themeCode = themeCodeParamSchema.safeParse(params.themeCode);
        if (!teamId.success || !themeCode.success) throw new ApiError("NOT_FOUND", "Not found.");
        const data = parseResult(
          teamThemeResultSchema,
          await callDb(db, "admin_team_theme", {
            p_staff_id: principal.staff.id,
            p_team_id: teamId.data,
            p_theme_code: themeCode.data,
          }),
        );
        return success(data, data.server_now);
      },
      buildClearedSessionCookie,
    );
}

/**
 * POST /api/p/heartbeat — "this member's browser is still here". Authenticating the request is the whole job:
 * `resolve_session` stamps `sessions.last_seen_at`, which is what the Admin matrix reads as presence. It takes no body,
 * writes nothing else and never touches game state, the team timer or `state_version`.
 */
export function createHeartbeatHandler(deps: MatrixDeps) {
  return (request: Request): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        assertSameOrigin(request, env.APP_ORIGIN);
        const db = deps.db();
        requireParticipant(await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER));
        await requireEmptyBody(request);
        return success({ server_now: deps.now() }, deps.now());
      },
      buildClearedSessionCookie,
    );
}

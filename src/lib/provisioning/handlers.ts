import { respond, success } from "@/lib/api/envelope";
import { ApiError } from "@/lib/api/errors";
import { readJson, type AuthDeps } from "@/lib/auth/handlers";
import { assertSameOrigin } from "@/lib/auth/origin";
import { buildClearedSessionCookie } from "@/lib/auth/cookies";
import { resolvePrincipal, type Principal } from "@/lib/auth/principal";
import {
  adminTeamsResultSchema,
  createAdminResultSchema,
  createAdminSchema,
  createTeamResultSchema,
  createTeamSchema,
  leaderboardResultSchema,
} from "@/lib/contracts/provisioning";
import { callDb, parseResult, readIdempotencyKey } from "@/lib/runtime/handlers";

/**
 * Handlers of provisioning (docs/API_SPEC.md §5–§6; Patch B12). Same dependency bundle and the same order of checks as
 * the B10 handlers: Origin (non-GET) → session cookie → principal → role → `Idempotency-Key` (state-changing calls) →
 * strict body → ONE database call → result validated against a whitelist schema → envelope.
 *
 * The staff id passed to the database is ALWAYS the one in the session. No body field, path segment, query string or
 * header can name an owner, so an Admin cannot create a team for someone else or read another Admin's teams; the
 * database re-checks the role and the ownership (SECURITY.md §4).
 */
export type ProvisioningDeps = AuthDeps;

type StaffPrincipal = Extract<Principal, { role: "ADMIN" | "SUPER_ADMIN" }>;

function requireRole(p: Principal, ...roles: StaffPrincipal["role"][]): StaffPrincipal {
  if (p.role === "PARTICIPANT" || !roles.includes(p.role)) {
    throw new ApiError("FORBIDDEN", "You are not allowed to do that.");
  }
  return p;
}

const replayHeaders = (replayed: boolean): HeadersInit | undefined =>
  replayed ? { "Idempotent-Replay": "true" } : undefined;

/** POST /api/super/admins — Super Admin only; `{ username, password, confirmPassword }`. */
export function createCreateAdminHandler(deps: ProvisioningDeps) {
  return (request: Request): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        assertSameOrigin(request, env.APP_ORIGIN);
        const db = deps.db();
        const principal = requireRole(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
          "SUPER_ADMIN",
        );
        const key = readIdempotencyKey(request);
        const input = await readJson(request, createAdminSchema);
        const { replayed, admin } = parseResult(
          createAdminResultSchema,
          await callDb(db, "create_admin", {
            p_staff_id: principal.staff.id,
            p_username: input.username,
            p_password: input.password,
            p_idem_key: key,
          }),
        );
        return success({ admin }, deps.now(), { headers: replayHeaders(replayed) });
      },
      buildClearedSessionCookie,
    );
}

/** POST /api/admin/teams — ADMIN only. The new team belongs to the caller; nothing in the body can change that. */
export function createCreateTeamHandler(deps: ProvisioningDeps) {
  return (request: Request): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        assertSameOrigin(request, env.APP_ORIGIN);
        const db = deps.db();
        const principal = requireRole(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
          "ADMIN",
        );
        const key = readIdempotencyKey(request);
        const input = await readJson(request, createTeamSchema);
        const { replayed, team } = parseResult(
          createTeamResultSchema,
          await callDb(db, "create_team", {
            p_staff_id: principal.staff.id,
            p_team_code: input.teamCode,
            p_name: input.name,
            p_login_id: input.loginId,
            p_password: input.password,
            p_admission_nos: input.admissionNos,
            p_idem_key: key,
          }),
        );
        return success({ team }, deps.now(), { headers: replayHeaders(replayed) });
      },
      buildClearedSessionCookie,
    );
}

/** GET /api/admin/teams — "My Teams": only the caller's own teams. */
export function createListTeamsHandler(deps: ProvisioningDeps) {
  return (request: Request): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        const db = deps.db();
        const principal = requireRole(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
          "ADMIN",
        );
        const data = parseResult(
          adminTeamsResultSchema,
          await callDb(db, "list_admin_teams", { p_staff_id: principal.staff.id }),
        );
        return success(data, deps.now());
      },
      buildClearedSessionCookie,
    );
}

/** GET /api/leaderboard — Admin and Super Admin: every team's rank, team code and score. */
export function createLeaderboardHandler(deps: ProvisioningDeps) {
  return (request: Request): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        const db = deps.db();
        const principal = requireRole(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
          "ADMIN",
          "SUPER_ADMIN",
        );
        const data = parseResult(
          leaderboardResultSchema,
          await callDb(db, "get_leaderboard", { p_staff_id: principal.staff.id }),
        );
        return success(data, deps.now());
      },
      buildClearedSessionCookie,
    );
}

import { respond, success } from "@/lib/api/envelope";
import { ApiError } from "@/lib/api/errors";
import { buildClearedSessionCookie } from "@/lib/auth/cookies";
import type { AuthDeps } from "@/lib/auth/handlers";
import { readJson } from "@/lib/auth/handlers";
import { assertSameOrigin } from "@/lib/auth/origin";
import { resolvePrincipal, type Principal } from "@/lib/auth/principal";
import { teamIdParamSchema } from "@/lib/contracts/matrix";
import {
  participantBoardSchema,
  penalizeResultSchema,
  penalizeSchema,
} from "@/lib/contracts/scoring";
import { callDb, parseResult, readIdempotencyKey } from "@/lib/runtime/handlers";

/**
 * Handlers of the participant leaderboard and of the UFM penalty (Phase B16). Same dependency bundle and order of checks
 * as every other handler: Origin (POST) → session cookie → principal → role → path selector → `Idempotency-Key` (POST) →
 * strict body → ONE database call → whitelist schema → envelope.
 *
 * No scoring rule lives here. The score, the rank and "me" are computed by the database in one statement (one snapshot);
 * the team and staff ids always come from the session; the team id in the penalty path is only a selector that the database
 * re-checks against ownership (another admin's team is a 404, exactly like an unknown id).
 */
export type ScoringDeps = AuthDeps;

type RouteContext<P extends string> = { params: Promise<Record<P, string>> };

function requireParticipant(p: Principal): Extract<Principal, { role: "PARTICIPANT" }> {
  if (p.role !== "PARTICIPANT") throw new ApiError("FORBIDDEN", "Participants only.");
  return p;
}

/** Only an Admin may penalise; a Super Admin and a participant are refused before any database work. */
function requireAdmin(p: Principal): Extract<Principal, { role: "ADMIN" | "SUPER_ADMIN" }> {
  if (p.role !== "ADMIN") throw new ApiError("FORBIDDEN", "Admins only.");
  return p;
}

/** GET /api/p/leaderboard — every team's rank / Team ID / score plus the signed-in team's own line. View only. */
export function createParticipantLeaderboardHandler(deps: ScoringDeps) {
  return (request: Request): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        const db = deps.db();
        const principal = requireParticipant(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const data = parseResult(
          participantBoardSchema,
          await callDb(db, "get_team_leaderboard", {
            p_team_id: principal.team.id,
            p_member_id: principal.member.id,
          }),
        );
        return success(data, data.server_now);
      },
      buildClearedSessionCookie,
    );
}

/**
 * POST /api/admin/teams/:teamId/penalize — `{ confirm: true }` (the dialog's "Yes"). Official score 0 and the team is
 * frozen; gameplay history is kept. Owner Admin only; idempotent (a second click, a retry or a double submit change nothing).
 */
export function createPenalizeTeamHandler(deps: ScoringDeps) {
  return (request: Request, ctx: RouteContext<"teamId">): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        assertSameOrigin(request, env.APP_ORIGIN);
        const db = deps.db();
        const principal = requireAdmin(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const teamId = teamIdParamSchema.safeParse((await ctx.params).teamId);
        if (!teamId.success) throw new ApiError("NOT_FOUND", "Not found.");
        const key = readIdempotencyKey(request);
        await readJson(request, penalizeSchema);
        const result = parseResult(
          penalizeResultSchema,
          await callDb(db, "penalize_team", {
            p_staff_id: principal.staff.id,
            p_team_id: teamId.data,
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

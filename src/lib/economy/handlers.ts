import { respond, success } from "@/lib/api/envelope";
import { ApiError } from "@/lib/api/errors";
import { buildClearedSessionCookie } from "@/lib/auth/cookies";
import { readJson } from "@/lib/auth/handlers";
import { assertSameOrigin } from "@/lib/auth/origin";
import { resolvePrincipal, type Principal } from "@/lib/auth/principal";
import {
  buyHintResultSchema,
  buyHintSchema,
  buyTimeResultSchema,
  buyTimeSchema,
  finalSubmitResultSchema,
  finalSubmitSchema,
} from "@/lib/contracts/economy";
import { questionIdParamSchema } from "@/lib/contracts/gameplay";
import type { GameplayDeps, RouteContext } from "@/lib/gameplay/handlers";
import { callParticipantDb, parseResult, readIdempotencyKey } from "@/lib/runtime/handlers";

/**
 * Handlers of the economy and finalization operations (docs/ECONOMY_AND_FINALIZATION.md; Patch B15): buy a hint, buy
 * question time, and Final Submit. Same dependency bundle and the same order of checks as the B13 handlers: Origin →
 * session cookie → principal → participant role → path selector → `Idempotency-Key` → strict body → ONE database call →
 * result validated against a whitelist schema → envelope.
 *
 * The team and member ids come from the session only. The request carries a selector (question, tier, option) and, for
 * Buy Time, the purchase count the client saw. It never carries a price, a number of seconds, a balance or a reward:
 * the database reads those from its own tables under the team lock. No game rule is implemented here.
 */

type ParticipantPrincipal = Extract<Principal, { role: "PARTICIPANT" }>;

function requireParticipant(p: Principal): ParticipantPrincipal {
  if (p.role !== "PARTICIPANT") throw new ApiError("FORBIDDEN", "Participants only.");
  return p;
}

function parseQuestionId(raw: string | undefined): number {
  const parsed = questionIdParamSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError("NOT_FOUND", "Not found.");
  return parsed.data;
}

const replayHeaders = (replayed: boolean): HeadersInit | undefined =>
  replayed ? { "Idempotent-Replay": "true" } : undefined;

/** POST /api/p/questions/:questionId/hints — `{ tier }`; team-wide, charged once at the price stored in `hints.cost`. */
export function createBuyHintHandler(deps: GameplayDeps) {
  return (request: Request, ctx: RouteContext<"questionId">): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        assertSameOrigin(request, env.APP_ORIGIN);
        const db = deps.db();
        const principal = requireParticipant(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const questionId = parseQuestionId((await ctx.params).questionId);
        const key = readIdempotencyKey(request);
        const input = await readJson(request, buyHintSchema);
        const result = parseResult(
          buyHintResultSchema,
          await callParticipantDb(db, principal.team.id, "buy_hint", {
            p_team_id: principal.team.id,
            p_member_id: principal.member.id,
            p_question_id: questionId,
            p_tier: input.tier,
            p_idem_key: key,
          }),
        );
        const { replayed, state, ...data } = result;
        return success({ ...data, state }, state.server_now, {
          stateVersion: state.state_version,
          headers: replayHeaders(replayed),
        });
      },
      buildClearedSessionCookie,
    );
}

/**
 * POST /api/p/questions/:questionId/time — `{ optionId, expectedPurchaseCount }`. Extends THIS question's deadline by the
 * option's stored seconds for its stored cost; the team's own end time is never moved.
 */
export function createBuyTimeHandler(deps: GameplayDeps) {
  return (request: Request, ctx: RouteContext<"questionId">): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        assertSameOrigin(request, env.APP_ORIGIN);
        const db = deps.db();
        const principal = requireParticipant(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const questionId = parseQuestionId((await ctx.params).questionId);
        const key = readIdempotencyKey(request);
        const input = await readJson(request, buyTimeSchema);
        const result = parseResult(
          buyTimeResultSchema,
          await callParticipantDb(db, principal.team.id, "buy_time", {
            p_team_id: principal.team.id,
            p_member_id: principal.member.id,
            p_question_id: questionId,
            p_option_id: input.optionId,
            p_expected_count: input.expectedPurchaseCount,
            p_idem_key: key,
          }),
        );
        const { replayed, state, ...data } = result;
        return success({ ...data, state }, state.server_now, {
          stateVersion: state.state_version,
          headers: replayHeaders(replayed),
        });
      },
      buildClearedSessionCookie,
    );
}

/** POST /api/p/final-submit — `{ confirm: true }`; irreversible, freezes the whole team exactly like a timer end. */
export function createFinalSubmitHandler(deps: GameplayDeps) {
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
        const input = await readJson(request, finalSubmitSchema);
        const result = parseResult(
          finalSubmitResultSchema,
          await callParticipantDb(db, principal.team.id, "final_submit", {
            p_team_id: principal.team.id,
            p_member_id: principal.member.id,
            p_confirm: input.confirm,
            p_idem_key: key,
          }),
        );
        return success(result.state, result.state.server_now, {
          stateVersion: result.state.state_version,
          headers: replayHeaders(result.replayed),
        });
      },
      buildClearedSessionCookie,
    );
}

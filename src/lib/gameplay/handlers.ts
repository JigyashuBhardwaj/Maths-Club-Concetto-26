import type { z } from "zod";

import { respond, success } from "@/lib/api/envelope";
import { ApiError } from "@/lib/api/errors";
import { buildClearedSessionCookie } from "@/lib/auth/cookies";
import { MAX_ANSWER_BODY_BYTES, readJson, type AuthDeps } from "@/lib/auth/handlers";
import { assertSameOrigin } from "@/lib/auth/origin";
import { resolvePrincipal, type Principal } from "@/lib/auth/principal";
import {
  approveResultSchema,
  disapproveResultSchema,
  disapproveSchema,
  draftResultSchema,
  enterResultSchema,
  questionIdParamSchema,
  questionResultSchema,
  saveDraftSchema,
  submissionIdParamSchema,
  submitAnswerSchema,
  submitResultSchema,
  themeIdParamSchema,
  unlockResultSchema,
} from "@/lib/contracts/gameplay";
import {
  callDb,
  callParticipantDb,
  parseResult,
  readIdempotencyKey,
  requireEmptyBody,
} from "@/lib/runtime/handlers";

/**
 * Handlers of the participant gameplay engine (docs/API_SPEC.md §4, §6; Patch B13). Same dependency bundle and the same
 * order of checks as the B10/B12 handlers: Origin (non-GET) → session cookie → principal → role → path selector →
 * `Idempotency-Key` (state-changing calls) → strict body → ONE database call → result validated against a whitelist
 * schema → envelope.
 *
 * The team, member and staff ids sent to the database ALWAYS come from the session. The question/theme/submission id in
 * the path is only a selector: the database re-checks that it belongs to the caller's team. No state, score, coin
 * balance, timer or reward is ever read from a request (SEC-03), and no game rule is implemented here.
 */
export type GameplayDeps = AuthDeps;

/** Next.js passes the dynamic segments as a promise (App Router, v15+). */
export type RouteContext<P extends string> = { params: Promise<Record<P, string>> };

type ParticipantPrincipal = Extract<Principal, { role: "PARTICIPANT" }>;
type StaffPrincipal = Extract<Principal, { role: "ADMIN" | "SUPER_ADMIN" }>;

function requireParticipant(p: Principal): ParticipantPrincipal {
  if (p.role !== "PARTICIPANT") throw new ApiError("FORBIDDEN", "Participants only.");
  return p;
}

function requireReviewer(p: Principal): StaffPrincipal {
  if (p.role === "PARTICIPANT") throw new ApiError("FORBIDDEN", "You are not allowed to do that.");
  return p;
}

/** A path selector that does not parse is a 404: an unknown id and a malformed id look the same to the caller. */
function parseSelector<S extends z.ZodType>(schema: S, raw: string | undefined): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError("NOT_FOUND", "Not found.");
  return parsed.data;
}

const replayHeaders = (replayed: boolean): HeadersInit | undefined =>
  replayed ? { "Idempotent-Replay": "true" } : undefined;

/** GET /api/p/questions/:questionId — the caller's own view of one question (body only once it has been entered). */
export function createGetQuestionHandler(deps: GameplayDeps) {
  return (request: Request, ctx: RouteContext<"questionId">): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        const db = deps.db();
        const principal = requireParticipant(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const questionId = parseSelector(questionIdParamSchema, (await ctx.params).questionId);
        const result = parseResult(
          questionResultSchema,
          await callParticipantDb(db, principal.team.id, "get_question_for_team", {
            p_team_id: principal.team.id,
            p_member_id: principal.member.id,
            p_question_id: questionId,
          }),
        );
        return success({ question: result.question }, result.server_now, {
          stateVersion: result.state_version,
        });
      },
      buildClearedSessionCookie,
    );
}

/** POST /api/p/questions/:questionId/enter — opening the question page starts its timer once (no Start button). */
export function createEnterQuestionHandler(deps: GameplayDeps) {
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
        const questionId = parseSelector(questionIdParamSchema, (await ctx.params).questionId);
        const key = readIdempotencyKey(request);
        await requireEmptyBody(request);
        const { replayed, ...data } = parseResult(
          enterResultSchema,
          await callParticipantDb(db, principal.team.id, "start_question", {
            p_team_id: principal.team.id,
            p_member_id: principal.member.id,
            p_question_id: questionId,
            p_idem_key: key,
          }),
        );
        return success(data, deps.now(), { headers: replayHeaders(replayed) });
      },
      buildClearedSessionCookie,
    );
}

/** POST /api/p/themes/:themeId/unlock — team-wide; charges the configured cost once. */
export function createUnlockThemeHandler(deps: GameplayDeps) {
  return (request: Request, ctx: RouteContext<"themeId">): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        assertSameOrigin(request, env.APP_ORIGIN);
        const db = deps.db();
        const principal = requireParticipant(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const themeId = parseSelector(themeIdParamSchema, (await ctx.params).themeId);
        const key = readIdempotencyKey(request);
        await requireEmptyBody(request);
        const result = parseResult(
          unlockResultSchema,
          await callParticipantDb(db, principal.team.id, "unlock_theme", {
            p_team_id: principal.team.id,
            p_member_id: principal.member.id,
            p_theme_id: themeId,
            p_idem_key: key,
          }),
        );
        return success({ theme_id: result.theme_id, ...result.state }, result.state.server_now, {
          stateVersion: result.state.state_version,
          headers: replayHeaders(result.replayed),
        });
      },
      buildClearedSessionCookie,
    );
}

/** PUT /api/p/questions/:questionId/draft — debounced autosave of the team's shared draft (compare-and-set). */
export function createSaveDraftHandler(deps: GameplayDeps) {
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
        const questionId = parseSelector(questionIdParamSchema, (await ctx.params).questionId);
        const input = await readJson(request, saveDraftSchema, MAX_ANSWER_BODY_BYTES);
        const data = parseResult(
          draftResultSchema,
          await callParticipantDb(db, principal.team.id, "save_draft", {
            p_team_id: principal.team.id,
            p_member_id: principal.member.id,
            p_question_id: questionId,
            p_answer: input.answer,
            p_explanation: input.explanation,
            p_expected_version: input.expectedVersion,
          }),
        );
        return success(data, deps.now());
      },
      buildClearedSessionCookie,
    );
}

/** POST /api/p/questions/:questionId/submit — freezes the question timer; the team waits for review. */
export function createSubmitAnswerHandler(deps: GameplayDeps) {
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
        const questionId = parseSelector(questionIdParamSchema, (await ctx.params).questionId);
        const key = readIdempotencyKey(request);
        const input = await readJson(request, submitAnswerSchema, MAX_ANSWER_BODY_BYTES);
        const { replayed, ...data } = parseResult(
          submitResultSchema,
          await callParticipantDb(db, principal.team.id, "submit_answer", {
            p_team_id: principal.team.id,
            p_member_id: principal.member.id,
            p_question_id: questionId,
            p_answer: input.answer,
            p_explanation: input.explanation,
            p_idem_key: key,
          }),
        );
        return success(data, deps.now(), { headers: replayHeaders(replayed) });
      },
      buildClearedSessionCookie,
    );
}

/** POST /api/admin/submissions/:id/approve — Admin (own teams) or Super Admin; the reward is fixed by the question. */
export function createApproveSubmissionHandler(deps: GameplayDeps) {
  return (request: Request, ctx: RouteContext<"submissionId">): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        assertSameOrigin(request, env.APP_ORIGIN);
        const db = deps.db();
        const principal = requireReviewer(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const submissionId = parseSelector(
          submissionIdParamSchema,
          (await ctx.params).submissionId,
        );
        const key = readIdempotencyKey(request);
        await requireEmptyBody(request);
        const { replayed, ...data } = parseResult(
          approveResultSchema,
          await callDb(db, "approve_submission", {
            p_staff_id: principal.staff.id,
            p_submission_id: submissionId,
            p_idem_key: key,
          }),
        );
        return success(data, deps.now(), { headers: replayHeaders(replayed) });
      },
      buildClearedSessionCookie,
    );
}

/** POST /api/admin/submissions/:id/disapprove — `{ note? }`; keeps the rejected row and the team's draft. */
export function createDisapproveSubmissionHandler(deps: GameplayDeps) {
  return (request: Request, ctx: RouteContext<"submissionId">): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        assertSameOrigin(request, env.APP_ORIGIN);
        const db = deps.db();
        const principal = requireReviewer(
          await resolvePrincipal(db, request, env.SESSION_TOKEN_PEPPER),
        );
        const submissionId = parseSelector(
          submissionIdParamSchema,
          (await ctx.params).submissionId,
        );
        const key = readIdempotencyKey(request);
        const text = (await request.clone().text()).trim();
        const input = text === "" ? {} : await readJson(request, disapproveSchema);
        const { replayed, ...data } = parseResult(
          disapproveResultSchema,
          await callDb(db, "disapprove_submission", {
            p_staff_id: principal.staff.id,
            p_submission_id: submissionId,
            p_note: "note" in input && input.note ? input.note : null,
            p_idem_key: key,
          }),
        );
        return success(data, deps.now(), { headers: replayHeaders(replayed) });
      },
      buildClearedSessionCookie,
    );
}

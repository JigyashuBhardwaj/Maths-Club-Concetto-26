import { z } from "zod";

import { teamStatusSchema } from "./auth";

/**
 * Request and result shapes of the competition runtime (docs/API_SPEC.md §3–§7, Patch B10).
 *
 * The result schemas are WHITELISTS: zod strips every key not listed, so a field added to a database result later
 * (a hash, a token, an internal column) cannot reach a client by accident. Times are epoch milliseconds, durations
 * are integer seconds, and nothing here is ever accepted from the client: the timer is computed by the database.
 */

export const competitionStatusSchema = z.enum(["SETUP", "RUNNING", "PAUSED", "ENDED"]);
export type CompetitionStatusValue = z.infer<typeof competitionStatusSchema>;

export const competitionActionSchema = z.enum(["open", "pause", "resume", "end"]);
export type CompetitionAction = z.infer<typeof competitionActionSchema>;

/** `POST /api/super/competition/status` body. Strict: nothing but the action and the explicit confirmation. */
export const setCompetitionStatusSchema = z.strictObject({
  action: competitionActionSchema,
  confirm: z.literal(true),
});

/** `Idempotency-Key` header: a UUID (the client generates a v4 per user intent and reuses it on retry). */
export const idempotencyKeySchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

const epochMs = z.number().int().nonnegative();
const questionStateSchema = z.enum([
  "LOCKED",
  "AVAILABLE",
  "ACTIVE",
  "PENDING_APPROVAL",
  "APPROVED",
  "TIMED_OUT",
]);

export const teamStateSchema = z
  .object({
    server_now: epochMs,
    state_version: z.number().int().nonnegative(),
    competition: z.object({ status: competitionStatusSchema }),
    me: z.object({
      member_id: z.uuid(),
      slot: z.number().int().min(1).max(4),
      team_id: z.uuid(),
      team_code: z.string(),
      team_name: z.string(),
    }),
    team: z.object({
      status: teamStatusSchema,
      coins: z.number().int().nonnegative(),
      started_at: epochMs.nullable(),
      ends_at: epochMs.nullable(),
      ended_at: epochMs.nullable(),
      final_submitted_at: epochMs.nullable(),
      duration_seconds: z.number().int().positive(),
      remaining_seconds: z.number().int().nonnegative(),
      expired: z.boolean(),
      /**
       * True once the team can no longer play: FINAL_SUBMITTED / ENDED / DISQUALIFIED, or its timer reached zero
       * (even if the database has not yet persisted the ENDED status). The clients freeze on this flag.
       */
      frozen: z.boolean(),
    }),
    themes: z.array(
      z.object({
        id: z.number().int().min(1).max(10),
        code: z.string().length(1),
        name: z.string(),
        description: z.string(),
        topics: z.array(z.string()),
        difficulty: z.enum(["EASY", "MEDIUM", "HARD"]),
        unlock_cost: z.number().int().nonnegative(),
        status: z.enum(["LOCKED", "IN_PROGRESS", "COMPLETED", "FAILED"]),
        questions: z.array(
          z.object({
            id: z.number().int().min(1).max(50),
            ordinal: z.number().int().min(1).max(5),
            state: questionStateSchema,
            // Present once the question is no longer LOCKED (B13): what it pays and how long it runs.
            reward_coins: z.number().int().nonnegative().optional(),
            time_limit_seconds: z.number().int().positive().optional(),
            // ACTIVE: the absolute deadline and the seconds left; PENDING_APPROVAL: the frozen seconds left.
            deadline: epochMs.optional(),
            remaining_seconds: z.number().int().nonnegative().optional(),
          }),
        ),
      }),
    ),
  })
  // The database can never report more time than the competition allows; a result that does is a fault, not state.
  .refine((s) => s.team.remaining_seconds <= s.team.duration_seconds);
export type TeamState = z.infer<typeof teamStateSchema>;

/** `start_team_competition` result. */
export const startResultSchema = z.object({
  replayed: z.boolean(),
  started_now: z.boolean(),
  state: teamStateSchema,
});

/** `set_competition_status` result. */
export const statusResultSchema = z.object({
  replayed: z.boolean(),
  changed: z.boolean(),
  action: competitionActionSchema,
  from: competitionStatusSchema,
  to: competitionStatusSchema,
  paused_seconds: z.number().int().nonnegative().nullish(),
  teams_shifted: z.number().int().nonnegative().optional(),
  teams_ended: z.number().int().nonnegative().optional(),
  teams_total: z.number().int().nonnegative().optional(),
  competition: z.object({
    status: competitionStatusSchema,
    opened_at: epochMs.nullable(),
    paused_at: epochMs.nullable(),
    ended_at: epochMs.nullable(),
    state_version: z.number().int().nonnegative(),
  }),
});
export type StatusResult = z.infer<typeof statusResultSchema>;

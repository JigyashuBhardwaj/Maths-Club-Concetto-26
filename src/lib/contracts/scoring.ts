import { z } from "zod";

/**
 * Result shapes of the scoring, leaderboard and UFM-penalty operations (Phase B16). As everywhere else these are
 * WHITELISTS: zod strips unknown keys, so nothing but rank, Team ID and score can reach a participant's browser.
 */

const epochMs = z.number().int().nonnegative();

/** One line of any leaderboard: the rank the server computed, the Team ID and the official score (may be negative). */
export const boardRowSchema = z.object({
  rank: z.number().int().min(1),
  team_id: z.string(),
  score: z.number().int(),
});
export type BoardRow = z.infer<typeof boardRowSchema>;

/** `get_leaderboard` (Admin / Super Admin). */
export const staffBoardSchema = z.object({
  server_now: epochMs.optional(),
  rows: z.array(boardRowSchema),
});
export type StaffBoard = z.infer<typeof staffBoardSchema>;

/** `get_team_leaderboard` (participant): the same ranking plus the caller's own line, taken from the same snapshot. */
export const participantBoardSchema = z.object({
  server_now: epochMs,
  rows: z.array(boardRowSchema),
  me: boardRowSchema.nullable(),
});
export type ParticipantBoard = z.infer<typeof participantBoardSchema>;

/** `POST /api/admin/teams/:teamId/penalize` body: the dialog's "Yes". "No" sends nothing at all. */
export const penalizeSchema = z.strictObject({ confirm: z.literal(true) });
export type PenalizeInput = z.infer<typeof penalizeSchema>;

/** `penalize_team` result. `changed:false` means the team was already penalised (an idempotent no-op). */
export const penalizeResultSchema = z.object({
  replayed: z.boolean(),
  changed: z.boolean(),
  team: z.object({
    id: z.uuid(),
    team_code: z.string(),
    status: z.string(),
    official_score: z.literal(0),
    penalized_at: epochMs,
  }),
});
export type PenalizeResult = z.infer<typeof penalizeResultSchema>;

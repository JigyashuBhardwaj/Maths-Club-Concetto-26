import { z } from "zod";

/**
 * Result shapes of the Admin "My Teams" live matrix (Patch B14). As everywhere else these are WHITELISTS: zod strips
 * unknown keys, so nothing but these fields can reach the browser. No reference answer, key or credential has a field here.
 */

const epochMs = z.number().int().nonnegative();

/** The ten themes A..J (the competition structure is fixed). */
export const THEME_CODES = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] as const;
export const themeCodeParamSchema = z
  .string()
  .regex(/^[A-Ja-j]$/)
  .transform((c) => c.toUpperCase());
export const teamIdParamSchema = z.uuid();

export const presenceSchema = z.enum(["ONLINE", "OFFLINE"]);
export type Presence = z.infer<typeof presenceSchema>;

/** RED = something to review in this theme, GREEN = all five questions approved, NORMAL = neither. */
export const themeCellStateSchema = z.enum(["NORMAL", "RED", "GREEN"]);
export type ThemeCellState = z.infer<typeof themeCellStateSchema>;

export const matrixTeamSchema = z.object({
  id: z.uuid(),
  team_code: z.string(),
  name: z.string(),
  status: z.string(),
  final_submitted: z.boolean(),
  /** B16: the UFM penalty has been applied (official score 0, team frozen). */
  ufm_penalized: z.boolean(),
  members: z.array(z.object({ slot: z.number().int().min(1).max(4), presence: presenceSchema })),
  themes: z.array(
    z.object({
      code: z.string().length(1),
      state: themeCellStateSchema,
      approved: z.number().int().min(0).max(5),
      pending: z.number().int().min(0).max(5),
    }),
  ),
});
export type MatrixTeam = z.infer<typeof matrixTeamSchema>;

/** `admin_matrix` result: one row per team the caller owns. */
export const matrixResultSchema = z.object({
  server_now: epochMs,
  presence_timeout_seconds: z.number().int().positive(),
  teams: z.array(matrixTeamSchema),
});
export type MatrixResult = z.infer<typeof matrixResultSchema>;

export const reviewSubmissionSchema = z.object({
  id: z.uuid(),
  body_md: z.string(),
  answer: z.string(),
  explanation: z.string(),
  submitted_by_slot: z.number().int().min(1).max(4).nullable(),
  submitted_at: epochMs,
  reward_coins: z.number().int().nonnegative(),
});
export type ReviewSubmission = z.infer<typeof reviewSubmissionSchema>;

export const themeQuestionSchema = z.object({
  id: z.number().int().min(1).max(50),
  ordinal: z.number().int().min(1).max(5),
  label: z.string(),
  color: z.enum(["WHITE", "RED", "GREEN"]),
  state: z.enum(["LOCKED", "AVAILABLE", "ACTIVE", "PENDING_APPROVAL", "APPROVED", "TIMED_OUT"]),
  submission: reviewSubmissionSchema.nullable(),
});
export type ThemeQuestion = z.infer<typeof themeQuestionSchema>;

/** `admin_team_theme` result: the five questions of one theme cell. */
export const teamThemeResultSchema = z.object({
  server_now: epochMs,
  team: z.object({ id: z.uuid(), team_code: z.string(), name: z.string() }),
  theme: z.object({ code: z.string().length(1), name: z.string() }),
  questions: z.array(themeQuestionSchema).length(5),
});
export type TeamThemeResult = z.infer<typeof teamThemeResultSchema>;

/** `POST /api/p/heartbeat` result. The heartbeat itself carries no data and changes no game state. */
export const heartbeatResultSchema = z.object({ server_now: epochMs });

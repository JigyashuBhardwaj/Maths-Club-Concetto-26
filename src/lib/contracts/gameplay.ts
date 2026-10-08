import { z } from "zod";

import { teamStateSchema } from "./runtime";

/**
 * Request and result shapes of the participant gameplay engine (docs/API_SPEC.md §4, §6; Patch B13).
 *
 * As everywhere else the result schemas are WHITELISTS (zod strips unknown keys) and nothing the client sends is
 * authority: the team and member come from the session, the question and theme ids from the path are only a selector
 * the database re-checks, and no time, balance, state or reward is ever read from a request.
 */

const epochMs = z.number().int().nonnegative();

/** Path selector: a question is 1..50, a theme 1..10. Anything else is a 400 before the database is touched. */
const idParam = (max: number) =>
  z
    .string()
    .regex(/^[1-9]\d{0,1}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));
export const questionIdParamSchema = idParam(50);
export const themeIdParamSchema = idParam(10);
export const submissionIdParamSchema = z.uuid();

/** An answer or explanation: at most 10 000 characters each (the same bound the table enforces). */
export const MAX_TEXT = 10_000;

/** `PUT /api/p/questions/:id/draft` body. `expectedVersion` is the version the client last saw (0 = no draft yet). */
export const saveDraftSchema = z.strictObject({
  answer: z.string().max(MAX_TEXT),
  explanation: z.string().max(MAX_TEXT).default(""),
  expectedVersion: z.number().int().min(0).max(1_000_000),
});
export type SaveDraftInput = z.infer<typeof saveDraftSchema>;

/** `POST /api/p/questions/:id/submit` body. The answer is required; the explanation is optional. */
export const submitAnswerSchema = z.strictObject({
  answer: z
    .string()
    .max(MAX_TEXT)
    .refine((v) => v.trim().length > 0),
  explanation: z.string().max(MAX_TEXT).default(""),
});
export type SubmitAnswerInput = z.infer<typeof submitAnswerSchema>;

/** `POST /api/admin/submissions/:id/disapprove` body. */
export const disapproveSchema = z.strictObject({
  note: z.string().trim().max(500).optional(),
});

export const submissionStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED"]);

/**
 * A hint as the team sees it (B15). The price is always shown; the text only once the team owns it (the database
 * omits `body_md` otherwise, and this schema has no other field that could carry it).
 */
export const hintSchema = z.object({
  tier: z.number().int().min(1).max(2),
  cost: z.number().int().nonnegative(),
  owned: z.boolean(),
  purchasable: z.boolean(),
  body_md: z.string().optional(),
});
export type Hint = z.infer<typeof hintSchema>;

/** One Buy Time option, read from the data (`question_buy_time_options`): seconds, price and purchase cap. */
export const buyTimeOptionSchema = z.object({
  id: z.number().int().positive(),
  seconds: z.number().int().positive(),
  cost: z.number().int().nonnegative(),
  max_purchases: z.number().int().positive().nullable(),
  purchased: z.number().int().nonnegative(),
  remaining_purchases: z.number().int().nonnegative().nullable(),
});
export type BuyTimeOption = z.infer<typeof buyTimeOptionSchema>;

/** The team's Buy Time state for one question. `options` is empty unless the question is ACTIVE. */
export const buyTimeSchema = z.object({
  purchase_count: z.number().int().nonnegative(),
  extra_seconds: z.number().int().nonnegative(),
  can_buy: z.boolean(),
  options: z.array(buyTimeOptionSchema),
});
export type BuyTime = z.infer<typeof buyTimeSchema>;

/** One question as the team sees it. There is deliberately no field for a reference answer or solution notes. */
export const questionSchema = z.object({
  id: z.number().int().min(1).max(50),
  theme_id: z.number().int().min(1).max(10),
  theme_code: z.string().length(1),
  ordinal: z.number().int().min(1).max(5),
  state: z.enum(["AVAILABLE", "ACTIVE", "PENDING_APPROVAL", "APPROVED", "TIMED_OUT"]),
  reward_coins: z.number().int().nonnegative(),
  time_limit_seconds: z.number().int().positive(),
  hints: z.array(hintSchema),
  buy_time: buyTimeSchema,
  /** Withheld while the question is AVAILABLE: the body is delivered only once the team has entered it. */
  body_md: z.string().optional(),
  deadline: epochMs.optional(),
  remaining_seconds: z.number().int().nonnegative().optional(),
  draft: z
    .object({
      answer: z.string(),
      explanation: z.string(),
      version: z.number().int().nonnegative(),
      updated_by_slot: z.number().int().min(1).max(4).nullable(),
      updated_at: epochMs.nullable(),
    })
    .optional(),
  submission: z
    .object({
      id: z.uuid(),
      status: submissionStatusSchema,
      answer: z.string(),
      explanation: z.string(),
      submitted_by_slot: z.number().int().min(1).max(4),
      submitted_at: epochMs,
      reviewed_at: epochMs.nullable(),
      review_note: z.string().nullable(),
      reward_awarded: z.number().int().nonnegative().nullable(),
    })
    .optional(),
  last_rejection: z
    .object({ note: z.string().nullable(), reviewed_at: epochMs.nullable() })
    .optional(),
});
export type Question = z.infer<typeof questionSchema>;

/** `get_question_for_team` result. */
export const questionResultSchema = z.object({
  server_now: epochMs,
  state_version: z.number().int().nonnegative(),
  question: questionSchema,
});

/** `unlock_theme` result. */
export const unlockResultSchema = z.object({
  replayed: z.boolean(),
  theme_id: z.number().int().min(1).max(10),
  state: teamStateSchema,
});

/** `start_question` result. */
export const enterResultSchema = z.object({
  replayed: z.boolean(),
  started_now: z.boolean(),
  question: questionSchema,
});

/** `save_draft` result. */
export const draftResultSchema = z.object({
  version: z.number().int().nonnegative(),
  updated_by_slot: z.number().int().min(1).max(4).nullable(),
  updated_at: epochMs.nullable(),
});

/** `submit_answer` result. */
export const submitResultSchema = z.object({
  replayed: z.boolean(),
  question: questionSchema,
});

/** `approve_submission` result. */
export const approveResultSchema = z.object({
  replayed: z.boolean(),
  submission: z.object({ id: z.uuid(), status: submissionStatusSchema }),
  reward_awarded: z.number().int().nonnegative(),
  next_question_activated: z.boolean(),
});

/** `disapprove_submission` result. */
export const disapproveResultSchema = z.object({
  replayed: z.boolean(),
  submission: z.object({ id: z.uuid(), status: submissionStatusSchema }),
});

import { z } from "zod";

import { hintSchema, questionSchema } from "./gameplay";
import { teamStateSchema } from "./runtime";

/**
 * Request and result shapes of the economy and finalization operations (docs/ECONOMY_AND_FINALIZATION.md; Patch B15):
 * buying a hint, buying question time, and the team's Final Submit.
 *
 * Bodies are STRICT and carry only a selector or a confirmation. A price, a number of seconds, a coin balance, a
 * reward, a team id or a state is never accepted from a client: the database reads them from its own tables under the
 * team lock. The result schemas are whitelists (zod strips unknown keys), so nothing the database adds later reaches a
 * client by accident.
 */

/** `POST /api/p/questions/:id/hints` body. Tier 1 or 2; the price comes from `hints.cost`. */
export const buyHintSchema = z.strictObject({
  tier: z.union([z.literal(1), z.literal(2)]),
});
export type BuyHintInput = z.infer<typeof buyHintSchema>;

/**
 * `POST /api/p/questions/:id/time` body. `optionId` selects a row of `question_buy_time_options`; the database checks
 * that it belongs to this question. `expectedPurchaseCount` is the count the client saw: when a teammate bought
 * meanwhile the call is refused (STALE_PURCHASE_COUNT) instead of silently charging a second time.
 */
export const buyTimeSchema = z.strictObject({
  optionId: z.number().int().min(1).max(32_767),
  expectedPurchaseCount: z.number().int().min(0).max(1_000),
});
export type BuyTimeInput = z.infer<typeof buyTimeSchema>;

/** `POST /api/p/final-submit` body. The irreversible action needs an explicit `confirm: true`. */
export const finalSubmitSchema = z.strictObject({ confirm: z.literal(true) });
export type FinalSubmitInput = z.infer<typeof finalSubmitSchema>;

/** `buy_hint` result. `hint.body_md` is the text the team now owns (also when it already owned it: no charge). */
export const buyHintResultSchema = z.object({
  replayed: z.boolean(),
  already_owned: z.boolean(),
  tier: z.number().int().min(1).max(2),
  hint: hintSchema.pick({ tier: true }).extend({ body_md: z.string() }),
  question: questionSchema,
  state: teamStateSchema,
});
export type BuyHintResult = z.infer<typeof buyHintResultSchema>;

/** `buy_time` result. `purchase.seq` is the 1-based purchase number for this question. */
export const buyTimeResultSchema = z.object({
  replayed: z.boolean(),
  purchase: z.object({
    seq: z.number().int().positive(),
    option_id: z.number().int().positive(),
    seconds: z.number().int().positive(),
    cost: z.number().int().nonnegative(),
  }),
  question: questionSchema,
  state: teamStateSchema,
});
export type BuyTimeResult = z.infer<typeof buyTimeResultSchema>;

/** `final_submit` result: the frozen snapshot. */
export const finalSubmitResultSchema = z.object({
  replayed: z.boolean(),
  state: teamStateSchema,
});
export type FinalSubmitResult = z.infer<typeof finalSubmitResultSchema>;

/** `finalize_team_if_due` result (never raises). */
export const finalizeResultSchema = z.object({
  finalized: z.boolean(),
  status: z.string(),
});

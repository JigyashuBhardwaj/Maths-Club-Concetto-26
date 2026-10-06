/** Placeholder content/prices for the question page UI. Real values come from the seeded content later. */

/** Canonical value lives in the competition contract (10 themes A–J × 5 questions). */
export { QUESTIONS_PER_THEME } from "@/lib/contracts/competition";
/** Every question starts with four minutes. */
export const QUESTION_SECONDS = 4 * 60;
/** Shown as "50 coins++"; the real reward is fixed per question on the server. */
export const REWARD_COINS = 50;
/** Hint 1 and Hint 2 prices (Tier 2 can only be bought after Tier 1). */
export const HINT_COSTS = [40, 80] as const;
export const BUY_TIME_OPTIONS = [
  { minutes: 2, cost: 20 },
  { minutes: 4, cost: 40 },
  { minutes: 8, cost: 80 },
] as const;
export type BuyTimeOption = (typeof BUY_TIME_OPTIONS)[number];

export const PLACEHOLDER_QUESTION =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.";
export const PLACEHOLDER_HINT =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";

/**
 * Browser-side calls of the economy and finalization API (Patch B15): buy a hint, buy question time, Final Submit.
 * Same rules as `lib/gameplay/client.ts`: the session is the HttpOnly cookie, nothing is persisted in the browser, no
 * request carries a price / seconds / balance / reward (the body is a selector or a confirmation), and every function
 * returns a result instead of throwing. The caller owns the `Idempotency-Key`: one per user intent, reused on retry.
 */
import { buyHintResultSchema, buyTimeResultSchema } from "@/lib/contracts/economy";
import type { Question } from "@/lib/contracts/gameplay";
import { teamStateSchema, type TeamState } from "@/lib/contracts/runtime";
import { call, checked, type CallResult } from "@/lib/gameplay/client";

export interface HintBought {
  already_owned: boolean;
  tier: number;
  hint: { tier: number; body_md: string };
  question: Question;
  state: TeamState;
}

export interface TimeBought {
  purchase: { seq: number; option_id: number; seconds: number; cost: number };
  question: Question;
  state: TeamState;
}

/** `POST /api/p/questions/:id/hints` — team-wide; the price is the one stored with the hint. */
export async function buyHintCall(
  questionId: number,
  tier: 1 | 2,
  key: string,
): Promise<CallResult<HintBought>> {
  const r = await call("POST", `/api/p/questions/${questionId}/hints`, { body: { tier }, key });
  return checked(r, (d) => {
    const p = buyHintResultSchema.omit({ replayed: true }).safeParse(d);
    return p.success ? p.data : null;
  });
}

/**
 * `POST /api/p/questions/:id/time` — adds the stored seconds of the chosen option to THIS question's deadline.
 * `expectedPurchaseCount` is what the screen showed; a teammate's purchase in between is refused, not double-charged.
 */
export async function buyTimeCall(
  questionId: number,
  optionId: number,
  expectedPurchaseCount: number,
  key: string,
): Promise<CallResult<TimeBought>> {
  const r = await call("POST", `/api/p/questions/${questionId}/time`, {
    body: { optionId, expectedPurchaseCount },
    key,
  });
  return checked(r, (d) => {
    const p = buyTimeResultSchema.omit({ replayed: true }).safeParse(d);
    return p.success ? p.data : null;
  });
}

/** `POST /api/p/final-submit` — irreversible; returns the frozen snapshot. */
export async function finalSubmitCall(key: string): Promise<CallResult<TeamState>> {
  const r = await call("POST", "/api/p/final-submit", { body: { confirm: true }, key });
  return checked(r, (d) => {
    const p = teamStateSchema.safeParse(d);
    return p.success ? p.data : null;
  });
}

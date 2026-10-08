import { describe, expect, it } from "vitest";

import {
  buyHintResultSchema,
  buyHintSchema,
  buyTimeResultSchema,
  buyTimeSchema,
  finalSubmitResultSchema,
  finalSubmitSchema,
  finalizeResultSchema,
} from "@/lib/contracts/economy";
import { question, snapshot } from "../component/support/game";

describe("economy request bodies are strict selectors", () => {
  it("buy hint accepts tier 1 or 2 only and nothing else", () => {
    expect(buyHintSchema.safeParse({ tier: 1 }).success).toBe(true);
    expect(buyHintSchema.safeParse({ tier: 2 }).success).toBe(true);
    for (const bad of [
      {},
      { tier: 0 },
      { tier: 3 },
      { tier: "1" },
      { tier: 1.5 },
      { tier: 1, cost: 0 },
      { tier: 1, coins: 9999 },
      { tier: 1, team_id: "x" },
      { tier: 1, state: "OWNED" },
    ]) {
      expect(buyHintSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("buy time carries only a pack id and the purchase count the screen showed", () => {
    expect(buyTimeSchema.safeParse({ optionId: 3, expectedPurchaseCount: 0 }).success).toBe(true);
    for (const bad of [
      {},
      { optionId: 3 },
      { expectedPurchaseCount: 0 },
      { optionId: 0, expectedPurchaseCount: 0 },
      { optionId: 1.5, expectedPurchaseCount: 0 },
      { optionId: 32_768, expectedPurchaseCount: 0 },
      { optionId: 1, expectedPurchaseCount: -1 },
      { optionId: 1, expectedPurchaseCount: 1001 },
      { optionId: 1, expectedPurchaseCount: 0, seconds: 99_999 },
      { optionId: 1, expectedPurchaseCount: 0, cost: 0 },
      { optionId: 1, expectedPurchaseCount: 0, deadline: 1 },
      { optionId: "1", expectedPurchaseCount: 0 },
    ]) {
      expect(buyTimeSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("final submit needs an explicit confirm:true", () => {
    expect(finalSubmitSchema.safeParse({ confirm: true }).success).toBe(true);
    for (const bad of [{}, { confirm: false }, { confirm: "true" }, { confirm: true, score: 1 }]) {
      expect(finalSubmitSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("economy results are whitelists", () => {
  const state = snapshot();

  it("buy hint result keeps the owned text and drops anything the database adds", () => {
    const parsed = buyHintResultSchema.parse({
      replayed: false,
      already_owned: false,
      tier: 1,
      hint: { tier: 1, body_md: "Think small.", cost: 20, internal: "x" },
      question: question(),
      state,
      secret: "x",
    });
    expect(parsed.hint).toEqual({ tier: 1, body_md: "Think small." });
    expect(parsed).not.toHaveProperty("secret");
    expect(buyHintResultSchema.safeParse({ replayed: false, tier: 1 }).success).toBe(false);
    expect(
      buyHintResultSchema.safeParse({
        replayed: false,
        already_owned: false,
        tier: 3,
        hint: { tier: 1, body_md: "" },
        question: question(),
        state,
      }).success,
    ).toBe(false);
  });

  it("buy time result needs a positive sequence, option and seconds", () => {
    const ok = {
      replayed: true,
      purchase: { seq: 1, option_id: 2, seconds: 240, cost: 40 },
      question: question(),
      state,
    };
    expect(buyTimeResultSchema.safeParse(ok).success).toBe(true);
    for (const purchase of [
      { ...ok.purchase, seq: 0 },
      { ...ok.purchase, seconds: 0 },
      { ...ok.purchase, cost: -1 },
      { ...ok.purchase, option_id: 0 },
    ]) {
      expect(buyTimeResultSchema.safeParse({ ...ok, purchase }).success).toBe(false);
    }
  });

  it("final submit and finalize results", () => {
    expect(finalSubmitResultSchema.safeParse({ replayed: false, state }).success).toBe(true);
    expect(finalSubmitResultSchema.safeParse({ replayed: false }).success).toBe(false);
    expect(finalizeResultSchema.safeParse({ finalized: true, status: "ENDED" }).success).toBe(true);
    expect(finalizeResultSchema.safeParse({ finalized: "yes", status: "ENDED" }).success).toBe(
      false,
    );
  });
});

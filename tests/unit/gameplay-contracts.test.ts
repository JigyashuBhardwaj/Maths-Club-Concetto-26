import { describe, expect, it } from "vitest";

import {
  approveResultSchema,
  disapproveSchema,
  draftResultSchema,
  enterResultSchema,
  questionIdParamSchema,
  questionResultSchema,
  questionSchema,
  saveDraftSchema,
  submissionIdParamSchema,
  submitAnswerSchema,
  themeIdParamSchema,
} from "@/lib/contracts/gameplay";

const q = {
  id: 1,
  theme_id: 1,
  theme_code: "A",
  ordinal: 1,
  state: "ACTIVE",
  reward_coins: 50,
  time_limit_seconds: 240,
  hints: [],
  buy_time: { purchase_count: 0, extra_seconds: 0, can_buy: false, options: [] },
  body_md: "Find x.",
  deadline: 1_760_000_240_000,
  remaining_seconds: 200,
  draft: { answer: "", explanation: "", version: 0, updated_by_slot: null, updated_at: null },
};

describe("path selectors", () => {
  it("accept only the real id ranges", () => {
    expect(questionIdParamSchema.safeParse("1").success).toBe(true);
    expect(questionIdParamSchema.safeParse("50").success).toBe(true);
    for (const bad of ["0", "51", "-1", "1.5", "abc", "", "1e1"]) {
      expect(questionIdParamSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(themeIdParamSchema.safeParse("10").success).toBe(true);
    for (const bad of ["0", "11", "x"])
      expect(themeIdParamSchema.safeParse(bad).success).toBe(false);
    expect(submissionIdParamSchema.safeParse("5d6f1c1a-3b8e-4f0a-9c21-7e4d2a9b8c10").success).toBe(
      true,
    );
    expect(submissionIdParamSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});

describe("request bodies are strict and bounded", () => {
  it("draft: answer, optional explanation, expectedVersion; nothing else", () => {
    expect(saveDraftSchema.parse({ answer: "x", expectedVersion: 0 })).toEqual({
      answer: "x",
      explanation: "",
      expectedVersion: 0,
    });
    expect(saveDraftSchema.safeParse({ answer: "", expectedVersion: 3 }).success).toBe(true);
    for (const bad of [
      { answer: "x" },
      { answer: "x", expectedVersion: -1 },
      { answer: "x", expectedVersion: 1.5 },
      { answer: 5, expectedVersion: 0 },
      { answer: "a".repeat(10_001), expectedVersion: 0 },
      { answer: "x", expectedVersion: 0, teamId: "t" },
      { answer: "x", expectedVersion: 0, state: "APPROVED" },
    ]) {
      expect(saveDraftSchema.safeParse(bad).success).toBe(false);
    }
  });
  it("submit: a non-blank answer is required; the text is kept exactly as typed", () => {
    expect(submissionKept(" 42 \n")).toBe(" 42 \n");
    for (const bad of [{}, { answer: "" }, { answer: "  \n " }, { answer: "x", reward: 9 }]) {
      expect(submitAnswerSchema.safeParse(bad).success).toBe(false);
    }
    expect(submitAnswerSchema.safeParse({ answer: "a".repeat(10_001) }).success).toBe(false);
  });
  it("disapprove: an optional note of at most 500 characters", () => {
    expect(disapproveSchema.safeParse({}).success).toBe(true);
    expect(disapproveSchema.parse({ note: "  hi " }).note).toBe("hi");
    expect(disapproveSchema.safeParse({ note: "n".repeat(501) }).success).toBe(false);
    expect(disapproveSchema.safeParse({ note: "x", reviewer: "y" }).success).toBe(false);
  });
});

function submissionKept(answer: string): string {
  return submitAnswerSchema.parse({ answer }).answer;
}

describe("result whitelists", () => {
  it("a question never carries a reference answer, solution notes or a reviewer, whatever the database sends", () => {
    const parsed = questionSchema.parse({
      ...q,
      reference_answer: "SECRET",
      solution_notes: "SECRET",
      reviewed_by: "staff",
      draft: { ...q.draft, password_hash: "h" },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/SECRET|reviewed_by|password_hash/);
  });
  it("an AVAILABLE question has no body, deadline or draft in the contract's required fields", () => {
    const parsed = questionSchema.parse({
      id: 1,
      theme_id: 1,
      theme_code: "A",
      ordinal: 1,
      state: "AVAILABLE",
      reward_coins: 50,
      time_limit_seconds: 240,
      hints: [],
      buy_time: { purchase_count: 0, extra_seconds: 0, can_buy: false, options: [] },
    });
    expect(parsed).not.toHaveProperty("body_md");
    expect(parsed).not.toHaveProperty("deadline");
    expect(parsed).not.toHaveProperty("draft");
  });
  it("a LOCKED question is not a valid question result (it is refused, never described)", () => {
    expect(questionSchema.safeParse({ ...q, state: "LOCKED" }).success).toBe(false);
  });
  it("rejects malformed numbers and states", () => {
    for (const bad of [
      { ...q, id: 0 },
      { ...q, state: "DONE" },
      { ...q, remaining_seconds: -1 },
      { ...q, deadline: 1.5 },
      { ...q, reward_coins: "50" },
    ]) {
      expect(questionSchema.safeParse(bad).success).toBe(false);
    }
  });
  it("question, enter, draft and approve results parse", () => {
    expect(
      questionResultSchema.safeParse({ server_now: 1, state_version: 2, question: q }).success,
    ).toBe(true);
    expect(
      enterResultSchema.safeParse({ replayed: false, started_now: true, question: q }).success,
    ).toBe(true);
    expect(
      draftResultSchema.safeParse({ version: 3, updated_by_slot: 2, updated_at: 5 }).success,
    ).toBe(true);
    expect(
      approveResultSchema.safeParse({
        replayed: false,
        submission: { id: "5d6f1c1a-3b8e-4f0a-9c21-7e4d2a9b8c10", status: "APPROVED" },
        reward_awarded: 50,
        next_question_activated: true,
      }).success,
    ).toBe(true);
  });
});

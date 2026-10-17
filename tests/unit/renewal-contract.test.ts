/* eslint-disable @typescript-eslint/no-explicit-any -- the tests deliberately build malformed documents */
import { describe, expect, it } from "vitest";

import {
  RENEWAL_LIMITS,
  contentToDraft,
  draftProblems,
  draftToContent,
  renewRequestSchema,
  renewalContentSchema,
  rewardProblem,
  textProblem,
  type RenewalContent,
} from "@/lib/contracts/renewal";

import { contentProblems } from "../e2e/support/fake-renewal.mjs";

/**
 * The renewal contract: the fixed structure, the bounds, and that the three places that judge a content — the zod request
 * schema (the API), `draftProblems` (the editor) and the database's `app.renewal_content_problems` (mirrored by the stand-in) —
 * agree on what is acceptable. The SQL side is proven on PostgreSQL by supabase/tests/200_renew_competition.test.sql.
 */
const TOKEN = "a".repeat(64);
function valid(): RenewalContent {
  return {
    themes: [..."ABCDEFGHIJ"].map((code) => ({
      id: code,
      name: `Theme ${code}`,
      description: `Description of ${code}`,
      questions: [1, 2, 3, 4, 5].map((n) => ({
        id: `${code}.${n}`,
        question: `Question ${code}.${n}?\nSecond line.`,
        hint1: `Hint 1 of ${code}.${n}`,
        hint2: `Hint 2 of ${code}.${n}`,
        reward: 10 * n,
      })),
    })),
    rules: ["Rule one.", "Rule two."],
  };
}
const clone = <X>(x: X): X => JSON.parse(JSON.stringify(x)) as X;

describe("content shape", () => {
  it("accepts the full fixed structure", () => {
    expect(renewalContentSchema.safeParse(valid()).success).toBe(true);
    expect(renewRequestSchema.safeParse({ content: valid(), expectedToken: TOKEN }).success).toBe(
      true,
    );
  });

  it("requires a 64-hex token and no other key", () => {
    for (const expectedToken of ["", "abc", "A".repeat(64), "g".repeat(64), "a".repeat(63)]) {
      expect(renewRequestSchema.safeParse({ content: valid(), expectedToken }).success).toBe(false);
    }
    for (const extra of [{ staffId: "x" }, { force: true }, { role: "SUPER_ADMIN" }]) {
      expect(
        renewRequestSchema.safeParse({ content: valid(), expectedToken: TOKEN, ...extra }).success,
      ).toBe(false);
    }
  });

  const cases: [string, (c: any) => void, boolean][] = [
    ["valid", () => {}, true],
    ["multiline + unicode + punctuation", (c) => (c.rules[0] = "α\n\n“q”, (x)! 日本語 😀\t"), true],
    [
      "200 astral characters as a theme name (counted as characters)",
      (c) => (c.themes[0].name = "😀".repeat(200)),
      true,
    ],
    ["201 characters as a theme name", (c) => (c.themes[0].name = "x".repeat(201)), false],
    ["reward 1", (c) => (c.themes[0].questions[0].reward = 1), true],
    ["reward 999999", (c) => (c.themes[0].questions[0].reward = 999_999), true],
    ["reward 0", (c) => (c.themes[0].questions[0].reward = 0), false],
    ["reward 1e6", (c) => (c.themes[0].questions[0].reward = 1_000_000), false],
    ["reward -1", (c) => (c.themes[0].questions[0].reward = -1), false],
    ["reward 1.5", (c) => (c.themes[0].questions[0].reward = 1.5), false],
    ["reward as a string", (c) => (c.themes[0].questions[0].reward = "5"), false],
    ["9 themes", (c) => c.themes.pop(), false],
    ["themes out of order", (c) => c.themes.reverse(), false],
    ["a theme id changed", (c) => (c.themes[5].id = "Z"), false],
    ["a question id changed", (c) => (c.themes[5].questions[2].id = "F.9"), false],
    ["4 questions", (c) => c.themes[7].questions.pop(), false],
    ["a third hint", (c) => (c.themes[1].questions[1].hint3 = "x"), false],
    ["a missing hint", (c) => delete c.themes[1].questions[1].hint1, false],
    ["an extra setting", (c) => (c.themes[1].questions[1].price = 5), false],
    ["a blank question", (c) => (c.themes[2].questions[0].question = "  \n "), false],
    ["a control character", (c) => (c.themes[2].name = "a\u0007b"), false],
    ["a stray form feed", (c) => (c.rules[0] = "a\u000cb"), false],
    ["a valid surrogate pair (emoji)", (c) => (c.themes[3].name = "ok 😀"), true],
    ["no rules", (c) => (c.rules = []), false],
    ["50 rules", (c) => (c.rules = Array.from({ length: 50 }, (_, i) => `r${i}`)), true],
    ["51 rules", (c) => (c.rules = Array.from({ length: 51 }, (_, i) => `r${i}`)), false],
    ["a blank rule", (c) => (c.rules[1] = ""), false],
    [
      "an over-long hint",
      (c) => (c.themes[0].questions[0].hint2 = "x".repeat(RENEWAL_LIMITS.hint + 1)),
      false,
    ],
    ["an over-long rule", (c) => (c.rules[0] = "x".repeat(RENEWAL_LIMITS.rule + 1)), false],
  ];

  it.each(cases)("%s", (_name, mutate, ok) => {
    const c = clone(valid());
    mutate(c);
    const zod = renewalContentSchema.safeParse(c).success;
    const db = contentProblems(c).length === 0;
    expect(zod, "API schema").toBe(ok);
    expect(db, "database rules").toBe(ok);
    // the editor's own check judges the same content (its rewards are text; a non-integer reward is typed text)
    if (typeof c.themes[0]?.questions[0]?.reward === "number" && c.themes.length === 10) {
      const draft = (() => {
        try {
          return contentToDraft(c);
        } catch {
          return null;
        }
      })();
      const structural = c.themes.every(
        (t: any, i: number) =>
          t.id === "ABCDEFGHIJ"[i] &&
          t.questions.length === 5 &&
          t.questions.every(
            (q: any, j: number) =>
              q.id === `${t.id}.${j + 1}` &&
              Object.keys(q).length === 5 &&
              typeof q.reward === "number",
          ),
      );
      if (draft && structural)
        expect(Object.keys(draftProblems(draft)).length === 0, "editor").toBe(ok);
    }
  });
});

describe("the editor's draft", () => {
  it("round-trips the content exactly, rewards as text", () => {
    const c = valid();
    const d = contentToDraft(c);
    expect(d.themes[0]!.questions[0]!.reward).toBe("10");
    expect(draftToContent(d)).toEqual(c);
    expect(draftProblems(d)).toEqual({});
  });

  it("names every problem by field path, like the database", () => {
    const d = contentToDraft(valid());
    d.themes[0]!.name = "";
    d.themes[3]!.description = " ";
    d.themes[9]!.questions[4]!.hint2 = "";
    d.themes[2]!.questions[1]!.reward = "0";
    d.themes[2]!.questions[2]!.reward = "12.5";
    d.themes[1]!.questions[0]!.question = "";
    d.themes[1]!.questions[0]!.hint1 = "";
    d.rules = ["ok", "", "ok"];
    expect(Object.keys(draftProblems(d)).sort()).toEqual(
      [
        "themes.A.name",
        "themes.D.description",
        "questions.J.5.hint2",
        "questions.C.2.reward",
        "questions.C.3.reward",
        "questions.B.1.question",
        "questions.B.1.hint1",
        "rules.2",
      ].sort(),
    );
    d.rules = [];
    expect(draftProblems(d)["rules"]).toBe("Add at least one rule.");
    // the same paths the database would report for the same content
    const dbPaths = contentProblems({ ...draftToContentLoose(d) });
    expect(dbPaths).toContain("themes.A.name");
    expect(dbPaths).toContain("rules");
  });

  it("accepts typed rewards with spaces around them and nothing else", () => {
    for (const ok of ["1", " 25 ", "999999"]) expect(rewardProblem(ok)).toBeNull();
    for (const bad of ["", "0", "01", "-3", "1e3", "2.0", "1 000", "1000000", "abc", "٣"]) {
      expect(rewardProblem(bad), bad).not.toBeNull();
    }
  });

  // PostgreSQL never sees a lone surrogate (its jsonb input refuses it, SQLSTATE 22P05), so the database check has no rule for it:
  // the API schema and the editor are the only gate, and it must be a field error rather than a server error.
  it.each([
    ["a lone high surrogate", (c: any) => (c.themes[3].name = "a\ud800b")],
    ["a lone low surrogate", (c: any) => (c.rules[1] = "x\udc00")],
  ])("%s is refused by the API schema and the editor", (_n, mutate) => {
    const c = clone(valid());
    mutate(c);
    expect(renewalContentSchema.safeParse(c).success).toBe(false);
    expect(Object.keys(draftProblems(contentToDraft(c))).length).toBeGreaterThan(0);
  });

  it("textProblem keeps multiline text and punctuation, rejects blanks, controls and over-length", () => {
    expect(textProblem("a\nb\r\nc\t“d”… 😀", 50)).toBeNull();
    expect(textProblem("   \n ", 50)).toBe("Required.");
    expect(textProblem("x".repeat(51), 50)).toMatch(/At most 50/);
    expect(textProblem("bad\u0000", 50)).not.toBeNull();
    expect(textProblem("😀".repeat(50), 50)).toBeNull(); // 50 characters, 100 UTF-16 units
    expect(textProblem("half \ud83d", 50)).not.toBeNull(); // an unpaired surrogate is not text
    expect(textProblem("\ude00 half", 50)).not.toBeNull();
  });
});

/** The draft as loosely typed content, so a wrong draft can be given to the database's checker. */
function draftToContentLoose(d: ReturnType<typeof contentToDraft>) {
  return {
    themes: d.themes.map((t) => ({
      ...t,
      questions: t.questions.map((q) => ({ ...q, reward: Number(q.reward) })),
    })),
    rules: d.rules,
  };
}

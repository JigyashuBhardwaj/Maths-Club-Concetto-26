import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import content from "../../content/concetto26/official-content.json";
import { build, validate } from "../../scripts/content/generate.mjs";
import { OFFICIAL_RULES, OFFICIAL_THEMES } from "@/lib/content/official-public";

const root = join(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const MIGRATION = "supabase/migrations/20261006000019_official_content.sql";

/**
 * B17: the official Concetto 26 content. content/concetto26/official-content.json is the ONE source; the migration and the
 * public TypeScript module are generated from it. These tests pin the inventory (10 / 50 / 100 / 8), the reward matrix of the
 * document, the id mappings, the generated files and the rule that no question, hint or reward reaches client code.
 */

// The document's reward column, question by question (D.2 = 60 is the owner-approved value for the blank cell).
const REWARDS: Record<string, number[]> = {
  A: [100, 100, 100, 100, 100],
  B: [70, 70, 90, 60, 100],
  C: [70, 80, 80, 90, 90],
  D: [100, 60, 90, 50, 90],
  E: [70, 80, 90, 60, 100],
  F: [70, 70, 90, 90, 100],
  G: [80, 90, 90, 50, 100],
  H: [70, 90, 90, 90, 100],
  I: [90, 100, 80, 80, 100],
  J: [80, 90, 70, 90, 90],
};

describe("inventory", () => {
  it("has 10 themes A-J, 50 questions (5 per theme), 100 hints and 8 rules", () => {
    expect(() => validate(content)).not.toThrow();
    expect(content.themes.map((t) => t.id)).toEqual([..."ABCDEFGHIJ"]);
    expect(content.questions).toHaveLength(50);
    expect(new Set(content.questions.map((q) => q.id)).size).toBe(50);
    for (const t of content.themes) {
      expect(content.questions.filter((q) => q.theme === t.id).map((q) => q.ordinal)).toEqual([
        1, 2, 3, 4, 5,
      ]);
    }
    expect(content.questions.flatMap((q) => [q.hint1, q.hint2])).toHaveLength(100);
    expect(content.rules.map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("lists the questions in document order with the ids A.1 ... J.5", () => {
    expect(content.questions.map((q) => q.id)).toEqual(
      [..."ABCDEFGHIJ"].flatMap((t) => [1, 2, 3, 4, 5].map((n) => `${t}.${n}`)),
    );
  });

  it("has no empty, truncated or placeholder text", () => {
    for (const t of content.themes) {
      expect(t.name.trim().length).toBeGreaterThan(5);
      expect(t.description.trim().length).toBeGreaterThan(10);
    }
    for (const q of content.questions) {
      for (const text of [q.question, q.hint1, q.hint2]) {
        expect(text.trim().length, q.id).toBeGreaterThan(30);
        expect(text, q.id).not.toMatch(/lorem ipsum|placeholder|Body of question|Hint [12] for /i);
        expect(text, q.id).not.toMatch(/�/); // no replacement character from a bad decode
      }
    }
    for (const r of content.rules) expect(r.text.length).toBeGreaterThan(40);
  });

  it("records the two owner-approved deviations from the document", () => {
    expect(content.approved_deviations.map((d) => d.where)).toEqual(["D.2 reward", "Rule 2"]);
    expect(content.rules[1]!.text).toContain("base time limit of 4 minutes");
    expect(content.rules[1]!.text).not.toContain("5 minutes");
  });

  it("keeps the cross-references of the document verbatim (C.2, D.4, D.5, F.2-F.5, H.2-H.3)", () => {
    // The document's own wording is kept as it is (its numbering of earlier questions is flagged in the report, not changed).
    const q = (id: string) => content.questions.find((x) => x.id === id)!.question;
    expect(q("C.2")).toContain("Using the value of a from Q3.1");
    expect(q("D.4")).toContain("Using the stopping point obtained in Q4.3");
    expect(q("D.5")).toContain("the stopping point from Q4.3");
    expect(q("F.2")).toContain("Using S = 5 from Question 1");
    expect(q("F.3")).toContain("Using K = 11 from Question 2");
    expect(q("F.4")).toContain("day a + b of the semester");
    expect(q("F.5")).toContain("equal to the answer from Question 4");
    expect(q("H.2")).toContain("original circle from Q9.1");
    expect(q("H.3")).toContain("velocities given in Q9.2");
  });

  it("keeps J.4 and J.5 as two distinct questions", () => {
    const j4 = content.questions.find((x) => x.id === "J.4")!;
    const j5 = content.questions.find((x) => x.id === "J.5")!;
    expect(j4.question).not.toBe(j5.question);
  });
});

describe("rewards", () => {
  it("match the document question by question (total 4230; no single global value)", () => {
    const got = Object.fromEntries(
      content.themes.map((t) => [
        t.id,
        content.questions.filter((q) => q.theme === t.id).map((q) => q.reward),
      ]),
    );
    expect(got).toEqual(REWARDS);
    const all = content.questions.map((q) => q.reward!);
    expect(all.reduce((a, b) => a + b, 0)).toBe(4230);
    expect(new Set(all).size).toBe(6); // 50, 60, 70, 80, 90, 100
    expect(content.questions.find((q) => q.id === "D.2")!.reward).toBe(60);
  });
});

describe("the generated files", () => {
  it("are exactly what the generator produces from the JSON (no drift)", async () => {
    for (const [path, text] of (await build()) as [string, string][]) {
      expect(readFileSync(path, "utf8") === text, path).toBe(true);
    }
  });

  it("the public module carries theme names, descriptions and the 8 rules - in the JSON's order and wording", () => {
    expect(OFFICIAL_THEMES.map((t) => ({ ...t }))).toEqual(
      content.themes.map((t) => ({ id: t.id, name: t.name, description: t.description })),
    );
    expect([...OFFICIAL_RULES]).toEqual(content.rules.map((r) => r.text));
    expect(OFFICIAL_RULES).toHaveLength(8);
  });

  it("the migration carries every theme, question, hint and reward of the JSON, each at the right database id", () => {
    const sql = read(MIGRATION);
    const lits = [...sql.matchAll(/\$c26\$([\s\S]*?)\$c26\$/g)].map((m) => m[1]);
    expect(lits).toHaveLength(20 + 50 + 100);
    const themeLits = lits.slice(0, 20);
    const questionLits = lits.slice(20, 70);
    const hintLits = lits.slice(70);
    content.themes.forEach((t, i) => {
      expect(themeLits[2 * i]).toBe(t.name);
      expect(themeLits[2 * i + 1]).toBe(t.description);
    });
    content.questions.forEach((q, i) => {
      expect(questionLits[i]).toBe(q.question);
      expect(hintLits[2 * i]).toBe(q.hint1); // hints.id = (question id - 1) * 2 + tier
      expect(hintLits[2 * i + 1]).toBe(q.hint2);
    });
    // the ids in the VALUES lists: themes 1..10, questions 1..50 with their reward, hints 1..100
    const ids = (re: RegExp) => [...sql.matchAll(re)].map((m) => Number(m[1]));
    expect(ids(/^ {4}\((\d+), \$c26\$/gm).length).toBe(160); // 10 themes + 50 questions + 100 hints
    const questionRows = [
      ...sql.matchAll(/^ {4}\((\d+), \$c26\$[\s\S]*?\$c26\$, (\d+|null::int)\)/gm),
    ];
    expect(questionRows).toHaveLength(50);
    questionRows.forEach((m, i) => {
      expect(Number(m[1])).toBe(i + 1);
      expect(Number(m[2])).toBe(content.questions[i]!.reward);
    });
  });

  it("the migration updates content columns only, and installs rows only into an empty database", () => {
    const sql = read(MIGRATION).replace(/\$c26\$[\s\S]*?\$c26\$/g, "''");
    const sets = [...sql.matchAll(/\bset ([^\n]+)/g)].map((m) => m[1]);
    expect(sets).toEqual([
      "name = c.name, description = c.description",
      "body_md = c.body_md, reward_coins = c.reward_coins",
      "body_md = c.body_md",
    ]);
    // the only tables it writes to: the three content tables, its own temporary tables, and the audit log
    const inserted = [...sql.matchAll(/\binsert into (\w+)/g)].map((m) => m[1]);
    expect(inserted.sort()).toEqual(
      [
        "audit_events",
        "c26_hints",
        "c26_questions",
        "c26_themes",
        "hints",
        "questions",
        "themes",
      ].sort(),
    );
    expect(sql).not.toMatch(/\b(delete|truncate|alter)\b/i);
    expect([...sql.matchAll(/\bdrop (\w+) (\w+)/g)].map((m) => `${m[1]} ${m[2]}`).sort()).toEqual([
      "table c26_hints",
      "table c26_questions",
      "table c26_themes",
    ]);
    expect(sql).not.toMatch(/\bupdate\s+(teams|team_|submissions|ledger|sessions|answer)/i);
    // the install branch exists, and is taken only when the themes table is empty; an update is audited, an install is not
    expect(sql).toMatch(/if v_themes = 0 then\s+v_mode := 'installed'/);
    expect(sql).toMatch(/if v_mode = 'updated' and n_themes \+ n_questions \+ n_hints > 0 then/);
    // anything but an empty database or exactly 10 / 50 / 100 rows aborts
    expect(sql).toMatch(
      /v_themes = 0 and v_questions = 0 and v_hints = 0\) or \(v_themes = 10 and v_questions = 50 and v_hints = 100/,
    );
  });
});

describe("no hidden content in client code", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css|json)$/.test(f) ? [p] : [];
    });

  it("no question, hint or reward text exists anywhere under src/", () => {
    const sources = files(join(root, "src")).map((p) => readFileSync(p, "utf8"));
    for (const q of content.questions) {
      // distinctive chunks, not whole strings: a hint or question quoted in part would still be a leak
      for (const text of [q.question, q.hint1, q.hint2]) {
        const probe = text.replace(/\s+/g, " ").slice(0, 60);
        expect(
          sources.some((s) => s.replace(/\s+/g, " ").includes(probe)),
          `${q.id}: ${probe}`,
        ).toBe(false);
      }
    }
  });

  it("the public module is the only generated file in src/ and holds themes and rules only", () => {
    const ts = read("src/lib/content/official-public.ts");
    expect(ts).toMatch(/OFFICIAL_THEMES/);
    expect(ts).toMatch(/OFFICIAL_RULES/);
    expect(ts).not.toMatch(/\bhint[12]?\b|\breward\b/i);
  });
});

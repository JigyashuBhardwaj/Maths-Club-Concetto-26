// Static guards for the database foundation (Patch B). They run without a database; the behavioural
// constraint tests live in supabase/tests and run with `npm run db:verify` against a scratch PostgreSQL.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  INITIAL_COINS,
  QUESTIONS_PER_THEME,
  TEAM_TIMER_MINUTES,
  TEAM_TIMER_SECONDS,
  THEME_COUNT,
  TOTAL_QUESTIONS,
  UFM_DISQUALIFY_SCORE,
  UFM_RESET_FLOOR_SCORE,
} from "@/lib/contracts/competition";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const migrationNames = readdirSync(join(root, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const migrations = migrationNames.map((f) => read(`supabase/migrations/${f}`)).join("\n");
const seed = read("supabase/seed.sql");

// Paths are always POSIX-style ("tests/unit/x.ts"), also on Windows, so they can be compared with the
// allow/skip lists below (path.join/relative would return backslashes there).
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const rel = join(dir, name).replace(/\\/g, "/");
    if (["node_modules", ".next", "playwright-report", "test-results"].includes(name)) continue;
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

describe("migrations", () => {
  it("are ordered, uniquely numbered and complete", () => {
    expect(migrationNames).toHaveLength(19);
    for (const f of migrationNames) expect(f).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
    expect(new Set(migrationNames.map((f) => f.slice(0, 14))).size).toBe(migrationNames.length);
    expect(migrationNames[0]).toContain("extensions_enums_clock");
    expect(migrationNames.at(-11)).toContain("security_rls");
    expect(migrationNames.at(-10)).toContain("buy_time_options");
    expect(migrationNames.at(-9)).toContain("auth_functions");
    expect(migrationNames.at(-8)).toContain("runtime_engine");
    expect(migrationNames.at(-7)).toContain("provisioning");
    expect(migrationNames.at(-6)).toContain("gameplay_engine");
    expect(migrationNames.at(-5)).toContain("admin_matrix");
    expect(migrationNames.at(-4)).toContain("timer_14400_and_finalization");
    expect(migrationNames.at(-3)).toContain("economy_and_final_submit");
    expect(migrationNames.at(-2)).toContain("scoring_leaderboard_penalty");
    expect(migrationNames.at(-1)).toContain("official_content");
  });

  // B9 (auth_functions), B10 (runtime_engine), B12 (provisioning), B13 (gameplay_engine), B14 (admin_matrix) and B15
  // (timer_14400_and_finalization, economy_and_final_submit) and B16 (scoring_leaderboard_penalty): each function is explicitly revoked from PUBLIC and granted to
  // service_role only, and every SECURITY DEFINER function pins its search_path.
  for (const [suffix, minFunctions, minDefiners] of [
    ["auth_functions", 11, 3],
    ["runtime_engine", 12, 3],
    ["provisioning", 4, 3],
    ["gameplay_engine", 12, 3],
    ["admin_matrix", 4, 2],
    ["timer_14400_and_finalization", 4, 3],
    ["economy_and_final_submit", 5, 4],
    ["scoring_leaderboard_penalty", 10, 6],
  ] as const) {
    it(`restrict every ${suffix} function explicitly: revoke from PUBLIC/anon/authenticated, grant to service_role`, () => {
      const file = migrationNames.find((f) => f.includes(suffix)) ?? "";
      const sql = read(`supabase/migrations/${file}`);
      const fns = [
        ...sql.matchAll(/^create (?:or replace )?function ((?:app|public)\.[a-z_]+)\s*\(/gm),
      ].map((m) => m[1] ?? "");
      expect(fns.length).toBeGreaterThanOrEqual(minFunctions);
      for (const name of fns) {
        const esc = name.replace(".", "\\.");
        expect(sql, `${name} revoke`).toMatch(
          new RegExp(
            `revoke all on function ${esc}\\([^)]*\\)\\s+from public, anon, authenticated;`,
          ),
        );
        expect(sql, `${name} grant`).toMatch(
          new RegExp(`grant execute on function ${esc}\\([^)]*\\)\\s+to service_role;`),
        );
      }
      expect(sql).not.toMatch(/grant [^;]*\bto (anon|authenticated|public)\b/i);
      const code = sql.replace(/^--.*$/gm, "");
      const defs = code.match(/security definer/gi)?.length ?? 0;
      expect(defs).toBeGreaterThanOrEqual(minDefiners);
      expect(
        code.match(/security definer\s+set search_path = pg_catalog, [^\n]*pg_temp/g)?.length,
      ).toBe(defs);
    });
  }

  it("enable and force RLS, and grant the browser roles nothing", () => {
    expect(migrations).toContain("enable row level security");
    expect(migrations).toContain("force row level security");
    expect(migrations).toMatch(
      /revoke all on all tables\s+in schema public from public, anon, authenticated/,
    );
    expect(migrations).not.toMatch(/create policy/i);
    expect(migrations).not.toMatch(/grant [^;]*\bto (anon|authenticated|public)\b/i);
  });

  it("never cascade deletes and never store plaintext credentials", () => {
    expect(migrations).not.toMatch(/on delete cascade/i);
    expect(migrations).not.toMatch(/\b(plaintext_password|service_key)\b/i);
  });
});

describe("the database agrees with the TypeScript contract", () => {
  it("competition shape: 10 themes x 5 questions = 50", () => {
    expect(migrations).toMatch(
      new RegExp(`id\\s+smallint primary key check \\(id between 1 and ${THEME_COUNT}\\)`),
    );
    expect(migrations).toContain(`check (id between 1 and ${TOTAL_QUESTIONS})`);
    expect(migrations).toContain(`check (ordinal between 1 and ${QUESTIONS_PER_THEME})`);
    expect(migrations).toContain("check (code between 'A' and 'J')");
    expect(migrations).toContain(`id = (theme_id - 1) * ${QUESTIONS_PER_THEME} + ordinal`);
  });

  it("Ultimate Team Timer is 14400 s / 240 min from B15; teams that started earlier keep 7200 s", () => {
    expect(TEAM_TIMER_SECONDS).toBe(14400);
    expect(TEAM_TIMER_MINUTES).toBe(240);
    // The migrations are append-only: B1 created the 7200 default and B15 (migration 16) moves it forward.
    const b15 = read(
      `supabase/migrations/${migrationNames.find((f) => f.includes("timer_14400_and_finalization"))}`,
    );
    expect(b15).toContain(
      `alter table competition alter column ultimate_seconds set default ${TEAM_TIMER_SECONDS};`,
    );
    expect(b15).toContain(`check (ultimate_seconds = ${TEAM_TIMER_SECONDS})`);
    expect(b15).toContain("drop constraint competition_ultimate_locked_7200");
    // started teams are backfilled with the allowance they were actually given, and ONLY started teams
    expect(b15).toContain("update teams set timer_seconds = 7200 where started_at is not null;");
    expect(b15).toContain(
      "check ((timer_seconds is not null) = (started_at is not null) and (timer_seconds is null or timer_seconds > 0))",
    );
    expect(b15).toContain("check (final_minutes_taken is null or final_minutes_taken >= 0)");
    // the migration's own top-level statements (function bodies excluded: start_team_competition legitimately sets
    // the window of a team that is starting) must never rewrite a started team's window
    const statements = b15.replace(/\$\$[\s\S]*?\$\$/g, "").replace(/^--.*$/gm, "");
    expect(statements).not.toMatch(/update teams[^;]*\bset\b[^;]*\b(started_at|ends_at)\s*=/i);
  });

  it("coins and UFM constants match", () => {
    expect(migrations).toContain(
      `initial_coins               int  not null default ${INITIAL_COINS}`,
    );
    expect(migrations).toContain(
      `reset_floor_score           int  not null default ${UFM_RESET_FLOOR_SCORE}`,
    );
    expect(migrations).toContain(
      `disqualified_score          int  not null default ${UFM_DISQUALIFY_SCORE}`,
    );
    expect(migrations).toContain("score_override = -1201");
  });
});

describe("seed", () => {
  it("creates configuration and content only, never credentials", () => {
    expect(seed).toMatch(/generate_series\(1, 10\)/);
    expect(seed).not.toMatch(
      /insert into (staff_users|teams|team_members|sessions|coin_transactions)/i,
    );
    expect(seed).not.toMatch(/password|secret|token/i);
    expect(seed.match(/DEV PLACEHOLDER/g)?.length).toBeGreaterThanOrEqual(3);
    expect(seed).not.toMatch(/theme k|theme l|'K'|'L'/i);
  });
});

describe("no stale 2-hour / 12-theme assumptions in architecture, schema, source or tests", () => {
  // the guard itself, and the DB test that asserts the old values are NOT in the schema
  const SKIP = new Set([
    "tests/unit/db-foundation.test.ts",
    "supabase/tests/60_ufm_timer_audit.test.sql",
    "package-lock.json",
  ]);
  const scanned = [
    ...walk("docs"),
    ...walk("supabase"),
    ...walk("src"),
    ...walk("tests"),
    "README.md",
  ]
    .filter((f) => /\.(md|sql|ts|tsx|mjs|css)$/.test(f))
    .filter((f) => !SKIP.has(f));

  const offenders = (re: RegExp) => scanned.filter((f) => re.test(read(f)));

  it("has no hard-coded Ultimate Timer of 2 h in the application source", () => {
    // B15 moved the allowance to 4 h and made it a per-team value the server sends (`duration_seconds`). A screen that
    // typed "2 hours" or 7200 would silently disagree with the data, so the application code must not contain them.
    // (Migrations, SQL tests, docs and tests legitimately mention the legacy 7200 s allowance.)
    const timer = /\b7[,_ ]?200\b|\b2[- ]?hours?\b|\b2 ?hr\b|\b120 ?min/i;
    expect(offenders(timer).filter((f) => f.startsWith("src/"))).toEqual([]);
  });

  it("keeps prices, rewards and durations out of the UI: they are read from the server's data", () => {
    // These were the placeholder constants of the pre-B15 question page; the data (hints.cost,
    // question_buy_time_options, questions.reward_coins / time_limit_seconds) is now the only source.
    const constants = /HINT_COSTS|BUY_TIME_OPTIONS|REWARD_COINS|QUESTION_SECONDS|PLACEHOLDER_HINT/;
    expect(offenders(constants).filter((f) => f.startsWith("src/"))).toEqual([]);
    for (const f of [
      "src/components/question/buy-time-dialog.tsx",
      "src/components/question/hint-dialogs.tsx",
      "src/components/home/final-submit-dialog.tsx",
    ]) {
      // no coin amount or minute count literal next to a unit in the economy components
      expect(read(f), f).not.toMatch(
        /\b(20|40|80|100|480|240|120)\s*(coins?|mins?|minutes|secs?|seconds)/i,
      );
    }
  });

  it("has no 12-theme / 60-question / 13-ticket / K / L assumptions", () => {
    const shape =
      /12 themes|60 questions|13 tickets|\[A[–-]L\]|'A'\.\.'L'|between 1 and 12|1\.\.60|theme [kl]\b/i;
    // the only allowed mentions are negative assertions in the Participant Home / contract tests
    const allowed = new Set([
      "supabase/tests/20_seed.test.sql",
      "tests/unit/home-lib.test.ts",
      "tests/component/home.test.tsx",
      "tests/e2e/participant-home.spec.ts",
      "tests/unit/contracts.test.ts",
    ]);
    expect(offenders(shape).filter((f) => !allowed.has(f))).toEqual([]);
  });
});

describe("evidence copy", () => {
  it("docs/evidence/schema.sql is the concatenation of the migrations", async () => {
    expect(existsSync(join(root, "docs/evidence/schema.sql"))).toBe(true);
    const { buildEvidence } = await import("../../scripts/db-evidence.mjs");
    expect(read("docs/evidence/schema.sql")).toBe(buildEvidence());
  });
});

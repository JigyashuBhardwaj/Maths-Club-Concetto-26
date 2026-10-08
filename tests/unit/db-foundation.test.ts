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
    expect(migrationNames).toHaveLength(15);
    for (const f of migrationNames) expect(f).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
    expect(new Set(migrationNames.map((f) => f.slice(0, 14))).size).toBe(migrationNames.length);
    expect(migrationNames[0]).toContain("extensions_enums_clock");
    expect(migrationNames.at(-7)).toContain("security_rls");
    expect(migrationNames.at(-6)).toContain("buy_time_options");
    expect(migrationNames.at(-5)).toContain("auth_functions");
    expect(migrationNames.at(-4)).toContain("runtime_engine");
    expect(migrationNames.at(-3)).toContain("provisioning");
    expect(migrationNames.at(-2)).toContain("gameplay_engine");
    expect(migrationNames.at(-1)).toContain("admin_matrix");
  });

  // B9 (auth_functions), B10 (runtime_engine), B12 (provisioning), B13 (gameplay_engine) and B14 (admin_matrix): each function is explicitly revoked from PUBLIC and granted to
  // service_role only, and every SECURITY DEFINER function pins its search_path.
  for (const [suffix, minFunctions, minDefiners] of [
    ["auth_functions", 11, 3],
    ["runtime_engine", 12, 3],
    ["provisioning", 4, 3],
    ["gameplay_engine", 12, 3],
    ["admin_matrix", 4, 2],
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

  it("Ultimate Team Timer is 7200 s / 120 min (never 14400 s / 240 min)", () => {
    expect(TEAM_TIMER_SECONDS).toBe(7200);
    expect(TEAM_TIMER_MINUTES).toBe(120);
    expect(migrations).toContain(
      `ultimate_seconds            int  not null default ${TEAM_TIMER_SECONDS}`,
    );
    expect(migrations).toContain(`check (ultimate_seconds = ${TEAM_TIMER_SECONDS})`);
    expect(migrations).toContain(
      "check (final_minutes_taken is null or final_minutes_taken between 0 and 120)",
    );
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

describe("no stale 4-hour / 12-theme assumptions in architecture, schema, source or tests", () => {
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

  it("has no Ultimate Timer of 4 h / 14,400 s / 240 min", () => {
    // `formatDuration(14_400)` in tests/unit/home-lib.test.ts is a pure formatter check, not the competition timer.
    const timer =
      /14[,_ ]?400(?! *\)|"04)|4[- ]?hours?\b|\b4 ?hr\b|240 - floor|\[0, 240\]|0–240|240:00|ultimate[^\n]{0,40}240/i;
    expect(offenders(timer)).toEqual([]);
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

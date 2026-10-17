import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Supabase loads and enables the `safeupdate` extension (pg-safeupdate) for the roles behind its Data API
 * (`anon`, `authenticator`, `authenticated`). Every database function here is reached through that API as `service_role`, so
 * a bare `UPDATE t SET ...;` or `DELETE FROM t;` inside a function body is refused there with
 * `ERROR: UPDATE requires a WHERE clause` (SQLSTATE 21000), which the API maps to a generic 503. A plain PostgreSQL (the
 * scratch database of `npm run db:verify`, which connects as a superuser) accepts the statement, so the SQL tests cannot
 * see it. This test is the static guard: the FINAL definition of every function must give each UPDATE/DELETE a WHERE clause
 * (write `where true` when every row is meant).
 *
 * Regression for the production 503 of `POST /api/super/competition/status`: migration 14 ended `set_competition_status` with
 * `update teams set state_version = state_version + 1;`.
 */
const dir = resolve(import.meta.dirname, "../../supabase/migrations");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const stripComments = (sql: string): string =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

/** `create [or replace] function <name>(<args>) ... as $tag$ <body> $tag$` — the latest definition of each signature wins. */
function finalFunctionBodies(): Map<string, { file: string; body: string }> {
  const out = new Map<string, { file: string; body: string }>();
  for (const file of files) {
    const sql = stripComments(readFileSync(join(dir, file), "utf8"));
    const re =
      /create\s+(?:or\s+replace\s+)?function\s+([\w."]+)\s*\(([^)]*)\)[\s\S]*?\bas\s+(\$[\w]*\$)([\s\S]*?)\3/gi;
    for (const m of sql.matchAll(re)) {
      const signature = `${m[1]!.toLowerCase()}(${m[2]!.replace(/\s+/g, " ").trim().toLowerCase()})`;
      out.set(signature, { file, body: m[4]! });
    }
  }
  return out;
}

const DML =
  /(?<!do\s)\b(update\s+(?:only\s+)?[\w."]+(?:\s+(?:as\s+)?\w+)?\s+set\b[^;]*;|delete\s+from\s+(?:only\s+)?[\w."]+[^;]*;)/gi;

/** The UPDATE/DELETE statements of a function body that have no WHERE clause. */
export function unconditionalDml(body: string): string[] {
  return [...body.matchAll(DML)]
    .map((m) => m[1]!.replace(/\s+/g, " ").trim())
    .filter((statement) => !/\bwhere\b/i.test(statement));
}

describe("database functions under pg-safeupdate (Supabase Data API)", () => {
  it("the detector flags a bare UPDATE and DELETE and accepts WHERE true", () => {
    expect(unconditionalDml("update teams set state_version = state_version + 1;")).toHaveLength(1);
    expect(unconditionalDml("delete from some_table;")).toHaveLength(1);
    expect(
      unconditionalDml("update teams set state_version = state_version + 1 where true;"),
    ).toEqual([]);
    expect(unconditionalDml("update a set x = 1 from b where b.id = a.id;")).toEqual([]);
    expect(
      unconditionalDml("insert into t values (1) on conflict (id) do update set n = t.n + 1;"),
    ).toEqual([]);
    expect(unconditionalDml("select 1 from t for update;")).toEqual([]);
  });

  it("finds the functions (the scan is not vacuous)", () => {
    const bodies = finalFunctionBodies();
    expect(bodies.size).toBeGreaterThan(60);
    const status = [...bodies.entries()].find(([sig]) =>
      sig.startsWith("public.set_competition_status("),
    );
    expect(status).toBeDefined();
    expect(status![1].body).toContain("update competition set status");
  });

  it("no function's final definition runs an UPDATE or DELETE without a WHERE clause", () => {
    const offenders = [...finalFunctionBodies().entries()].flatMap(([signature, { file, body }]) =>
      unconditionalDml(body).map((statement) => `${file} ${signature}: ${statement}`),
    );
    expect(offenders).toEqual([]);
  });
});

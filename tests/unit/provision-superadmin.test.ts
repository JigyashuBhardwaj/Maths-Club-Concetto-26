import { describe, expect, it } from "vitest";

import * as script from "../../scripts/provision-superadmin.mjs";

const ok = { username: "root.admin", displayName: "Chief", password: "correct-horse-1" };

describe("provision-superadmin helpers", () => {
  it("validates username, display name and password", () => {
    expect(script.validateInputs(ok)).toBeNull();
    expect(script.validateInputs({ ...ok, username: "ab" })).toMatch(/Username/);
    expect(script.validateInputs({ ...ok, username: "bad name!" })).toMatch(/Username/);
    expect(script.validateInputs({ ...ok, displayName: "   " })).toMatch(/Display name/);
    expect(script.validateInputs({ ...ok, password: "short" })).toMatch(/at least 10/);
    expect(script.validateInputs({ ...ok, password: "é".repeat(37) })).toMatch(/at most 72 bytes/);
    expect(script.validateInputs({ ...ok, password: "é".repeat(36) })).toBeNull();
  });

  it("dollar-quotes values with a tag that cannot occur inside them", () => {
    const nasty = "a$b$q1$$ ' \" \\ ;-- $qdeadbeef$";
    const quoted: string = script.dollarQuote(nasty);
    const tag = /^\$(q[0-9a-f]{12})\$/.exec(quoted)?.[1];
    expect(tag).toBeDefined();
    expect(quoted).toBe(`$${tag}$${nasty}$${tag}$`);
    expect(nasty).not.toContain(`$${tag}`);
  });

  it("builds one SELECT and never a statement that returns the hash", () => {
    const sql: string = script.buildSql(ok);
    expect(sql).toMatch(/^select app\.provision_superadmin\(/);
    expect(sql.trim().split("\n")).toHaveLength(1);
    expect(sql).not.toMatch(/password_hash/);
  });

  it("passes the connection to psql through PG* variables, not argv", () => {
    const env = script.connectionEnv(
      "postgres://own%40er:p%40ss@127.0.0.1:5439/mydb?sslmode=require",
      { PGHOST: "stale", PATH: "/bin" } as unknown as NodeJS.ProcessEnv,
    );
    expect(env).toMatchObject({
      PGHOST: "127.0.0.1",
      PGPORT: "5439",
      PGUSER: "own@er",
      PGPASSWORD: "p@ss",
      PGDATABASE: "mydb",
      PGSSLMODE: "require",
      PATH: "/bin",
    });
    expect(() => script.connectionEnv("mysql://x/y")).toThrow();
  });

  it("maps database failures to safe messages that never echo input", () => {
    expect(script.describeFailure("ERROR:  SUPER_ADMIN_EXISTS")).toMatchObject({ code: 3 });
    expect(script.describeFailure("ERROR: INVALID_PASSWORD")).toMatchObject({ code: 4 });
    expect(script.describeFailure('ERROR: schema "app" does not exist')).toMatchObject({ code: 5 });
    const unknown = script.describeFailure("ERROR: boom with hunter2-secret");
    expect(unknown.message).not.toContain("hunter2");
  });
});

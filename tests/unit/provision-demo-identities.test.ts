import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import * as script from "../../scripts/provision-demo-identities.mjs";

const none = {
  super: 1,
  competition: "SETUP",
  adminExists: false,
  teamsExisting: new Set<string>(),
  foreignTeams: 0,
};

describe("parseArgs", () => {
  it("defaults to one team and nothing else", () => {
    expect(script.parseArgs([])).toEqual({
      opts: { teams: 1, resetPasswords: false, openCompetition: false, yes: false },
    });
  });
  it("reads every option", () => {
    expect(
      script.parseArgs(["--teams", "3", "--reset-passwords", "--open-competition", "--yes"]),
    ).toEqual({
      opts: { teams: 3, resetPasswords: true, openCompetition: true, yes: true },
    });
  });
  it.each([["--teams", "0"], ["--teams", "5"], ["--teams", "x"], ["--teams"], ["--wat"]])(
    "rejects %s",
    (...argv) => {
      expect(script.parseArgs(argv)).toHaveProperty("error");
    },
  );
});

describe("identities", () => {
  it("are clearly demo identities with globally unique, normalised admission numbers", () => {
    const seen = new Set<string>();
    for (let n = 1; n <= script.MAX_TEAMS; n += 1) {
      const t = script.teamIdentity(n);
      expect(t.loginId).toMatch(/^demo_team_\d\d$/);
      expect(t.code).toMatch(/^DEMO_\d\d$/);
      expect(t.admissionNumbers).toHaveLength(4);
      for (const a of t.admissionNumbers) {
        expect(a).toBe(a.trim().toUpperCase());
        expect(seen.has(a)).toBe(false);
        seen.add(a);
      }
    }
    expect(script.ADMIN_USERNAME).toBe("demo_admin");
  });
});

describe("passwords", () => {
  it("are random, long and URL-safe", () => {
    const all = new Set(Array.from({ length: 200 }, () => script.generatePassword()));
    expect(all.size).toBe(200);
    for (const p of all) expect(p).toMatch(/^[A-Za-z0-9_-]{20}$/);
  });
});

describe("planWork", () => {
  const fixed = (() => {
    let i = 0;
    return () => `pw-${(i += 1)}`;
  })();

  it("creates everything on an empty database", () => {
    const plan = script.planWork({ teams: 2, resetPasswords: false }, none, fixed);
    expect(plan.admin).toMatchObject({ action: "created" });
    expect(
      plan.teams.map((t: { loginId: string; action: string }) => [t.loginId, t.action]),
    ).toEqual([
      ["demo_team_01", "created"],
      ["demo_team_02", "created"],
    ]);
  });

  it("leaves existing identities alone (and shows no password for them) unless asked to reset", () => {
    const existing = { ...none, adminExists: true, teamsExisting: new Set(["demo_team_01"]) };
    const plan = script.planWork({ teams: 2, resetPasswords: false }, existing, fixed);
    expect(plan.admin).toBeNull();
    expect(plan.teams.map((t: { loginId: string }) => t.loginId)).toEqual(["demo_team_02"]);
    const reset = script.planWork({ teams: 2, resetPasswords: true }, existing, fixed);
    expect(reset.admin).toMatchObject({ action: "reset" });
    expect(reset.teams.map((t: { action: string }) => t.action)).toEqual(["reset", "created"]);
  });
});

describe("parseInspect", () => {
  it("reads the inspection lines", () => {
    const state = script.parseInspect(
      "super|1\ncompetition|RUNNING\nstaff|demo_admin\nteam|demo_team_01\nteam|demo_team_02\nforeign_teams|3\n",
    );
    expect(state).toEqual({
      super: 1,
      competition: "RUNNING",
      adminExists: true,
      teamsExisting: new Set(["demo_team_01", "demo_team_02"]),
      foreignTeams: 3,
    });
  });
});

describe("buildProvisionSql", () => {
  const plan = script.planWork({ teams: 1, resetPasswords: false }, none, () => "S3cr3t-$q1$-pw");
  const sql: string = script.buildProvisionSql(plan);

  it("is one transaction that hashes inside the database and never reads a hash back", () => {
    expect(sql.startsWith("begin;")).toBe(true);
    expect(sql.trim().endsWith("commit;")).toBe(true);
    expect(sql).toContain("app.hash_password(");
    expect(sql).not.toMatch(/select[^;]*password_hash/i);
    expect(sql).not.toMatch(/returning[^;]*password_hash/i);
  });

  it("dollar-quotes passwords with a tag that cannot occur inside them", () => {
    const quoted = /app\.hash_password\((\$q[0-9a-f]{12}\$)S3cr3t-\$q1\$-pw\1\)/.exec(sql);
    expect(quoted).not.toBeNull();
  });

  it("creates the admin under the Super Admin, the team with the configured initial coins and ledger row, and four members", () => {
    expect(sql).toContain("from staff_users s where s.role = 'SUPER_ADMIN'");
    expect(sql).toContain("c.initial_coins");
    expect(sql).toContain("'INITIAL_GRANT'");
    expect(sql).toContain("generate_series(1, 4)");
  });

  it("uses an UPDATE (not an INSERT) to reset existing identities", () => {
    const existing = { ...none, adminExists: true, teamsExisting: new Set(["demo_team_01"]) };
    const reset: string = script.buildProvisionSql(
      script.planWork({ teams: 1, resetPasswords: true }, existing, () => "x"),
    );
    expect(reset).not.toMatch(/insert into/i);
    expect(reset.match(/update (staff_users|teams) set password_hash/g)).toHaveLength(2);
  });
});

describe("formatReport", () => {
  it("prints each password once, and says so; never mentions a hash", () => {
    const plan = script.planWork(
      { teams: 1, resetPasswords: false },
      none,
      () => "ONLY-ONCE-0123456789",
    );
    const text: string = script.formatReport(plan, { competitionStatus: "SETUP", opened: false });
    expect(text.match(/ONLY-ONCE-0123456789/g)).toHaveLength(2); // admin and team each have their own line
    expect(text).toMatch(/shown ONCE/);
    expect(text).not.toMatch(/hash/i);
    expect(text).toMatch(/--open-competition/);
  });
  it("does not nag about opening when the competition is already open", () => {
    const text: string = script.formatReport(
      { admin: null, teams: [] },
      { competitionStatus: "RUNNING", opened: false },
    );
    expect(text).not.toMatch(/--open-competition/);
    expect(text).toMatch(/already exist/);
  });
});

describe("describeFailure", () => {
  it("never forwards raw database text", () => {
    expect(script.describeFailure("ERROR: SECRET-VALUE COMPETITION_NOT_READY")).toMatch(
      /cannot open yet/,
    );
    expect(script.describeFailure("ERROR: INVALID_COMPETITION_TRANSITION")).toMatch(
      /not in a state/,
    );
    expect(script.describeFailure("ERROR: something with the password hunter2")).not.toContain(
      "hunter2",
    );
  });
});

describe("the command", () => {
  const run = (env: Record<string, string>, args: string[] = ["--yes"]) =>
    spawnSync(process.execPath, ["scripts/provision-demo-identities.mjs", ...args], {
      env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    });

  it("needs PROVISION_DATABASE_URL", () => {
    const r = run({});
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/PROVISION_DATABASE_URL/);
  });
  it("refuses a non-local database unless explicitly allowed", () => {
    const r = run({ PROVISION_DATABASE_URL: "postgres://u:p@db.example.com:5432/x" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/refusing non-local host/);
    expect(r.stderr + r.stdout).not.toContain(":p@");
  });
  it("refuses to run when APP_ENV is production", () => {
    const r = run({ PROVISION_DATABASE_URL: "postgres://u@127.0.0.1/x", APP_ENV: "production" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/production/);
  });
  it("rejects a bad option before touching anything", () => {
    const r = run({ PROVISION_DATABASE_URL: "postgres://u@127.0.0.1/x" }, ["--teams", "9"]);
    expect(r.status).toBe(2);
  });
});

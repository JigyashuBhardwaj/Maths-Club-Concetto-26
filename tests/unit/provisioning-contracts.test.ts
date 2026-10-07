import { describe, expect, it } from "vitest";

import {
  adminTeamsResultSchema,
  createAdminResultSchema,
  createAdminSchema,
  createTeamResultSchema,
  createTeamSchema,
  leaderboardResultSchema,
} from "@/lib/contracts/provisioning";

const admin = {
  username: "alice.admin",
  password: "correct horse",
  confirmPassword: "correct horse",
};
const team = {
  teamCode: "t1",
  name: "The Euclids",
  loginId: "euclids",
  password: "pa55word!",
  confirmPassword: "pa55word!",
  admissionNos: ["adm1", "adm2", "adm3", "adm4"],
};
const issuePaths = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  (r.error?.issues ?? []).map((i) => i.path.join("."));

describe("createAdminSchema", () => {
  it("accepts a valid body and trims the username", () => {
    const r = createAdminSchema.parse({ ...admin, username: "  alice.admin " });
    expect(r.username).toBe("alice.admin");
  });

  it.each([
    ["short username", { username: "ab" }, "username"],
    ["bad characters", { username: "al ice" }, "username"],
    ["short password", { password: "short", confirmPassword: "short" }, "password"],
    [
      "password over 72 bytes",
      { password: "é".repeat(37), confirmPassword: "é".repeat(37) },
      "password",
    ],
    ["mismatch", { confirmPassword: "different!!" }, "confirmPassword"],
  ])("rejects %s", (_n, patch, path) => {
    const r = createAdminSchema.safeParse({ ...admin, ...patch });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toContain(path);
  });

  it.each(["role", "adminId", "isActive", "createdBy"])("rejects the unknown field %s", (k) => {
    expect(createAdminSchema.safeParse({ ...admin, [k]: "x" }).success).toBe(false);
  });
});

describe("createTeamSchema", () => {
  it("accepts a valid body", () => {
    expect(createTeamSchema.safeParse(team).success).toBe(true);
  });

  it.each(["adminId", "admin_id", "coins", "status", "role", "initialCoins"])(
    "has no field %s: the owner, balance and state are decided by the database",
    (k) => {
      expect(createTeamSchema.safeParse({ ...team, [k]: 1 }).success).toBe(false);
    },
  );

  it("requires exactly four admission numbers", () => {
    expect(createTeamSchema.safeParse({ ...team, admissionNos: ["a1", "a2", "a3"] }).success).toBe(
      false,
    );
    expect(
      createTeamSchema.safeParse({ ...team, admissionNos: ["a1", "a2", "a3", "a4", "a5"] }).success,
    ).toBe(false);
  });

  it("reports the member SLOT (1-based) of a bad or duplicate admission number", () => {
    const bad = createTeamSchema.safeParse({ ...team, admissionNos: ["a1", "a2", "", "a4"] });
    expect(issuePaths(bad)).toEqual(["admissionNos.3"]);
    const dup = createTeamSchema.safeParse({ ...team, admissionNos: ["a1", "A1 ", "a3", "a4"] });
    expect(issuePaths(dup)).toEqual(["admissionNos.2"]);
  });

  it("flags a mismatch on confirmPassword and a password equal to the Team ID or Login ID", () => {
    expect(issuePaths(createTeamSchema.safeParse({ ...team, confirmPassword: "nope" }))).toEqual([
      "confirmPassword",
    ]);
    const same = createTeamSchema.safeParse({
      ...team,
      teamCode: "TEAMCODE1",
      password: "teamcode1",
      confirmPassword: "teamcode1",
    });
    expect(issuePaths(same)).toEqual(["password"]);
  });

  it("rejects a name with control characters or over 100 characters", () => {
    expect(createTeamSchema.safeParse({ ...team, name: "a\u0007b" }).success).toBe(false);
    expect(createTeamSchema.safeParse({ ...team, name: "x".repeat(101) }).success).toBe(false);
    expect(createTeamSchema.safeParse({ ...team, name: "   " }).success).toBe(false);
  });

  it("rejects a team code that is too long or starts with a symbol", () => {
    expect(createTeamSchema.safeParse({ ...team, teamCode: "A".repeat(17) }).success).toBe(false);
    expect(createTeamSchema.safeParse({ ...team, teamCode: "-A" }).success).toBe(false);
  });
});

describe("result schemas are whitelists", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  it("strips a hash or token added to a database result", () => {
    const a = createAdminResultSchema.parse({
      replayed: false,
      admin: {
        id,
        username: "a",
        role: "ADMIN",
        is_active: true,
        created_at: 1,
        password_hash: "$2a$x",
      },
    });
    expect(JSON.stringify(a)).not.toContain("$2a$");
    const t = createTeamResultSchema.parse({
      replayed: true,
      team: {
        id,
        team_code: "T1",
        name: "n",
        login_id: "l",
        status: "NOT_STARTED",
        coins: 500,
        member_count: 4,
        created_at: 1,
        password_hash: "$2a$x",
      },
    });
    expect(t.team).not.toHaveProperty("password_hash");
    expect(adminTeamsResultSchema.safeParse({ teams: [] }).success).toBe(true);
  });

  it("only accepts an ADMIN role and a sane leaderboard", () => {
    expect(
      createAdminResultSchema.safeParse({
        replayed: false,
        admin: { id, username: "a", role: "SUPER_ADMIN", is_active: true, created_at: 1 },
      }).success,
    ).toBe(false);
    expect(
      leaderboardResultSchema.safeParse({ rows: [{ rank: 0, team_id: "T", score: 1 }] }).success,
    ).toBe(false);
    expect(
      leaderboardResultSchema.safeParse({ rows: [{ rank: 1, team_id: "T", score: 1 }] }).success,
    ).toBe(true);
  });
});

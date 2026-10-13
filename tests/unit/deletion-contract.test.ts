import { describe, expect, it } from "vitest";

import {
  MAX_DELETE_SELECTION,
  deleteAdminsResultSchema,
  deleteAdminsSchema,
  deleteTeamsResultSchema,
  deleteTeamsSchema,
  deletableAdminsResultSchema,
  deletableTeamsResultSchema,
} from "@/lib/contracts/deletion";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("deletion request contracts", () => {
  it("the limit is 100 (the database enforces the same number)", () => {
    expect(MAX_DELETE_SELECTION).toBe(100);
  });

  it("accepts 1..100 distinct ids and lower-cases them", () => {
    expect(deleteTeamsSchema.parse({ teamIds: [id(1).toUpperCase()] }).teamIds).toEqual([id(1)]);
    const hundred = Array.from({ length: 100 }, (_, i) => id(i + 1));
    expect(deleteAdminsSchema.safeParse({ adminIds: hundred }).success).toBe(true);
  });

  it.each([
    ["empty", { teamIds: [] }],
    ["101 ids", { teamIds: Array.from({ length: 101 }, (_, i) => id(i + 1)) }],
    ["duplicates", { teamIds: [id(1), id(1)] }],
    ["duplicates differing in case", { teamIds: [id(10).replace("a", "A"), id(10)] }],
    ["malformed", { teamIds: ["x"] }],
    ["non-string", { teamIds: [7] }],
    ["not an array", { teamIds: id(1) }],
    ["missing", {}],
    ["extra field", { teamIds: [id(1)], role: "SUPER_ADMIN" }],
    ["wrong key", { adminIds: [id(1)] }],
  ])("rejects %s", (_n, body) => {
    expect(deleteTeamsSchema.safeParse(body).success).toBe(false);
  });

  it("the admin schema is strict too", () => {
    expect(deleteAdminsSchema.safeParse({ adminIds: [id(1)], staffId: id(2) }).success).toBe(false);
    expect(deleteAdminsSchema.safeParse({ teamIds: [id(1)] }).success).toBe(false);
  });
});

describe("deletion result contracts are whitelists", () => {
  it("strip unknown keys, including anything secret", () => {
    const a = deleteAdminsResultSchema.parse({
      replayed: false,
      deleted: { admins: 1, teams: 2, password_hash: "x" },
      admin_ids: [id(1)],
      token: "t",
    });
    expect(JSON.stringify(a)).not.toMatch(/hash|token/);
    const t = deleteTeamsResultSchema.parse({
      replayed: true,
      deleted: { teams: 1 },
      team_ids: [id(1)],
      secret: 1,
    });
    expect(t).toEqual({ replayed: true, deleted: { teams: 1 }, team_ids: [id(1)] });
  });

  it("list rows drop hashes and reject malformed rows", () => {
    const l = deletableAdminsResultSchema.parse({
      admins: [
        {
          id: id(1),
          username: "a",
          is_active: true,
          team_count: 1,
          created_at: 5,
          password_hash: "h",
        },
      ],
    });
    expect(l.admins[0]).not.toHaveProperty("password_hash");
    expect(deletableAdminsResultSchema.safeParse({ admins: [{ id: "x" }] }).success).toBe(false);
    expect(
      deletableTeamsResultSchema.safeParse({
        teams: [
          {
            id: id(1),
            team_code: "T",
            name: "n",
            login_id: "l",
            status: "BOGUS",
            admin_username: "a",
            member_count: 4,
            created_at: 1,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

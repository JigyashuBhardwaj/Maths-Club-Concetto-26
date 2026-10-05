import { describe, expect, it } from "vitest";

import { getRole, isRoleId, loginPath, ROLES, ROLE_IDS } from "@/lib/roles";

describe("roles", () => {
  it("lists exactly Superadmin, Admin, Participant in landing order", () => {
    expect(ROLES.map((r) => r.label)).toEqual(["Superadmin", "Admin", "Participant"]);
    expect(ROLE_IDS).toEqual(["superadmin", "admin", "participant"]);
  });

  it("validates role ids strictly", () => {
    expect(isRoleId("admin")).toBe(true);
    expect(isRoleId("Admin")).toBe(false);
    expect(isRoleId("root")).toBe(false);
    expect(isRoleId("")).toBe(false);
    expect(isRoleId("__proto__")).toBe(false);
  });

  it("builds login paths and resolves roles", () => {
    expect(loginPath("participant")).toBe("/login/participant");
    expect(getRole("admin").home).toBe("/admin");
  });
});

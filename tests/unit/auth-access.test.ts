import { describe, expect, it } from "vitest";

import {
  areaForPath,
  areaOfRole,
  decideAccess,
  homeForRole,
  type Area,
  type PrincipalRole,
} from "@/lib/auth/access";

const ROLES: PrincipalRole[] = ["PARTICIPANT", "ADMIN", "SUPER_ADMIN"];
const AREAS: Area[] = ["participant", "admin", "superadmin"];

describe("route areas", () => {
  it("maps each role to exactly its own area and home", () => {
    expect(ROLES.map(areaOfRole)).toEqual(["participant", "admin", "superadmin"]);
    expect(ROLES.map(homeForRole)).toEqual(["/participant", "/admin", "/superadmin"]);
  });

  it("recognises protected paths, including every nested path", () => {
    for (const [path, area] of [
      ["/participant", "participant"],
      ["/participant/", "participant"],
      ["/participant/theme/A/1", "participant"],
      ["/admin", "admin"],
      ["/admin/teams/42", "admin"],
      ["/superadmin", "superadmin"],
      ["/superadmin/audit", "superadmin"],
    ] as const) {
      expect(areaForPath(path), path).toBe(area);
    }
  });

  it("leaves public paths alone, and does not confuse look-alike prefixes", () => {
    for (const path of [
      "/",
      "/login/admin",
      "/login/participant",
      "/login/superadmin",
      "/api/health",
      "/api/auth/me",
      "/api/p/state",
      "/administrator",
      "/participants",
      "/superadministrator",
      "/_next/static/x.js",
      "/icon.png",
    ]) {
      expect(areaForPath(path), path).toBeNull();
    }
  });
});

describe("decideAccess", () => {
  it("sends nobody-signed-in to the sign-in page of the area they asked for", () => {
    for (const area of AREAS) {
      expect(decideAccess(null, area)).toEqual({ allow: false, redirectTo: `/login/${area}` });
    }
  });

  it("allows a role into its own area only, and bounces it to its own home otherwise", () => {
    const expected: Record<PrincipalRole, Record<Area, string | "allow">> = {
      PARTICIPANT: { participant: "allow", admin: "/participant", superadmin: "/participant" },
      ADMIN: { participant: "/admin", admin: "allow", superadmin: "/admin" },
      SUPER_ADMIN: { participant: "/superadmin", admin: "/superadmin", superadmin: "allow" },
    };
    for (const role of ROLES) {
      for (const area of AREAS) {
        const decision = decideAccess({ role }, area);
        const want = expected[role][area];
        if (want === "allow") expect(decision.allow, `${role} -> ${area}`).toBe(true);
        else expect(decision, `${role} -> ${area}`).toEqual({ allow: false, redirectTo: want });
      }
    }
  });

  it("hands the principal back unchanged when access is allowed", () => {
    const principal = { role: "ADMIN" as const, staff: { id: "s", name: "n" } };
    const decision = decideAccess(principal, "admin");
    expect(decision).toEqual({ allow: true, principal });
  });
});

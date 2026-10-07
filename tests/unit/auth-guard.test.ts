import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/errors";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import { generateSessionToken, hashSessionToken } from "@/lib/auth/session";
import { DbError, type Db } from "@/lib/db/adapter";

const PEPPER = "pepper-for-tests-0123456789abcdef0123";
const jar = new Map<string, string>();
const rpc = vi.fn<Db["rpc"]>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/auth/routes", () => ({
  authDeps: { db: () => ({ rpc }), env: () => ({ SESSION_TOKEN_PEPPER: PEPPER }), now: () => 0 },
}));

const { getPrincipal, requireArea } = await import("@/lib/auth/guard");

const SESSION = {
  id: "3b241101-e2bb-4255-8caf-4136c566a962",
  expires_at: "2026-12-02T00:00:00+00:00",
};
const ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const principals = {
  PARTICIPANT: {
    ok: true,
    role: "PARTICIPANT",
    session: SESSION,
    member: { id: ID, slot: 1 },
    team: { id: ID, code: "T1", name: "Team", status: "NOT_STARTED" },
  },
  ADMIN: {
    ok: true,
    role: "ADMIN",
    session: SESSION,
    staff: { id: ID, username: "a", display_name: "Asha" },
  },
  SUPER_ADMIN: {
    ok: true,
    role: "SUPER_ADMIN",
    session: SESSION,
    staff: { id: ID, username: "s", display_name: "Sam" },
  },
};

let token: string;
beforeEach(() => {
  jar.clear();
  rpc.mockReset();
  token = generateSessionToken();
});
const signIn = (value = token) => jar.set(SESSION_COOKIE_NAME, value);

describe("getPrincipal", () => {
  it("is null without a cookie, and without asking the database", async () => {
    expect(await getPrincipal()).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("is null for a malformed cookie, and without asking the database", async () => {
    signIn("not-a-token");
    expect(await getPrincipal()).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("asks the database about the hash of the token (never the token) and returns the principal", async () => {
    signIn();
    rpc.mockResolvedValue(principals.ADMIN);
    const principal = await getPrincipal();
    expect(principal).toMatchObject({ role: "ADMIN", staff: { name: "Asha" } });
    expect(rpc).toHaveBeenCalledWith("resolve_session", {
      p_token_hash: hashSessionToken(token, PEPPER),
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(token);
  });

  it("is null when the session is unknown, revoked, expired or disabled (all the same answer)", async () => {
    signIn();
    rpc.mockResolvedValue({ ok: false, code: "UNAUTHENTICATED" });
    expect(await getPrincipal()).toBeNull();
  });

  it("does NOT turn an infrastructure failure into 'signed out' (or into 'signed in')", async () => {
    signIn();
    rpc.mockRejectedValue(new DbError("resolve_session", "08006"));
    await expect(getPrincipal()).rejects.toBeInstanceOf(DbError);
    rpc.mockResolvedValue({ ok: true, role: "PARTICIPANT" }); // malformed result
    await expect(getPrincipal()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("requireArea", () => {
  it("redirects a visitor to the sign-in page of the area", async () => {
    for (const area of ["participant", "admin", "superadmin"] as const) {
      await expect(requireArea(area)).rejects.toThrow(`NEXT_REDIRECT:/login/${area}`);
    }
  });

  it("redirects a dead session to the sign-in page", async () => {
    signIn();
    rpc.mockResolvedValue({ ok: false, code: "UNAUTHENTICATED" });
    await expect(requireArea("admin")).rejects.toThrow("NEXT_REDIRECT:/login/admin");
  });

  it.each([
    ["PARTICIPANT", "participant", "allow"],
    ["PARTICIPANT", "admin", "/participant"],
    ["PARTICIPANT", "superadmin", "/participant"],
    ["ADMIN", "participant", "/admin"],
    ["ADMIN", "admin", "allow"],
    ["ADMIN", "superadmin", "/admin"],
    ["SUPER_ADMIN", "participant", "/superadmin"],
    ["SUPER_ADMIN", "admin", "/superadmin"],
    ["SUPER_ADMIN", "superadmin", "allow"],
  ] as const)("%s asking for %s: %s", async (role, area, outcome) => {
    signIn();
    rpc.mockResolvedValue(principals[role]);
    if (outcome === "allow") {
      await expect(requireArea(area)).resolves.toMatchObject({ role });
    } else {
      await expect(requireArea(area)).rejects.toThrow(`NEXT_REDIRECT:${outcome}`);
    }
  });

  it("lets an infrastructure failure surface instead of rendering or redirecting", async () => {
    signIn();
    rpc.mockRejectedValue(new DbError("resolve_session", "57P01"));
    await expect(requireArea("participant")).rejects.toBeInstanceOf(DbError);
  });
});

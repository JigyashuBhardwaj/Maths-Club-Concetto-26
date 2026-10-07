import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildClearedSessionCookie,
  readSessionToken,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/cookies";
import {
  createLogoutHandler,
  createMeHandler,
  createParticipantLoginHandler,
  createStaffLoginHandler,
  type AuthDeps,
} from "@/lib/auth/handlers";
import { resolvePrincipalFromToken } from "@/lib/auth/principal";
import { dbFailureSchema, dbPrincipalSchema } from "@/lib/contracts/auth";
import type { Db, DbFunction } from "@/lib/db/adapter";
import { createSupabaseDb } from "@/lib/db/supabase";

import { createFakeBackend, createFakeServer } from "../e2e/support/fake-postgrest.mjs";

/**
 * The B9 handlers wired to the in-memory backend the browser tests use. This is the flow the user lives through
 * (login -> restore -> logout -> dead session) at handler level, and it pins the stand-in to the real contract: every
 * result it produces must satisfy the schemas the production code parses the real database's results with.
 */
const ORIGIN = "https://concetto.example";
const PEPPER = "pepper-for-tests-0123456789abcdef0123";
const identities = {
  staff: [
    { username: "asha", password: "asha-pw-1", displayName: "Asha Rao", role: "ADMIN" },
    { username: "root", password: "root-pw-1", displayName: "Root", role: "SUPER_ADMIN" },
    { username: "off", password: "off-pw-1", displayName: "Off", role: "ADMIN", active: false },
  ],
  teams: [
    {
      code: "T1",
      name: "Team One",
      loginId: "team_one",
      password: "team-pw-1",
      members: [
        { slot: 1, admissionNo: "ADM1" },
        { slot: 2, admissionNo: "ADM2" },
      ],
    },
  ],
};

function setup(now: () => number = () => Date.now()) {
  const backend = createFakeBackend(identities, now);
  const db: Db = {
    async rpc(fn: DbFunction, args: Record<string, unknown>) {
      const out = backend.rpc(fn, args);
      if (out === undefined) throw new Error(`no such function ${fn}`);
      return out;
    },
  };
  const deps: AuthDeps = {
    db: () => db,
    env: () => ({
      APP_ORIGIN: ORIGIN,
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
      SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40),
      SESSION_TOKEN_PEPPER: PEPPER,
    }),
    now,
  };
  return {
    backend,
    db,
    participantLogin: createParticipantLoginHandler(deps),
    staffLogin: createStaffLoginHandler(deps),
    me: createMeHandler(deps),
    logout: createLogoutHandler(deps),
  };
}

const post = (path: string, body: unknown, cookie?: string) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (path: string, cookie?: string) =>
  new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
const cookieOf = (res: Response) => {
  const set = res.headers.get("set-cookie") ?? "";
  return set.startsWith(`${SESSION_COOKIE_NAME}=`) && !set.includes("Max-Age=0")
    ? set.split(";")[0]!
    : undefined;
};
const team = { teamLoginId: "team_one", password: "team-pw-1", admissionNo: "adm1" };

describe("participant: login -> restore -> logout", () => {
  it("logs in, restores the principal from the cookie, and logout revokes it", async () => {
    const t = setup();
    const login = await t.participantLogin(post("/api/auth/participant/login", team));
    expect(login.status).toBe(200);
    const cookie = cookieOf(login)!;
    expect(cookie).toBeDefined();
    const set = login.headers.get("set-cookie")!;
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Secure");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Path=/");
    expect(set).not.toMatch(/Domain=/i);

    const restored = await t.me(get("/api/auth/me", cookie));
    expect(restored.status).toBe(200);
    const body = await restored.text();
    expect(JSON.parse(body).data).toMatchObject({ role: "PARTICIPANT", team: { code: "T1" } });
    for (const secret of [
      "team-pw-1",
      "ADM1",
      cookie.split("=")[1]!,
      "hash",
      "password",
      "token",
    ]) {
      expect(body.toLowerCase()).not.toContain(secret.toLowerCase());
    }

    const out = await t.logout(post("/api/auth/logout", undefined, cookie));
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toBe(buildClearedSessionCookie());
    expect(t.backend.controls.liveSessions({ admissionNo: "ADM1" })).toEqual({ live: 0 });

    const dead = await t.me(get("/api/auth/me", cookie));
    expect(dead.status).toBe(401);
    expect(dead.headers.get("set-cookie")).toBe(buildClearedSessionCookie());
  });

  it("answers wrong team, wrong password and wrong admission number identically", async () => {
    const t = setup();
    const attempts = [
      { ...team, teamLoginId: "nobody" },
      { ...team, password: "wrong" },
      { ...team, admissionNo: "ADM9" },
    ];
    const bodies: string[] = [];
    for (const a of attempts) {
      const res = await t.participantLogin(post("/api/auth/participant/login", a));
      expect(res.status).toBe(401);
      expect(cookieOf(res)).toBeUndefined();
      const text = await res.text();
      bodies.push(text.replace(/"server_now":\d+/, ""));
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it("refuses a participant while the competition is not open, and sets no cookie", async () => {
    const t = setup();
    t.backend.controls.competition({ loginId: "team_one", status: "SETUP" });
    const res = await t.participantLogin(post("/api/auth/participant/login", team));
    expect(res.status).toBe(423);
    expect(cookieOf(res)).toBeUndefined();
    expect((await res.json()).error.code).toBe("COMPETITION_NOT_RUNNING");
  });

  it("a second login of the same member supersedes the first session", async () => {
    const t = setup();
    const first = cookieOf(await t.participantLogin(post("/api/auth/participant/login", team)))!;
    const second = cookieOf(await t.participantLogin(post("/api/auth/participant/login", team)))!;
    expect((await t.me(get("/api/auth/me", first))).status).toBe(401);
    expect((await t.me(get("/api/auth/me", second))).status).toBe(200);
  });

  it("an expired session is not authenticated", async () => {
    let now = 1_760_000_000_000;
    const t = setup(() => now);
    const cookie = cookieOf(await t.participantLogin(post("/api/auth/participant/login", team)))!;
    expect((await t.me(get("/api/auth/me", cookie))).status).toBe(200);
    now += 12 * 60 * 60 * 1000 + 1; // past the 12 h lifetime
    expect((await t.me(get("/api/auth/me", cookie))).status).toBe(401);
    // and it stays dead
    now -= 60_000;
    expect((await t.me(get("/api/auth/me", cookie))).status).toBe(401);
  });

  it("is throttled like the database: 8 failures, then RATE_LIMITED with a Retry-After", async () => {
    const t = setup();
    for (let i = 0; i < 8; i += 1) {
      await t.participantLogin(
        post("/api/auth/participant/login", { ...team, password: `bad${i}` }),
      );
    }
    const res = await t.participantLogin(post("/api/auth/participant/login", team));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(30);
    expect((await res.json()).error.details.retry_after_seconds).toBeGreaterThanOrEqual(30);
  });
});

describe("staff: login -> role -> logout", () => {
  it("reports the role the server holds, for both staff roles", async () => {
    const t = setup();
    for (const [username, password, role] of [
      ["asha", "asha-pw-1", "ADMIN"],
      ["root", "root-pw-1", "SUPER_ADMIN"],
    ] as const) {
      const res = await t.staffLogin(post("/api/auth/staff/login", { username, password }));
      expect((await res.json()).data.role).toBe(role);
    }
  });

  it("does not accept a role, or any other extra field, from the browser", async () => {
    const t = setup();
    const res = await t.staffLogin(
      post("/api/auth/staff/login", {
        username: "asha",
        password: "asha-pw-1",
        role: "SUPER_ADMIN",
      }),
    );
    expect(res.status).toBe(400);
    expect(cookieOf(res)).toBeUndefined();
  });

  it("treats a disabled account like a wrong password; a later disable kills the live session", async () => {
    const t = setup();
    const off = await t.staffLogin(
      post("/api/auth/staff/login", { username: "off", password: "off-pw-1" }),
    );
    expect(off.status).toBe(401);
    const wrong = await t.staffLogin(
      post("/api/auth/staff/login", { username: "asha", password: "nope" }),
    );
    expect(wrong.status).toBe(401);
    expect((await off.json()).error).toEqual((await wrong.json()).error);

    const cookie = cookieOf(
      await t.staffLogin(
        post("/api/auth/staff/login", { username: "asha", password: "asha-pw-1" }),
      ),
    )!;
    expect((await t.me(get("/api/auth/me", cookie))).status).toBe(200);
    t.backend.controls.staffActive({ username: "asha", active: false });
    expect((await t.me(get("/api/auth/me", cookie))).status).toBe(401);
  });

  it("cross-site login attempts are refused before the database is asked", async () => {
    const t = setup();
    const evil = new Request(`${ORIGIN}/api/auth/staff/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ username: "asha", password: "asha-pw-1" }),
    });
    expect((await t.staffLogin(evil)).status).toBe(403);
    expect(t.backend.controls.liveSessions({ username: "asha" })).toEqual({ live: 0 });
  });
});

describe("the server-rendered guard's path: resolvePrincipalFromToken", () => {
  it("agrees with GET /api/auth/me on live, revoked and unknown tokens", async () => {
    const t = setup();
    const cookie = cookieOf(
      await t.staffLogin(
        post("/api/auth/staff/login", { username: "root", password: "root-pw-1" }),
      ),
    )!;
    const token = readSessionToken(cookie)!;
    await expect(resolvePrincipalFromToken(t.db, token, PEPPER)).resolves.toMatchObject({
      role: "SUPER_ADMIN",
      staff: { name: "Root" },
    });
    await expect(resolvePrincipalFromToken(t.db, null, PEPPER)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await t.logout(post("/api/auth/logout", undefined, cookie));
    await expect(resolvePrincipalFromToken(t.db, token, PEPPER)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
});

describe("the in-memory backend matches the contracts the real database is parsed with", () => {
  it("returns results that satisfy dbPrincipalSchema / dbFailureSchema", () => {
    const backend = createFakeBackend(identities);
    const hash = `\\x${"ab".repeat(32)}`;
    const ok = [
      backend.rpc("participant_login", {
        p_login_id: "team_one",
        p_password: "team-pw-1",
        p_admission_no: "ADM1",
        p_token_hash: hash,
      }),
      backend.rpc("staff_login", {
        p_username: "asha",
        p_password: "asha-pw-1",
        p_token_hash: `\\x${"cd".repeat(32)}`,
      }),
      backend.rpc("resolve_session", { p_token_hash: hash }),
    ];
    for (const r of ok)
      expect(dbPrincipalSchema.safeParse(r).success, JSON.stringify(r)).toBe(true);
    const refused = [
      backend.rpc("participant_login", {
        p_login_id: "x",
        p_password: "x",
        p_admission_no: "x",
        p_token_hash: hash,
      }),
      backend.rpc("resolve_session", { p_token_hash: `\\x${"00".repeat(32)}` }),
    ];
    for (const r of refused) expect(dbFailureSchema.safeParse(r).success).toBe(true);
  });
});

describe("through the real supabase-js client", () => {
  let server: ReturnType<typeof createFakeServer>;
  let url: string;
  const key = "service-key-for-tests-0123456789";
  beforeAll(async () => {
    server = createFakeServer({ identities, serviceKey: key });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("speaks the PostgREST rpc wire format the production adapter uses", async () => {
    const db = createSupabaseDb({ url, serviceRoleKey: key });
    const hash = `\\x${"ef".repeat(32)}`;
    const login = await db.rpc("staff_login", {
      p_username: "root",
      p_password: "root-pw-1",
      p_token_hash: hash,
      p_ip: null,
      p_user_agent: null,
    });
    expect(dbPrincipalSchema.parse(login).role).toBe("SUPER_ADMIN");
    expect(
      dbPrincipalSchema.parse(await db.rpc("resolve_session", { p_token_hash: hash })).role,
    ).toBe("SUPER_ADMIN");
    expect(await db.rpc("revoke_session", { p_token_hash: hash })).toEqual({
      ok: true,
      revoked: true,
    });
    expect(await db.rpc("resolve_session", { p_token_hash: hash })).toEqual({
      ok: false,
      code: "UNAUTHENTICATED",
    });
  });

  it("rejects a wrong service key, and an unknown function is a database error, not a result", async () => {
    await expect(
      createSupabaseDb({ url, serviceRoleKey: "wrong-key-wrong-key-wrong-key-1" }).rpc(
        "resolve_session",
        { p_token_hash: `\\x${"00".repeat(32)}` },
      ),
    ).rejects.toMatchObject({ name: "DbError" });
    await expect(
      createSupabaseDb({ url, serviceRoleKey: key }).rpc("get_team_state", {}),
    ).rejects.toMatchObject({ name: "DbError" });
  });
});

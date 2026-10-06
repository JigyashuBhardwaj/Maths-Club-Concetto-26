import { describe, expect, it, vi } from "vitest";

import {
  createLogoutHandler,
  createMeHandler,
  createParticipantLoginHandler,
  createStaffLoginHandler,
  type AuthDeps,
} from "@/lib/auth/handlers";
import { buildClearedSessionCookie, SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import { generateSessionToken, hashSessionToken } from "@/lib/auth/session";
import { DbError, type Db, type DbFunction } from "@/lib/db/adapter";

const ORIGIN = "https://concetto.example";
const PEPPER = "pepper-for-tests-0123456789abcdef0123";
const NOW = 1_760_000_000_000;
const SESSION_ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const TEAM_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const MEMBER_ID = "9b2c1f4e-5d1a-4c3b-8e7f-0a1b2c3d4e5f";
const STAFF_ID = "1f0d3c2b-4a59-4687-9a7b-6c5d4e3f2a10";
const EXPIRES = "2026-12-02T00:00:00+00:00";

const PARTICIPANT_OK = {
  ok: true,
  role: "PARTICIPANT",
  session: { id: SESSION_ID, expires_at: EXPIRES },
  member: { id: MEMBER_ID, slot: 2 },
  team: { id: TEAM_ID, code: "T17", name: "Team Seventeen", status: "NOT_STARTED" },
};
const staffOk = (role: "ADMIN" | "SUPER_ADMIN") => ({
  ok: true,
  role,
  session: { id: SESSION_ID, expires_at: EXPIRES },
  staff: { id: STAFF_ID, username: "asha", display_name: "Asha Rao" },
});
const GENERIC = { ok: false, code: "INVALID_CREDENTIALS" };

type Call = { fn: DbFunction; args: Record<string, unknown> };
function fakeDb(handler: (fn: DbFunction, args: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const db: Db = {
    async rpc(fn, args) {
      calls.push({ fn, args });
      const out = handler(fn, args);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return { db, calls };
}
function deps(db: Db, token = generateSessionToken()): AuthDeps & { token: string } {
  return {
    db: () => db,
    env: () => ({
      APP_ORIGIN: ORIGIN,
      NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789",
      SESSION_TOKEN_PEPPER: PEPPER,
    }),
    now: () => NOW,
    newToken: () => token,
    token,
  };
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const PL = { teamLoginId: "team17", password: "s3cret-pass", admissionNo: "23JE0001" };
const SL = { username: "asha", password: "s3cret-pass-staff" };

describe("POST /api/auth/participant/login", () => {
  it("signs in: 200 envelope, session cookie, only a peppered hash goes to the database", async () => {
    const { db, calls } = fakeDb(() => PARTICIPANT_OK);
    const d = deps(db);
    const res = await createParticipantLoginHandler(d)(
      post("/api/auth/participant/login", PL, {
        "x-forwarded-for": "203.0.113.9, 10.0.0.1",
        "user-agent": "UA/1",
      }),
    );
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      ok: true,
      server_now: NOW,
      data: {
        role: "PARTICIPANT",
        member: { id: MEMBER_ID, slot: 2 },
        team: { id: TEAM_ID, code: "T17", name: "Team Seventeen", status: "NOT_STARTED" },
        session: { expires_at: Date.parse(EXPIRES) },
      },
    });
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=${d.token};`);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(res.headers.get("cache-control")).toBe("no-store");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      fn: "participant_login",
      args: {
        p_login_id: "team17",
        p_password: "s3cret-pass",
        p_admission_no: "23JE0001",
        p_token_hash: hashSessionToken(d.token, PEPPER),
        p_ip: "203.0.113.9",
        p_user_agent: "UA/1",
      },
    });
    expect(JSON.stringify(calls)).not.toContain(d.token); // the raw token never reaches the database
    expect(text).not.toMatch(/s3cret|password|hash|admission|23JE0001/i); // and nothing secret comes back
    expect(text).not.toContain(d.token);
  });

  it("ignores a spoofed non-IP X-Forwarded-For", async () => {
    const { db, calls } = fakeDb(() => PARTICIPANT_OK);
    await createParticipantLoginHandler(deps(db))(
      post("/api/auth/participant/login", PL, { "x-forwarded-for": "not-an-ip; drop table" }),
    );
    expect(calls[0]!.args.p_ip).toBeNull();
  });

  it("trims the login id and admission number but never the password", async () => {
    const { db, calls } = fakeDb(() => PARTICIPANT_OK);
    await createParticipantLoginHandler(deps(db))(
      post("/api/auth/participant/login", {
        teamLoginId: "  team17 ",
        password: " pw ",
        admissionNo: " 23je0001 ",
      }),
    );
    expect(calls[0]!.args).toMatchObject({
      p_login_id: "team17",
      p_password: " pw ",
      p_admission_no: "23je0001",
    });
  });

  it("generic failure: every refusal is the same 401 'Invalid credentials' with no cookie", async () => {
    const bodies = new Set<string>();
    for (const refusal of [
      GENERIC,
      { ok: false, code: "UNAUTHENTICATED" },
      { ok: false, code: "WHATEVER_NEW" },
    ]) {
      const { db } = fakeDb(() => refusal);
      const res = await createParticipantLoginHandler(deps(db))(
        post("/api/auth/participant/login", PL),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      bodies.add(await res.text());
    }
    expect([...bodies]).toEqual([
      JSON.stringify({
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Invalid credentials" },
        server_now: NOW,
      }),
    ]);
  });

  it("429: RATE_LIMITED with Retry-After and the wait in details", async () => {
    const { db } = fakeDb(() => ({ ok: false, code: "RATE_LIMITED", retry_after_seconds: 60 }));
    const res = await createParticipantLoginHandler(deps(db))(
      post("/api/auth/participant/login", PL),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await res.json()).error).toMatchObject({
      code: "RATE_LIMITED",
      details: { retry_after_seconds: 60 },
    });
  });

  it("423: the competition is not open (valid credentials, SETUP/ENDED)", async () => {
    const { db } = fakeDb(() => ({
      ok: false,
      code: "COMPETITION_NOT_RUNNING",
      competition_status: "SETUP",
    }));
    const res = await createParticipantLoginHandler(deps(db))(
      post("/api/auth/participant/login", PL),
    );
    expect(res.status).toBe(423);
    const body = await res.json();
    expect(body.error.code).toBe("COMPETITION_NOT_RUNNING");
    expect(JSON.stringify(body)).not.toContain("SETUP");
  });

  it("403: a missing, foreign or null Origin is refused before anything else happens", async () => {
    for (const origin of [undefined, "https://evil.example", "null"]) {
      const { db, calls } = fakeDb(() => PARTICIPANT_OK);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (origin) headers.origin = origin;
      const res = await createParticipantLoginHandler(deps(db))(
        new Request(`${ORIGIN}/api/auth/participant/login`, {
          method: "POST",
          headers,
          body: JSON.stringify(PL),
        }),
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("FORBIDDEN");
      expect(calls).toHaveLength(0);
    }
  });

  describe("400: validation", () => {
    const cases: [string, unknown, Record<string, string>?][] = [
      ["missing field", { teamLoginId: "t", password: "p" }],
      ["empty password", { ...PL, password: "" }],
      ["blank login id", { ...PL, teamLoginId: "   " }],
      ["password over 72 characters", { ...PL, password: "a".repeat(73) }],
      ["login id over 64", { ...PL, teamLoginId: "a".repeat(65) }],
      ["wrong type", { ...PL, password: 12345 }],
      ["unknown field (role)", { ...PL, role: "ADMIN" }],
      ["unknown field (teamId)", { ...PL, teamId: TEAM_ID }],
      ["array body", [PL]],
      ["not JSON", "{nope"],
      ["body over 2 KB", { ...PL, junk: "x".repeat(3000) }],
      ["wrong content type", JSON.stringify(PL), { "content-type": "text/plain" }],
    ];
    it.each(cases)("%s", async (_name, body, headers) => {
      const { db, calls } = fakeDb(() => PARTICIPANT_OK);
      const res = await createParticipantLoginHandler(deps(db))(
        post("/api/auth/participant/login", body, headers),
      );
      const text = await res.text();
      expect(res.status).toBe(400);
      expect(JSON.parse(text).error.code).toBe("VALIDATION_FAILED");
      expect(calls).toHaveLength(0);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(text).not.toContain("s3cret-pass"); // values are never echoed
    });

    it("names the unexpected field kind of error without echoing its value", async () => {
      const { db } = fakeDb(() => PARTICIPANT_OK);
      const res = await createParticipantLoginHandler(deps(db))(
        post("/api/auth/participant/login", { ...PL, role: "SUPER_ADMIN-value-xyz" }),
      );
      const body = await res.json();
      expect(body.error.message).toBe("Unexpected field in request.");
      expect(JSON.stringify(body)).not.toContain("SUPER_ADMIN-value-xyz");
    });
  });

  it("503: a database failure is a generic retryable error and logs no request data", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb((fn) => new DbError(fn, "57P01"));
    const res = await createParticipantLoginHandler(deps(db))(
      post("/api/auth/participant/login", PL),
    );
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(text).not.toMatch(/57P01|participant_login|s3cret/);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/s3cret|team17|23JE0001/);
    spy.mockRestore();
  });

  it("503, not a login: a malformed 'success' from the database never produces a cookie", async () => {
    const { db } = fakeDb(() => ({ ok: true, role: "PARTICIPANT" }));
    const res = await createParticipantLoginHandler(deps(db))(
      post("/api/auth/participant/login", PL),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("POST /api/auth/staff/login", () => {
  it.each(["ADMIN", "SUPER_ADMIN"] as const)("signs in an %s with { id, name }", async (role) => {
    const { db, calls } = fakeDb(() => staffOk(role));
    const d = deps(db);
    const res = await createStaffLoginHandler(d)(post("/api/auth/staff/login", SL));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      role,
      staff: { id: STAFF_ID, name: "Asha Rao" },
      session: { expires_at: Date.parse(EXPIRES) },
    });
    expect(JSON.stringify(body)).not.toMatch(/password|hash|s3cret/i);
    expect(res.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=${d.token};`);
    expect(calls[0]).toMatchObject({
      fn: "staff_login",
      args: {
        p_username: "asha",
        p_password: "s3cret-pass-staff",
        p_token_hash: hashSessionToken(d.token, PEPPER),
      },
    });
  });

  it("an inactive, unknown or wrong-password account is the same generic 401", async () => {
    const { db } = fakeDb(() => GENERIC);
    const res = await createStaffLoginHandler(deps(db))(post("/api/auth/staff/login", SL));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toEqual({
      code: "UNAUTHENTICATED",
      message: "Invalid credentials",
    });
  });

  it("validates strictly (unknown fields, missing password) and checks the Origin", async () => {
    const { db, calls } = fakeDb(() => staffOk("ADMIN"));
    const h = createStaffLoginHandler(deps(db));
    expect((await h(post("/api/auth/staff/login", { ...SL, role: "SUPER_ADMIN" }))).status).toBe(
      400,
    );
    expect((await h(post("/api/auth/staff/login", { username: "asha" }))).status).toBe(400);
    expect(
      (await h(post("/api/auth/staff/login", SL, { origin: "https://evil.example" }))).status,
    ).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("429 with Retry-After", async () => {
    const { db } = fakeDb(() => ({ ok: false, code: "RATE_LIMITED", retry_after_seconds: 30 }));
    const res = await createStaffLoginHandler(deps(db))(post("/api/auth/staff/login", SL));
    expect([res.status, res.headers.get("retry-after")]).toEqual([429, "30"]);
  });
});

describe("POST /api/auth/logout", () => {
  const token = generateSessionToken();
  const withCookie = (headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}/api/auth/logout`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE_NAME}=${token}`, ...headers },
    });

  it("revokes the session by its peppered hash and clears the cookie", async () => {
    const { db, calls } = fakeDb(() => ({ ok: true, revoked: true }));
    const res = await createLogoutHandler(deps(db))(withCookie());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({});
    expect(res.headers.get("set-cookie")).toBe(buildClearedSessionCookie());
    expect(calls).toEqual([
      { fn: "revoke_session", args: { p_token_hash: hashSessionToken(token, PEPPER) } },
    ]);
  });

  it("is idempotent: with no (or a malformed) cookie it still answers 200, clears the cookie and calls nothing", async () => {
    const { db, calls } = fakeDb(() => ({ ok: true, revoked: false }));
    const bare = new Request(`${ORIGIN}/api/auth/logout`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    const bad = new Request(`${ORIGIN}/api/auth/logout`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE_NAME}=garbage` },
    });
    for (const r of [bare, bad]) {
      const res = await createLogoutHandler(deps(db))(r);
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBe(buildClearedSessionCookie());
    }
    expect(calls).toHaveLength(0);
  });

  it("403 without a same-origin Origin (cannot be forged cross-site) and nothing is revoked", async () => {
    const { db, calls } = fakeDb(() => ({ ok: true, revoked: true }));
    const res = await createLogoutHandler(deps(db))(withCookie({ origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("503 when the database fails (the session is then not known to be revoked)", async () => {
    const { db } = fakeDb((fn) => new DbError(fn));
    const res = await createLogoutHandler(deps(db))(withCookie());
    expect(res.status).toBe(503);
  });
});

describe("GET /api/auth/me", () => {
  const token = generateSessionToken();
  const get = (cookie?: string) =>
    new Request(`${ORIGIN}/api/auth/me`, { headers: cookie === undefined ? {} : { cookie } });

  it("returns the participant principal for a live session", async () => {
    const { db, calls } = fakeDb(() => PARTICIPANT_OK);
    const res = await createMeHandler(deps(db))(get(`${SESSION_COOKIE_NAME}=${token}`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      role: "PARTICIPANT",
      member: { id: MEMBER_ID, slot: 2 },
      team: { id: TEAM_ID, code: "T17", name: "Team Seventeen", status: "NOT_STARTED" },
      session: { expires_at: Date.parse(EXPIRES) },
    });
    expect(body.server_now).toBe(NOW);
    expect(calls).toEqual([
      { fn: "resolve_session", args: { p_token_hash: hashSessionToken(token, PEPPER) } },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/password|hash|admission/i);
  });

  it.each(["ADMIN", "SUPER_ADMIN"] as const)("returns the %s principal", async (role) => {
    const { db } = fakeDb(() => staffOk(role));
    const res = await createMeHandler(deps(db))(get(`${SESSION_COOKIE_NAME}=${token}`));
    expect((await res.json()).data).toMatchObject({
      role,
      staff: { id: STAFF_ID, name: "Asha Rao" },
    });
  });

  it("401 and a cleared cookie: no cookie, malformed cookie (no database call), unknown/revoked/expired session", async () => {
    for (const [cookie, dbReply, expectCalls] of [
      [undefined, null, 0],
      ["other=1", null, 0],
      [`${SESSION_COOKIE_NAME}=not-a-valid-token`, null, 0],
      [`${SESSION_COOKIE_NAME}=${token}`, { ok: false, code: "UNAUTHENTICATED" }, 1],
    ] as const) {
      const { db, calls } = fakeDb(() => dbReply);
      const res = await createMeHandler(deps(db))(get(cookie));
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
      expect(res.headers.get("set-cookie")).toBe(buildClearedSessionCookie());
      expect(calls).toHaveLength(expectCalls);
    }
  });

  it("503 (not 401) when the database is down, so a client does not discard a good session", async () => {
    const { db } = fakeDb((fn) => new DbError(fn));
    const res = await createMeHandler(deps(db))(get(`${SESSION_COOKIE_NAME}=${token}`));
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

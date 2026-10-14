import { describe, expect, it } from "vitest";

import { buildClearedSessionCookie, SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import {
  createLogoutHandler,
  createParticipantLoginHandler,
  type AuthDeps,
} from "@/lib/auth/handlers";
import type { Db, DbFunction } from "@/lib/db/adapter";
import { createEnterQuestionHandler, createGetQuestionHandler } from "@/lib/gameplay/handlers";
import { createStartTeamHandler, createTeamStateHandler } from "@/lib/runtime/handlers";

import { createFakeBackend } from "../e2e/support/fake-postgrest.mjs";

/**
 * B19, server side. The browser ends a session after a fullscreen exit with the EXISTING `POST /api/auth/logout`; this
 * proves, with the real handlers over the in-memory backend, that this really revokes the actual session, clears the
 * actual cookie, kills access to the protected participant APIs afterwards, and cannot be aimed at anyone else.
 * (The SQL side, `revoke_session`, is covered by supabase/tests/70_auth.test.sql.)
 */
const ORIGIN = "https://concetto.example";
const PEPPER = "pepper-for-tests-0123456789abcdef0123";
const identities = {
  staff: [{ username: "asha", password: "asha-pw-1", displayName: "Asha", role: "ADMIN" }],
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
    {
      code: "T2",
      name: "Team Two",
      loginId: "team_two",
      password: "team-pw-2",
      members: [{ slot: 1, admissionNo: "BDM1" }],
    },
  ],
};

function setup() {
  const backend = createFakeBackend(identities);
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
    now: () => Date.now(),
  };
  return {
    backend,
    login: createParticipantLoginHandler(deps),
    logout: createLogoutHandler(deps),
    state: createTeamStateHandler(deps),
    start: createStartTeamHandler(deps),
    enter: createEnterQuestionHandler(deps),
    read: createGetQuestionHandler(deps),
  };
}
type T = ReturnType<typeof setup>;

const post = (
  path: string,
  body?: unknown,
  cookie?: string,
  headers: Record<string, string> = {},
) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (path: string, cookie?: string) =>
  new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });

async function signIn(t: T, teamLoginId: string, password: string, admissionNo: string) {
  const res = await t.login(
    post("/api/auth/participant/login", { teamLoginId, password, admissionNo }),
  );
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
const one = (t: T) => signIn(t, "team_one", "team-pw-1", "ADM1");
const oneB = (t: T) => signIn(t, "team_one", "team-pw-1", "ADM2");
const two = (t: T) => signIn(t, "team_two", "team-pw-2", "BDM1");
const questionCtx = { params: Promise.resolve({ questionId: "1" }) };
const KEY = "5d6f1c1a-3b8e-4f0a-9c21-7e4d2a9b8c10";

describe("fullscreen-exit logout uses the existing endpoint and really ends the session", () => {
  it("revokes the actual session, clears the actual cookie, and the old cookie then fails every protected participant API", async () => {
    const t = setup();
    const cookie = await one(t);
    // alive before: the protected APIs answer
    expect((await t.state(get("/api/p/state", cookie))).status).toBe(200);
    expect(t.backend.controls.liveSessions({ admissionNo: "ADM1" })).toEqual({ live: 1 });

    const out = await t.logout(post("/api/auth/logout", undefined, cookie));
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toBe(buildClearedSessionCookie());
    expect(out.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(t.backend.controls.liveSessions({ admissionNo: "ADM1" })).toEqual({ live: 0 });

    // a delayed or failed client redirect gains nothing: the old cookie is dead on every protected route
    const replayed = [
      await t.state(get("/api/p/state", cookie)),
      await t.start(post("/api/p/start", undefined, cookie, { "idempotency-key": KEY })),
      await t.enter(
        post("/api/p/questions/1/enter", undefined, cookie, { "idempotency-key": KEY }),
        questionCtx,
      ),
      await t.read(get("/api/p/questions/1", cookie), questionCtx),
    ];
    for (const r of replayed) expect(r.status).toBe(401);
    // and nothing in those answers leaks the token or an internal error
    for (const r of replayed) {
      const text = await r.text();
      expect(text).not.toContain(cookie.split("=")[1]!);
      expect(text).not.toMatch(/revoked|session_id|sql|stack/i);
    }
  });

  it("the logout request carries no identity: it is aimed by the cookie alone, so a forged id, team or session in the body, query or headers logs out nobody else", async () => {
    const t = setup();
    const mine = await one(t);
    const victimSameTeam = await oneB(t);
    const victimOtherTeam = await two(t);
    const forged = {
      memberId: "9b2c1f4e-5d1a-4c3b-8e7f-0a1b2c3d4e5f",
      teamId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      admissionNo: "BDM1",
      sessionId: "3b241101-e2bb-4255-8caf-4136c566a962",
      token: victimOtherTeam.split("=")[1],
    };
    const req = new Request(`${ORIGIN}/api/auth/logout?admissionNo=BDM1&teamLoginId=team_two`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        cookie: mine,
        "x-member-id": forged.memberId,
        "x-session-id": forged.sessionId,
      },
      body: JSON.stringify(forged),
    });
    expect((await t.logout(req)).status).toBe(200);
    // only the caller's own session ended
    expect(t.backend.controls.liveSessions({ admissionNo: "ADM1" })).toEqual({ live: 0 });
    expect(t.backend.controls.liveSessions({ admissionNo: "ADM2" })).toEqual({ live: 1 });
    expect(t.backend.controls.liveSessions({ admissionNo: "BDM1" })).toEqual({ live: 1 });
    expect((await t.state(get("/api/p/state", victimSameTeam))).status).toBe(200);
    expect((await t.state(get("/api/p/state", victimOtherTeam))).status).toBe(200);
  });

  it("a logout with no cookie, or a made-up one, ends nobody's session but still answers 200 and clears the cookie", async () => {
    const t = setup();
    const real = await one(t);
    for (const cookie of [
      undefined,
      `${SESSION_COOKIE_NAME}=forged`,
      `${SESSION_COOKIE_NAME}=${"A".repeat(43)}`,
    ]) {
      // ... even when the body, query and headers name a live session: only the cookie can aim a logout
      const token = real.split("=")[1]!;
      const res = await t.logout(
        new Request(`${ORIGIN}/api/auth/logout?token=${token}&admissionNo=ADM1`, {
          method: "POST",
          headers: {
            origin: ORIGIN,
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "x-session-token": token,
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify({ token, sessionToken: token, admissionNo: "ADM1" }),
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBe(buildClearedSessionCookie());
    }
    expect(t.backend.controls.liveSessions({ admissionNo: "ADM1" })).toEqual({ live: 1 });
    expect((await t.state(get("/api/p/state", real))).status).toBe(200);
  });

  it("a cross-site page cannot sign a participant out: a foreign Origin is refused and the session lives", async () => {
    const t = setup();
    const cookie = await one(t);
    const res = await t.logout(
      post("/api/auth/logout", undefined, cookie, { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull(); // a refused request neither revokes nor clears
    expect(t.backend.controls.liveSessions({ admissionNo: "ADM1" })).toEqual({ live: 1 });
  });

  it("logging out is idempotent: a repeated request is a harmless 200 and the session stays dead", async () => {
    const t = setup();
    const cookie = await one(t);
    expect((await t.logout(post("/api/auth/logout", undefined, cookie))).status).toBe(200);
    expect((await t.logout(post("/api/auth/logout", undefined, cookie))).status).toBe(200);
    expect((await t.state(get("/api/p/state", cookie))).status).toBe(401);
  });
});

describe("protected participant APIs still enforce authentication", () => {
  it("without a session, with a forged cookie, or with a malformed one, every route answers 401", async () => {
    const t = setup();
    for (const cookie of [undefined, `${SESSION_COOKIE_NAME}=forged`, "other=1"]) {
      expect((await t.state(get("/api/p/state", cookie))).status).toBe(401);
      expect(
        (await t.start(post("/api/p/start", undefined, cookie, { "idempotency-key": KEY }))).status,
      ).toBe(401);
      expect(
        (
          await t.enter(
            post("/api/p/questions/1/enter", undefined, cookie, { "idempotency-key": KEY }),
            questionCtx,
          )
        ).status,
      ).toBe(401);
    }
  });

  it("the server does not know or care about fullscreen: a live session can still call the engine (which is why the revoke matters)", async () => {
    // documents the limit rather than hiding it: nothing in a request says "fullscreen"; only the session decides.
    const t = setup();
    const cookie = await one(t);
    t.backend.controls.competition({ loginId: "team_one", status: "RUNNING" });
    const res = await t.start(post("/api/p/start", undefined, cookie, { "idempotency-key": KEY }));
    expect(res.status).toBe(200);
  });
});

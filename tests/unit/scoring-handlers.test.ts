import { describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import { generateSessionToken } from "@/lib/auth/session";
import { DbError, type Db, type DbFunction } from "@/lib/db/adapter";
import {
  createParticipantLeaderboardHandler,
  createPenalizeTeamHandler,
} from "@/lib/scoring/handlers";
import type { AuthDeps } from "@/lib/auth/handlers";

const ORIGIN = "https://concetto.example";
const PEPPER = "pepper-for-tests-0123456789abcdef0123";
const NOW = 1_760_000_000_000;
const DB_NOW = 1_760_000_123_456;
const SESSION_ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const TEAM_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OTHER_TEAM_ID = "0e3c1f2a-9b7d-4c55-8a10-5d2f6b1c9e44";
const MEMBER_ID = "9b2c1f4e-5d1a-4c3b-8e7f-0a1b2c3d4e5f";
const STAFF_ID = "1f0d3c2b-4a59-4687-9a7b-6c5d4e3f2a10";
const KEY = "5d6f1c1a-3b8e-4f0a-9c21-7e4d2a9b8c10";
const EXPIRES = "2026-12-02T00:00:00+00:00";

const participant = {
  ok: true,
  role: "PARTICIPANT",
  session: { id: SESSION_ID, expires_at: EXPIRES },
  member: { id: MEMBER_ID, slot: 2 },
  team: { id: TEAM_ID, code: "T17", name: "Team Seventeen", status: "RUNNING" },
};
const staff = (role: "ADMIN" | "SUPER_ADMIN") => ({
  ok: true,
  role,
  session: { id: SESSION_ID, expires_at: EXPIRES },
  staff: { id: STAFF_ID, username: "asha", display_name: "Asha Rao" },
});

const board = (over: Record<string, unknown> = {}) => ({
  server_now: DB_NOW,
  rows: [
    { rank: 1, team_id: "T02", score: 1375 },
    { rank: 2, team_id: "T17", score: 30 },
    { rank: 3, team_id: "T05", score: -800 },
  ],
  me: { rank: 2, team_id: "T17", score: 30 },
  ...over,
});
const penalized = (over: Record<string, unknown> = {}) => ({
  replayed: false,
  changed: true,
  team: {
    id: TEAM_ID,
    team_code: "T17",
    status: "ENDED",
    official_score: 0,
    penalized_at: DB_NOW,
  },
  ...over,
});

type Call = { fn: DbFunction; args: Record<string, unknown> };
function fakeDb(
  principal: unknown,
  handler: (fn: DbFunction, args: Record<string, unknown>) => unknown = () => {
    throw new Error("unexpected database call");
  },
) {
  const calls: Call[] = [];
  const db: Db = {
    async rpc(fn, args) {
      calls.push({ fn, args });
      if (fn === "resolve_session") return principal;
      const out = handler(fn, args);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return { db, calls, ops: () => calls.filter((c) => c.fn !== "resolve_session") };
}
const deps = (db: Db): AuthDeps => ({
  db: () => db,
  env: () => ({
    APP_ORIGIN: ORIGIN,
    NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789",
    SESSION_TOKEN_PEPPER: PEPPER,
  }),
  now: () => NOW,
});

const COOKIE = `${SESSION_COOKIE_NAME}=${generateSessionToken()}`;
const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { method: "GET", headers: { cookie: COOKIE, ...headers } });
function post(path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    cookie: COOKIE,
    "idempotency-key": KEY,
    "content-type": "application/json",
    ...init.headers,
  };
  const body =
    init.body === undefined
      ? undefined
      : typeof init.body === "string"
        ? init.body
        : JSON.stringify(init.body);
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body });
}
const json = async (res: Response) => JSON.parse(await res.text());
const ctx = (teamId: string) => ({ params: Promise.resolve({ teamId }) });
const raised = (fn: DbFunction, appCode: string) => new DbError(fn, "P0001", { appCode });

describe("GET /api/p/leaderboard", () => {
  const call = (db: Db, headers?: Record<string, string>) =>
    createParticipantLeaderboardHandler(deps(db))(get("/api/p/leaderboard", headers));

  it("returns the server's ranking and the caller's own line, for the session's own team and member", async () => {
    const { db, ops } = fakeDb(participant, () => board());
    const res = await call(db);
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ ok: true, server_now: DB_NOW });
    expect(body.data.rows.map((r: { team_id: string }) => r.team_id)).toEqual([
      "T02",
      "T17",
      "T05",
    ]);
    expect(body.data.rows[2].score).toBe(-800); // a negative score is a score
    expect(body.data.me).toEqual({ rank: 2, team_id: "T17", score: 30 });
    expect(ops()).toEqual([
      { fn: "get_team_leaderboard", args: { p_team_id: TEAM_ID, p_member_id: MEMBER_ID } },
    ]);
  });

  it("whitelists the result: nothing but rank, Team ID and score reaches the browser", async () => {
    const { db } = fakeDb(participant, () =>
      board({
        rows: [{ rank: 1, team_id: "T02", score: 5, password_hash: "x", coins: 99, minutes: 3 }],
        me: { rank: 1, team_id: "T02", score: 5, admission_no: "A1" },
        secret: "nope",
      }),
    );
    const body = await json(await call(db));
    expect(body.data).toEqual({
      server_now: DB_NOW,
      rows: [{ rank: 1, team_id: "T02", score: 5 }],
      me: { rank: 1, team_id: "T02", score: 5 },
    });
  });

  it("takes nothing from the request: a team id in the query string is ignored", async () => {
    const { db, ops } = fakeDb(participant, () => board());
    await createParticipantLeaderboardHandler(deps(db))(
      get(`/api/p/leaderboard?team_id=${OTHER_TEAM_ID}&member_id=${OTHER_TEAM_ID}`),
    );
    expect(ops()[0]!.args).toEqual({ p_team_id: TEAM_ID, p_member_id: MEMBER_ID });
  });

  it("is for participants only (staff 403, no session 401) and never reaches the board function otherwise", async () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"] as const) {
      const { db, ops } = fakeDb(staff(role));
      expect((await call(db)).status).toBe(403);
      expect(ops()).toHaveLength(0);
    }
    const none = fakeDb({ ok: false, code: "UNAUTHENTICATED" });
    expect((await call(none.db)).status).toBe(401);
    expect(none.ops()).toHaveLength(0);
    const noCookie = fakeDb(participant);
    const res = await createParticipantLeaderboardHandler(deps(noCookie.db))(
      new Request(`${ORIGIN}/api/p/leaderboard`),
    );
    expect(res.status).toBe(401);
    expect(noCookie.ops()).toHaveLength(0);
  });

  it("a malformed database result is a 503, never forwarded", async () => {
    const { db } = fakeDb(participant, () => ({ rows: "nope" }));
    const res = await call(db);
    expect(res.status).toBe(503);
  });
});

describe("POST /api/admin/teams/:teamId/penalize", () => {
  const call = (
    db: Db,
    init: Parameters<typeof post>[1] = { body: { confirm: true } },
    id = TEAM_ID,
  ) => createPenalizeTeamHandler(deps(db))(post(`/api/admin/teams/${id}/penalize`, init), ctx(id));

  it("penalises as the session's Admin with only the path selector and the header key", async () => {
    const { db, ops } = fakeDb(staff("ADMIN"), () => penalized());
    const res = await call(db);
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(res.headers.get("idempotent-replay")).toBeNull();
    expect(body.data).toEqual({
      changed: true,
      team: {
        id: TEAM_ID,
        team_code: "T17",
        status: "ENDED",
        official_score: 0,
        penalized_at: DB_NOW,
      },
    });
    expect(ops()).toEqual([
      { fn: "penalize_team", args: { p_staff_id: STAFF_ID, p_team_id: TEAM_ID, p_idem_key: KEY } },
    ]);
  });

  it("flags a replay with a header and reports an already penalised team as changed:false", async () => {
    const a = fakeDb(staff("ADMIN"), () => penalized({ replayed: true }));
    expect((await call(a.db)).headers.get("idempotent-replay")).toBe("true");
    const b = fakeDb(staff("ADMIN"), () => penalized({ changed: false }));
    expect((await json(await call(b.db))).data.changed).toBe(false);
  });

  it("is for Admins only: a participant and the Super Admin are refused before any database work", async () => {
    for (const principal of [participant, staff("SUPER_ADMIN")]) {
      const { db, ops } = fakeDb(principal);
      const res = await call(db);
      expect(res.status).toBe(403);
      expect(ops()).toHaveLength(0);
    }
    const none = fakeDb({ ok: false, code: "UNAUTHENTICATED" });
    expect((await call(none.db)).status).toBe(401);
    expect(none.ops()).toHaveLength(0);
  });

  it("needs a same-origin request, a valid key, a UUID team and the strict confirmation body", async () => {
    const origin = fakeDb(staff("ADMIN"));
    expect(
      (
        await call(origin.db, {
          body: { confirm: true },
          headers: { origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    const noKey = fakeDb(staff("ADMIN"));
    expect(
      (await call(noKey.db, { body: { confirm: true }, headers: { "idempotency-key": "" } }))
        .status,
    ).toBe(400);
    const badKey = fakeDb(staff("ADMIN"));
    expect(
      (await call(badKey.db, { body: { confirm: true }, headers: { "idempotency-key": "x" } }))
        .status,
    ).toBe(400);
    const badId = fakeDb(staff("ADMIN"));
    expect((await call(badId.db, { body: { confirm: true } }, "not-a-uuid")).status).toBe(404);
    for (const body of [
      {},
      { confirm: false },
      { confirm: "true" },
      { confirm: true, score: 100 },
      { confirm: true, team_id: OTHER_TEAM_ID },
      [],
      "nope",
    ]) {
      const { db, ops } = fakeDb(staff("ADMIN"));
      const res = await call(db, { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(ops()).toHaveLength(0);
    }
    for (const f of [origin, noKey, badKey, badId]) expect(f.ops()).toHaveLength(0);
  });

  it("maps the engine's refusals: another admin's team is a 404, a team that has not started a 409", async () => {
    const notMine = fakeDb(staff("ADMIN"), () => raised("penalize_team", "NOT_FOUND"));
    expect((await call(notMine.db)).status).toBe(404);
    const idle = fakeDb(staff("ADMIN"), () => raised("penalize_team", "TEAM_NOT_STARTED"));
    const res = await call(idle.db);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("TEAM_NOT_STARTED");
    const reused = fakeDb(staff("ADMIN"), () => raised("penalize_team", "IDEMPOTENCY_KEY_REUSED"));
    expect((await call(reused.db)).status).toBe(409);
    const forbidden = fakeDb(staff("ADMIN"), () => raised("penalize_team", "FORBIDDEN"));
    expect((await call(forbidden.db)).status).toBe(403);
  });

  it("an unexpected database fault is a generic 503", async () => {
    const { db } = fakeDb(staff("ADMIN"), () => new DbError("penalize_team", "XX000"));
    const res = await call(db);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await json(res))).not.toContain("XX000");
  });

  it("a malformed result (an official score that is not 0) is a 503", async () => {
    const { db } = fakeDb(staff("ADMIN"), () =>
      penalized({ team: { ...penalized().team, official_score: 700 } }),
    );
    expect((await call(db)).status).toBe(503);
  });
});

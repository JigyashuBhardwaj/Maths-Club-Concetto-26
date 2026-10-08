import { describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import { generateSessionToken } from "@/lib/auth/session";
import { matrixResultSchema, teamThemeResultSchema } from "@/lib/contracts/matrix";
import { DbError, type Db, type DbFunction } from "@/lib/db/adapter";
import {
  createHeartbeatHandler,
  createMatrixHandler,
  createTeamThemeHandler,
  type MatrixDeps,
} from "@/lib/matrix/handlers";

const ORIGIN = "https://concetto.example";
const PEPPER = "pepper-for-tests-0123456789abcdef0123";
const NOW = 1_760_000_000_000;
const DB_NOW = 1_760_000_123_456;
const SESSION_ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const TEAM_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const MEMBER_ID = "9b2c1f4e-5d1a-4c3b-8e7f-0a1b2c3d4e5f";
const STAFF_ID = "1f0d3c2b-4a59-4687-9a7b-6c5d4e3f2a10";
const SUB_ID = "2a8f4c1e-6b3d-4e7a-9c50-1d2e3f4a5b6c";
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

const matrix = () => ({
  server_now: DB_NOW,
  presence_timeout_seconds: 75,
  teams: [
    {
      id: TEAM_ID,
      team_code: "T17",
      name: "Team Seventeen",
      status: "RUNNING",
      final_submitted: false,
      members: [
        { slot: 1, presence: "ONLINE" },
        { slot: 2, presence: "OFFLINE" },
      ],
      themes: [
        { code: "A", state: "GREEN", approved: 5, pending: 0 },
        { code: "B", state: "RED", approved: 1, pending: 1 },
        { code: "C", state: "NORMAL", approved: 0, pending: 0 },
      ],
    },
  ],
});
const themeResult = () => ({
  server_now: DB_NOW,
  team: { id: TEAM_ID, team_code: "T17", name: "Team Seventeen" },
  theme: { code: "B", name: "Number Theory" },
  questions: [1, 2, 3, 4, 5].map((n) => ({
    id: 5 + n,
    ordinal: n,
    label: `B.${n}`,
    color: n === 1 ? "GREEN" : n === 2 ? "RED" : "WHITE",
    state: n === 1 ? "APPROVED" : n === 2 ? "PENDING_APPROVAL" : "LOCKED",
    submission:
      n === 2
        ? {
            id: SUB_ID,
            body_md: "Find x.",
            answer: "x = 4",
            explanation: "because",
            submitted_by_slot: 2,
            submitted_at: NOW,
            reward_coins: 50,
          }
        : null,
  })),
});

type Call = { fn: DbFunction; args: Record<string, unknown> };
function fakeDb(
  principal: unknown,
  handler: (fn: DbFunction, args: Record<string, unknown>) => unknown,
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
  return { db, ops: () => calls.filter((c) => c.fn !== "resolve_session") };
}
const deps = (db: Db): MatrixDeps => ({
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
const req = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, cookie: COOKIE, ...headers },
    body,
  });
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });
const json = async (res: Response) => JSON.parse(await res.text());

describe("GET /api/admin/matrix", () => {
  it("returns the matrix of the session's Admin; the staff id is never taken from the request", async () => {
    const { db, ops } = fakeDb(staff("ADMIN"), () => matrix());
    const res = await createMatrixHandler(deps(db))(
      req("GET", `/api/admin/matrix?staff_id=${TEAM_ID}`, { "x-staff-id": TEAM_ID }),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.data.teams[0].themes.map((t: { state: string }) => t.state)).toEqual([
      "GREEN",
      "RED",
      "NORMAL",
    ]);
    expect(ops()).toEqual([{ fn: "admin_matrix", args: { p_staff_id: STAFF_ID } }]);
  });
  it("is for Admins only: participants and the Super Admin are refused before the database is asked", async () => {
    for (const principal of [participant, staff("SUPER_ADMIN")]) {
      const { db, ops } = fakeDb(principal, () => matrix());
      const res = await createMatrixHandler(deps(db))(req("GET", "/api/admin/matrix"));
      expect(res.status).toBe(403);
      expect(ops()).toEqual([]);
    }
  });
  it("needs a session", async () => {
    const { db, ops } = fakeDb({ ok: false, code: "UNAUTHENTICATED" }, () => matrix());
    const res = await createMatrixHandler(deps(db))(req("GET", "/api/admin/matrix"));
    expect(res.status).toBe(401);
    expect(ops()).toEqual([]);
  });
  it("strips anything the whitelist does not name and rejects a malformed answer", async () => {
    const leaky = matrix() as ReturnType<typeof matrix> & Record<string, unknown>;
    (leaky.teams[0] as Record<string, unknown>).password_hash = "SECRET";
    (leaky.teams[0] as Record<string, unknown>).login_id = "SECRET";
    const a = fakeDb(staff("ADMIN"), () => leaky);
    const res = await createMatrixHandler(deps(a.db))(req("GET", "/api/admin/matrix"));
    expect(JSON.stringify(await json(res))).not.toContain("SECRET");
    const b = fakeDb(staff("ADMIN"), () => ({ teams: [{ id: "x" }] }));
    expect((await createMatrixHandler(deps(b.db))(req("GET", "/api/admin/matrix"))).status).toBe(
      503,
    );
  });
});

describe("GET /api/admin/teams/:teamId/themes/:themeCode", () => {
  const path = `/api/admin/teams/${TEAM_ID}/themes/b`;
  it("normalises the theme code, takes the staff id from the session and returns the five questions", async () => {
    const { db, ops } = fakeDb(staff("ADMIN"), () => themeResult());
    const res = await createTeamThemeHandler(deps(db))(
      req("GET", path),
      ctx({ teamId: TEAM_ID, themeCode: "b" }),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data.questions).toHaveLength(5);
    expect(body.data.questions[1].submission).toMatchObject({ id: SUB_ID, answer: "x = 4" });
    expect(ops()).toEqual([
      {
        fn: "admin_team_theme",
        args: { p_staff_id: STAFF_ID, p_team_id: TEAM_ID, p_theme_code: "B" },
      },
    ]);
  });
  it("a malformed selector is a 404 before the database is touched", async () => {
    for (const params of [
      { teamId: "not-a-uuid", themeCode: "B" },
      { teamId: TEAM_ID, themeCode: "K" },
      { teamId: TEAM_ID, themeCode: "AB" },
      { teamId: TEAM_ID, themeCode: "1" },
    ]) {
      const { db, ops } = fakeDb(staff("ADMIN"), () => themeResult());
      const res = await createTeamThemeHandler(deps(db))(req("GET", path), ctx(params));
      expect(res.status).toBe(404);
      expect(ops()).toEqual([]);
    }
  });
  it("a team the Admin does not own is the database's NOT_FOUND, exactly like an unknown team", async () => {
    const { db } = fakeDb(
      staff("ADMIN"),
      () => new DbError("admin_team_theme", "P0001", { appCode: "NOT_FOUND" }),
    );
    const res = await createTeamThemeHandler(deps(db))(
      req("GET", path),
      ctx({ teamId: TEAM_ID, themeCode: "B" }),
    );
    expect(res.status).toBe(404);
  });
  it("refuses participants and the Super Admin without a database call", async () => {
    for (const principal of [participant, staff("SUPER_ADMIN")]) {
      const { db, ops } = fakeDb(principal, () => themeResult());
      const res = await createTeamThemeHandler(deps(db))(
        req("GET", path),
        ctx({ teamId: TEAM_ID, themeCode: "B" }),
      );
      expect(res.status).toBe(403);
      expect(ops()).toEqual([]);
    }
  });
});

describe("POST /api/p/heartbeat", () => {
  it("authenticates the participant (that is what stamps last_seen_at) and writes nothing else", async () => {
    const { db, ops } = fakeDb(participant, () => {
      throw new Error("no other database call is allowed");
    });
    const res = await createHeartbeatHandler(deps(db))(req("POST", "/api/p/heartbeat"));
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ server_now: NOW });
    expect(ops()).toEqual([]);
  });
  it("is POST-only same-origin, takes no body, and is for participants", async () => {
    const h = createHeartbeatHandler(deps(fakeDb(participant, () => ({})).db));
    expect(
      (await h(req("POST", "/api/p/heartbeat", { origin: "https://evil.example" }))).status,
    ).toBe(403);
    expect((await h(req("POST", "/api/p/heartbeat", {}, '{"team_id":"x"}'))).status).toBe(400);
    const staffHandler = createHeartbeatHandler(deps(fakeDb(staff("ADMIN"), () => ({})).db));
    expect((await staffHandler(req("POST", "/api/p/heartbeat"))).status).toBe(403);
  });
});

describe("matrix contracts", () => {
  it("accept the documented shapes", () => {
    expect(matrixResultSchema.safeParse(matrix()).success).toBe(true);
    expect(teamThemeResultSchema.safeParse(themeResult()).success).toBe(true);
  });
  it("a theme result must have exactly five questions and a known colour", () => {
    const four = { ...themeResult(), questions: themeResult().questions.slice(0, 4) };
    expect(teamThemeResultSchema.safeParse(four).success).toBe(false);
    const bad = themeResult();
    (bad.questions[0] as { color: string }).color = "BLUE";
    expect(teamThemeResultSchema.safeParse(bad).success).toBe(false);
  });
});

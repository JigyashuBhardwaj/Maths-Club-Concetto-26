import { describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import { generateSessionToken, hashSessionToken } from "@/lib/auth/session";
import { DbError, type Db, type DbFunction } from "@/lib/db/adapter";
import {
  createCompetitionStatusHandler,
  createStartTeamHandler,
  createTeamStateHandler,
  type RuntimeDeps,
} from "@/lib/runtime/handlers";

const ORIGIN = "https://concetto.example";
const PEPPER = "pepper-for-tests-0123456789abcdef0123";
const NOW = 1_760_000_000_000;
const DB_NOW = 1_760_000_123_456; // the database clock, deliberately different from the handler clock
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
  team: { id: TEAM_ID, code: "T17", name: "Team Seventeen", status: "NOT_STARTED" },
};
const staff = (role: "ADMIN" | "SUPER_ADMIN") => ({
  ok: true,
  role,
  session: { id: SESSION_ID, expires_at: EXPIRES },
  staff: { id: STAFF_ID, username: "asha", display_name: "Asha Rao" },
});

const themes = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1,
  code: "ABCDEFGHIJ"[i],
  name: `Theme ${"ABCDEFGHIJ"[i]}`,
  description: "A theme.",
  topics: ["algebra"],
  difficulty: "EASY",
  unlock_cost: 100,
  status: "LOCKED",
  questions: [],
}));
const teamState = (over: Record<string, unknown> = {}) => ({
  server_now: DB_NOW,
  state_version: 7,
  competition: { status: "RUNNING" },
  me: {
    member_id: MEMBER_ID,
    slot: 2,
    team_id: TEAM_ID,
    team_code: "T17",
    team_name: "Team Seventeen",
  },
  team: {
    status: "RUNNING",
    coins: 500,
    started_at: 1_760_000_000_000,
    ends_at: 1_760_007_200_000,
    ended_at: null,
    final_submitted_at: null,
    duration_seconds: 7200,
    remaining_seconds: 7199,
    expired: false,
  },
  themes,
  ...over,
});
const startResult = (over: Record<string, unknown> = {}) => ({
  replayed: false,
  started_now: true,
  state: teamState(),
  ...over,
});
const statusResult = (over: Record<string, unknown> = {}) => ({
  replayed: false,
  changed: true,
  action: "open",
  from: "SETUP",
  to: "RUNNING",
  teams_shifted: 0,
  teams_ended: 0,
  teams_total: 3,
  competition: {
    status: "RUNNING",
    opened_at: DB_NOW,
    paused_at: null,
    ended_at: null,
    state_version: 1,
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
function deps(db: Db): RuntimeDeps {
  return {
    db: () => db,
    env: () => ({
      APP_ORIGIN: ORIGIN,
      NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789",
      SESSION_TOKEN_PEPPER: PEPPER,
    }),
    now: () => NOW,
  };
}

const TOKEN = generateSessionToken();
const COOKIE = `${SESSION_COOKIE_NAME}=${TOKEN}`;
function post(path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    cookie: COOKIE,
    "idempotency-key": KEY,
    ...init.headers,
  };
  let body: string | undefined;
  if (init.body !== undefined) {
    body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    headers["content-type"] ??= "application/json";
  }
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body });
}
const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { method: "GET", headers: { cookie: COOKIE, ...headers } });
// Parsed response bodies are inspected loosely on purpose: the assertions name the fields they care about.
const json = async (res: Response) => JSON.parse(await res.text());
const raised = (appCode: string, details?: Record<string, unknown>) =>
  new DbError("start_team_competition", "P0001", { appCode, details });

describe("POST /api/p/start", () => {
  it("starts the team: 200, ids come from the session, the database clock is the envelope clock", async () => {
    const { db, calls, ops } = fakeDb(participant, () => startResult());
    const res = await createStartTeamHandler(deps(db))(post("/api/p/start"));
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("idempotent-replay")).toBeNull();
    expect(body.ok).toBe(true);
    expect(body.server_now).toBe(DB_NOW);
    expect(body.state_version).toBe(7);
    expect(body.data.started_now).toBe(true);
    expect(body.data.team).toMatchObject({
      status: "RUNNING",
      remaining_seconds: 7199,
      duration_seconds: 7200,
    });
    // the session lookup used only the peppered hash; the engine call used the session's ids and the header key
    expect(calls[0]).toEqual({
      fn: "resolve_session",
      args: { p_token_hash: hashSessionToken(TOKEN, PEPPER) },
    });
    expect(ops()).toEqual([
      {
        fn: "start_team_competition",
        args: { p_team_id: TEAM_ID, p_member_id: MEMBER_ID, p_idem_key: KEY },
      },
    ]);
  });

  it("never trusts the client: a team id in headers or body cannot reach the database", async () => {
    const { db, ops } = fakeDb(participant, () => startResult());
    const handler = createStartTeamHandler(deps(db));
    await handler(post("/api/p/start", { headers: { "x-team-id": OTHER_TEAM_ID } }));
    expect(ops()[0]?.args.p_team_id).toBe(TEAM_ID);
    const res = await handler(post("/api/p/start", { body: { teamId: OTHER_TEAM_ID } }));
    expect(res.status).toBe(400);
    expect(ops()).toHaveLength(1); // the second request never reached the engine
    const timer = await handler(post("/api/p/start", { body: { remaining_seconds: 99999 } }));
    expect(timer.status).toBe(400);
    expect(ops()).toHaveLength(1);
  });

  it("accepts an empty body or {}", async () => {
    const { db } = fakeDb(participant, () => startResult());
    const handler = createStartTeamHandler(deps(db));
    expect((await handler(post("/api/p/start", { body: "{}" }))).status).toBe(200);
    expect((await handler(post("/api/p/start", { body: "" }))).status).toBe(200);
  });

  it("requires a valid Idempotency-Key (400, nothing started)", async () => {
    const { db, ops } = fakeDb(participant, () => startResult());
    const handler = createStartTeamHandler(deps(db));
    for (const headers of [
      { "idempotency-key": "" },
      { "idempotency-key": "not-a-uuid" },
      { "idempotency-key": "5d6f1c1a3b8e4f0a9c217e4d2a9b8c10" },
    ]) {
      const res = await handler(post("/api/p/start", { headers }));
      const body = await json(res);
      expect(res.status).toBe(400);
      expect(body.error.code).toBe("VALIDATION_FAILED");
      expect(body.error.details).toEqual({ fields: ["Idempotency-Key"] });
    }
    const missing = new Request(`${ORIGIN}/api/p/start`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie: COOKIE },
    });
    expect((await handler(missing)).status).toBe(400);
    expect(ops()).toHaveLength(0);
  });

  it("a replay is a 200 with the same body and Idempotent-Replay: true", async () => {
    const { db } = fakeDb(participant, () => startResult({ replayed: true }));
    const res = await createStartTeamHandler(deps(db))(post("/api/p/start"));
    expect(res.status).toBe(200);
    expect(res.headers.get("idempotent-replay")).toBe("true");
    expect((await json(res)).data.started_now).toBe(true);
  });

  it("a second entry returns the existing timer: started_now false, same timestamps", async () => {
    const { db } = fakeDb(participant, () => startResult({ started_now: false }));
    const body = await json(await createStartTeamHandler(deps(db))(post("/api/p/start")));
    expect(body.data.started_now).toBe(false);
    expect(body.data.team.started_at).toBe(1_760_000_000_000);
    expect(body.data.team.ends_at).toBe(1_760_007_200_000);
  });

  it("403 for another origin, with no database access at all", async () => {
    const { db, calls } = fakeDb(participant);
    for (const origin of ["https://evil.example", "null", ""]) {
      const res = await createStartTeamHandler(deps(db))(
        post("/api/p/start", { headers: { origin } }),
      );
      expect(res.status).toBe(403);
      expect((await json(res)).error.code).toBe("FORBIDDEN");
    }
    expect(calls).toHaveLength(0);
  });

  it("401 without a session (and the dead cookie is cleared); 401 for a revoked session", async () => {
    const none = fakeDb(participant);
    const noCookie = await createStartTeamHandler(deps(none.db))(
      new Request(`${ORIGIN}/api/p/start`, {
        method: "POST",
        headers: { origin: ORIGIN, "idempotency-key": KEY },
      }),
    );
    expect(noCookie.status).toBe(401);
    expect(noCookie.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect(none.calls).toHaveLength(0);

    const dead = fakeDb({ ok: false, code: "UNAUTHENTICATED" });
    const res = await createStartTeamHandler(deps(dead.db))(post("/api/p/start"));
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("UNAUTHENTICATED");
    expect(dead.ops()).toHaveLength(0);
  });

  it("403 for staff: only a participant can enter the competition", async () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"] as const) {
      const { db, ops } = fakeDb(staff(role));
      const res = await createStartTeamHandler(deps(db))(post("/api/p/start"));
      expect(res.status).toBe(403);
      expect(ops()).toHaveLength(0);
    }
  });

  it.each([
    ["COMPETITION_NOT_RUNNING", 423],
    ["COMPETITION_PAUSED", 423],
    ["TEAM_ENDED", 409],
    ["ALREADY_SUBMITTED", 409],
    ["IDEMPOTENCY_KEY_REUSED", 409],
    ["FORBIDDEN", 403],
    ["NOT_FOUND", 404],
    ["VALIDATION_FAILED", 400],
  ])("maps the database code %s to HTTP %i", async (code, status) => {
    const { db } = fakeDb(participant, () => raised(code));
    const res = await createStartTeamHandler(deps(db))(post("/api/p/start"));
    const body = await json(res);
    expect(res.status).toBe(status);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe(code);
    expect(body.server_now).toBe(NOW);
  });

  it("uses the documented wording for ALREADY_SUBMITTED", async () => {
    const { db } = fakeDb(participant, () => raised("ALREADY_SUBMITTED"));
    expect(
      (await json(await createStartTeamHandler(deps(db))(post("/api/p/start")))).error.message,
    ).toBe("Team already submitted.");
  });

  it("raw database errors never reach the client: 503 with a generic message", async () => {
    const leaky = [
      new DbError("start_team_competition", "23505"),
      new DbError("start_team_competition", "P0001", { appCode: "SOME_UNKNOWN_CODE" }),
      new Error('duplicate key value violates unique constraint "teams_pkey" Key (id)=(secret)'),
    ];
    for (const err of leaky) {
      const { db } = fakeDb(participant, () => err);
      const res = await createStartTeamHandler(deps(db))(post("/api/p/start"));
      const text = await res.text();
      expect(res.status).toBe(503);
      expect(JSON.parse(text).error.code).toBe("SERVICE_UNAVAILABLE");
      expect(text).not.toMatch(/duplicate|teams_pkey|secret|23505|SOME_UNKNOWN/);
    }
  });

  it("a malformed database result is a 503, not a response", async () => {
    for (const bad of [
      null,
      {},
      startResult({ state: { ...teamState(), team: undefined } }),
      startResult({ state: teamState({ team: { ...teamState().team, remaining_seconds: 9000 } }) }),
    ]) {
      const { db } = fakeDb(participant, () => bad);
      const res = await createStartTeamHandler(deps(db))(post("/api/p/start"));
      expect(res.status).toBe(503);
    }
  });
});

describe("GET /api/p/state", () => {
  it("returns the snapshot of the caller's own team, with the database clock and version", async () => {
    const { db, ops } = fakeDb(participant, () => teamState());
    const res = await createTeamStateHandler(deps(db))(get("/api/p/state"));
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, server_now: DB_NOW, state_version: 7 });
    expect(Object.keys(body.data).sort()).toEqual([
      "competition",
      "me",
      "server_now",
      "state_version",
      "team",
      "themes",
    ]);
    expect(Object.keys(body.data.team).sort()).toEqual([
      "coins",
      "duration_seconds",
      "ended_at",
      "ends_at",
      "expired",
      "final_submitted_at",
      "remaining_seconds",
      "started_at",
      "status",
    ]);
    expect(body.data.themes).toHaveLength(10);
    expect(ops()).toEqual([
      { fn: "get_team_state", args: { p_team_id: TEAM_ID, p_member_id: MEMBER_ID } },
    ]);
  });

  it("ignores any team named in the URL or headers", async () => {
    const { db, ops } = fakeDb(participant, () => teamState());
    await createTeamStateHandler(deps(db))(
      get(`/api/p/state?teamId=${OTHER_TEAM_ID}&team_id=${OTHER_TEAM_ID}`, {
        "x-team-id": OTHER_TEAM_ID,
      }),
    );
    expect(ops()[0]?.args).toEqual({ p_team_id: TEAM_ID, p_member_id: MEMBER_ID });
  });

  it("whitelists the result: hashes and tokens the database might add are stripped", async () => {
    const leaky = teamState({
      password_hash: "$2a$12$abcdefghijklmnopqrstuv",
      token_hash: "\\xdeadbeef",
      team: { ...teamState().team, password_hash: "$2a$12$zzzz", admission_no: "23JE0001" },
      me: { ...teamState().me, login_id: "team17", admission_no: "23JE0001" },
    });
    const { db } = fakeDb(participant, () => leaky);
    const text = await (await createTeamStateHandler(deps(db))(get("/api/p/state"))).text();
    expect(text).not.toMatch(/hash|\$2a\$|deadbeef|admission|login_id|team17/i);
  });

  it("reports an expired team as expired with 0 seconds, without changing anything", async () => {
    const expired = teamState({
      team: { ...teamState().team, remaining_seconds: 0, expired: true },
    });
    const { db, ops } = fakeDb(participant, () => expired);
    const body = await json(await createTeamStateHandler(deps(db))(get("/api/p/state")));
    expect(body.data.team).toMatchObject({
      status: "RUNNING",
      remaining_seconds: 0,
      expired: true,
    });
    expect(ops().map((c) => c.fn)).toEqual(["get_team_state"]);
  });

  it("401 without a session, 403 for staff, 403/423 mapped from the database", async () => {
    const dead = fakeDb({ ok: false, code: "UNAUTHENTICATED" });
    expect((await createTeamStateHandler(deps(dead.db))(get("/api/p/state"))).status).toBe(401);
    const adm = fakeDb(staff("ADMIN"));
    expect((await createTeamStateHandler(deps(adm.db))(get("/api/p/state"))).status).toBe(403);
    expect(adm.ops()).toHaveLength(0);
    const forbidden = fakeDb(
      participant,
      () => new DbError("get_team_state", "P0001", { appCode: "FORBIDDEN" }),
    );
    expect((await createTeamStateHandler(deps(forbidden.db))(get("/api/p/state"))).status).toBe(
      403,
    );
  });
});

describe("POST /api/super/competition/status", () => {
  const body = { action: "open", confirm: true };

  it("changes the status: 200, session staff id, validated action, version from the database", async () => {
    const { db, ops } = fakeDb(staff("SUPER_ADMIN"), () => statusResult());
    const res = await createCompetitionStatusHandler(deps(db))(
      post("/api/super/competition/status", { body }),
    );
    const out = await json(res);
    expect(res.status).toBe(200);
    expect(out).toMatchObject({ ok: true, state_version: 1 });
    expect(out.data).toMatchObject({
      changed: true,
      from: "SETUP",
      to: "RUNNING",
      competition: { status: "RUNNING" },
    });
    expect(out.data.replayed).toBeUndefined();
    expect(ops()).toEqual([
      {
        fn: "set_competition_status",
        args: { p_staff_id: STAFF_ID, p_action: "open", p_idem_key: KEY },
      },
    ]);
  });

  it("403 for ADMIN and for participants, without touching the engine", async () => {
    for (const principal of [staff("ADMIN"), participant]) {
      const { db, ops } = fakeDb(principal, () => statusResult());
      const res = await createCompetitionStatusHandler(deps(db))(
        post("/api/super/competition/status", { body }),
      );
      expect(res.status).toBe(403);
      expect((await json(res)).error.code).toBe("FORBIDDEN");
      expect(ops()).toHaveLength(0);
    }
  });

  it("401 without a session; 403 for a foreign origin", async () => {
    const dead = fakeDb({ ok: false, code: "UNAUTHENTICATED" });
    expect(
      (
        await createCompetitionStatusHandler(deps(dead.db))(
          post("/api/super/competition/status", { body }),
        )
      ).status,
    ).toBe(401);
    const ok = fakeDb(staff("SUPER_ADMIN"), () => statusResult());
    const res = await createCompetitionStatusHandler(deps(ok.db))(
      post("/api/super/competition/status", { body, headers: { origin: "https://evil.example" } }),
    );
    expect(res.status).toBe(403);
    expect(ok.calls).toHaveLength(0);
  });

  it.each([
    ["missing confirm", { action: "open" }],
    ["confirm false", { action: "open", confirm: false }],
    ["confirm as a string", { action: "open", confirm: "true" }],
    ["unknown action", { action: "restart", confirm: true }],
    ["a target status instead of an action", { status: "RUNNING", confirm: true }],
    ["an extra field", { action: "open", confirm: true, teamId: TEAM_ID }],
    ["an array", []],
  ])("400 for %s", async (_name, bad) => {
    const { db, ops } = fakeDb(staff("SUPER_ADMIN"), () => statusResult());
    const res = await createCompetitionStatusHandler(deps(db))(
      post("/api/super/competition/status", { body: bad }),
    );
    const out = await json(res);
    expect(res.status).toBe(400);
    expect(out.error.code).toBe("VALIDATION_FAILED");
    expect(ops()).toHaveLength(0);
  });

  it("400 without an Idempotency-Key or with a non-JSON body", async () => {
    const { db, ops } = fakeDb(staff("SUPER_ADMIN"), () => statusResult());
    const handler = createCompetitionStatusHandler(deps(db));
    expect(
      (
        await handler(
          post("/api/super/competition/status", { body, headers: { "idempotency-key": "" } }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handler(
          post("/api/super/competition/status", {
            body: "action=open",
            headers: { "content-type": "text/plain" },
          }),
        )
      ).status,
    ).toBe(400);
    expect(ops()).toHaveLength(0);
  });

  it("an illegal transition is a 409 that says where the competition is", async () => {
    const { db } = fakeDb(staff("SUPER_ADMIN"), () =>
      raised("INVALID_COMPETITION_TRANSITION", { from: "ENDED", action: "open" }),
    );
    const res = await createCompetitionStatusHandler(deps(db))(
      post("/api/super/competition/status", { body }),
    );
    const out = await json(res);
    expect(res.status).toBe(409);
    expect(out.error).toMatchObject({
      code: "INVALID_COMPETITION_TRANSITION",
      details: { from: "ENDED", action: "open" },
    });
  });

  it("an unready competition is a 409 with the missing counts", async () => {
    const { db } = fakeDb(staff("SUPER_ADMIN"), () =>
      raised("COMPETITION_NOT_READY", { teams: 0, themes: 10, questions: 50 }),
    );
    const out = await json(
      await createCompetitionStatusHandler(deps(db))(
        post("/api/super/competition/status", { body }),
      ),
    );
    expect(out.error.details).toEqual({ teams: 0, themes: 10, questions: 50 });
  });

  it("a no-op (already in that state) and a replay are both 200s", async () => {
    const noop = fakeDb(staff("SUPER_ADMIN"), () =>
      statusResult({
        changed: false,
        from: "RUNNING",
        to: "RUNNING",
        teams_shifted: undefined,
        teams_ended: undefined,
        teams_total: undefined,
      }),
    );
    const a = await json(
      await createCompetitionStatusHandler(deps(noop.db))(
        post("/api/super/competition/status", { body }),
      ),
    );
    expect(a.data.changed).toBe(false);
    const replay = fakeDb(staff("SUPER_ADMIN"), () => statusResult({ replayed: true }));
    const res = await createCompetitionStatusHandler(deps(replay.db))(
      post("/api/super/competition/status", { body }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("idempotent-replay")).toBe("true");
  });

  it("reports the pause that a resume absorbed", async () => {
    const { db } = fakeDb(staff("SUPER_ADMIN"), () =>
      statusResult({
        action: "resume",
        from: "PAUSED",
        to: "RUNNING",
        paused_seconds: 1800,
        teams_shifted: 3,
      }),
    );
    const out = await json(
      await createCompetitionStatusHandler(deps(db))(
        post("/api/super/competition/status", { body: { action: "resume", confirm: true } }),
      ),
    );
    expect(out.data).toMatchObject({ paused_seconds: 1800, teams_shifted: 3 });
  });
});

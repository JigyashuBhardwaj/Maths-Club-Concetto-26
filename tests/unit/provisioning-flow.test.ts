import { describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import {
  createParticipantLoginHandler,
  createStaffLoginHandler,
  type AuthDeps,
} from "@/lib/auth/handlers";
import type { Db, DbFunction } from "@/lib/db/adapter";
import {
  createCreateAdminHandler,
  createCreateTeamHandler,
  createLeaderboardHandler,
  createListTeamsHandler,
} from "@/lib/provisioning/handlers";

import { createFakeBackend } from "../e2e/support/fake-postgrest.mjs";

/**
 * The provisioning handlers (B12) wired to the in-memory backend of the browser tests: the central acceptance slice at
 * handler level. The SQL itself (hashing, constraints, atomicity, races) is proven against real PostgreSQL by
 * supabase/tests/90_provisioning.test.sql and the concurrency script; this file proves the API layer: who may call what,
 * that the owner always comes from the session, strict bodies, idempotency keys, safe errors, and no leaks.
 */
const ORIGIN = "https://concetto.example";
const PEPPER = "pepper-for-tests-0123456789abcdef0123";
const identities = {
  staff: [
    { username: "root", password: "root-password-1", displayName: "Root", role: "SUPER_ADMIN" },
    {
      username: "existing_admin",
      password: "existing-pw-1",
      displayName: "Existing",
      role: "ADMIN",
    },
  ],
  teams: [
    {
      code: "OLD1",
      name: "Old Team",
      loginId: "old_team",
      password: "old-team-pw-1",
      members: [
        { slot: 1, admissionNo: "OLD11" },
        { slot: 2, admissionNo: "OLD12" },
        { slot: 3, admissionNo: "OLD13" },
        { slot: 4, admissionNo: "OLD14" },
      ],
    },
  ],
};

function setup() {
  const backend = createFakeBackend(identities);
  const db: Db = {
    async rpc(fn: DbFunction, args: Record<string, unknown>) {
      let out: unknown;
      try {
        out = backend.rpc(fn, args);
      } catch (err) {
        // what supabase-js / toDbError would see for `raise exception` (SQLSTATE P0001)
        const e = err as { message: string; details?: unknown };
        const { DbError } = await import("@/lib/db/adapter");
        throw new DbError(fn, "P0001", {
          appCode: e.message,
          details: e.details as Record<string, unknown> | undefined,
        });
      }
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
    staffLogin: createStaffLoginHandler(deps),
    participantLogin: createParticipantLoginHandler(deps),
    createAdmin: createCreateAdminHandler(deps),
    createTeam: createCreateTeamHandler(deps),
    listTeams: createListTeamsHandler(deps),
    leaderboard: createLeaderboardHandler(deps),
  };
}
type T = ReturnType<typeof setup>;

let keyCounter = 0;
const newKey = () => `00000000-0000-4000-8000-${String(++keyCounter).padStart(12, "0")}`;

function post(path: string, body: unknown, cookie?: string, key: string | null = newKey()) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}
const get = (path: string, cookie?: string) =>
  new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });

async function cookieFrom(res: Response): Promise<string> {
  const set = res.headers.get("set-cookie") ?? "";
  expect(set.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
  return set.split(";")[0]!;
}
async function staffCookie(t: T, username: string, password: string) {
  const res = await t.staffLogin(
    post("/api/auth/staff/login", { username, password }, undefined, null),
  );
  expect(res.status).toBe(200);
  return cookieFrom(res);
}

const adminBody = {
  username: "alice",
  password: "alice-password-1",
  confirmPassword: "alice-password-1",
};
const teamBody = {
  teamCode: "t1",
  name: "The Euclids",
  loginId: "euclids",
  password: "team-password-1",
  confirmPassword: "team-password-1",
  admissionNos: ["23JE0001", "23JE0002", "23JE0003", "23JE0004"],
};

describe("the central slice: Super Admin → Admin → Team → participant", () => {
  it("creates an Admin who can sign in, who creates a Team that the participant can sign in to; another Admin cannot see it", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");

    // Super Admin creates Admin A and Admin B
    const a = await t.createAdmin(post("/api/super/admins", adminBody, root));
    expect(a.status).toBe(200);
    const aBody = (await a.json()) as { ok: boolean; data: { admin: Record<string, unknown> } };
    expect(aBody.data.admin).toMatchObject({ username: "alice", role: "ADMIN", is_active: true });
    const b = await t.createAdmin(
      post(
        "/api/super/admins",
        {
          ...adminBody,
          username: "bob",
          password: "bob-password-1",
          confirmPassword: "bob-password-1",
        },
        root,
      ),
    );
    expect(b.status).toBe(200);

    // each new Admin signs in immediately; the server decides the role
    const login = await t.staffLogin(
      post(
        "/api/auth/staff/login",
        { username: "alice", password: "alice-password-1" },
        undefined,
        null,
      ),
    );
    expect(login.status).toBe(200);
    expect(((await login.json()) as { data: { role: string } }).data.role).toBe("ADMIN");
    const alice = await cookieFrom(login);
    const bob = await staffCookie(t, "bob", "bob-password-1");

    // Alice creates T1; the owner is Alice (nothing in the body names an owner)
    const made = await t.createTeam(post("/api/admin/teams", teamBody, alice));
    expect(made.status).toBe(200);
    const madeJson = (await made.json()) as { data: { team: Record<string, unknown> } };
    expect(madeJson.data.team).toMatchObject({
      team_code: "T1",
      name: "The Euclids",
      login_id: "euclids",
      status: "NOT_STARTED",
      coins: 500,
      member_count: 4,
    });

    // T1 appears in Alice's My teams, and only there
    const mine = (await (await t.listTeams(get("/api/admin/teams", alice))).json()) as {
      data: { teams: { team_code: string }[] };
    };
    expect(mine.data.teams.map((x) => x.team_code)).toEqual(["T1"]);
    const bobs = (await (await t.listTeams(get("/api/admin/teams", bob))).json()) as {
      data: { teams: unknown[] };
    };
    expect(bobs.data.teams).toEqual([]);

    // the participant signs in with the Team Login ID + password + M1's admission number (case-insensitively)
    for (const slot of ["23je0001", "23JE0004"]) {
      const p = await t.participantLogin(
        post(
          "/api/auth/participant/login",
          { teamLoginId: "euclids", password: "team-password-1", admissionNo: slot },
          undefined,
          null,
        ),
      );
      expect(p.status).toBe(200);
      expect(
        ((await p.json()) as { data: { role: string; team: { code: string } } }).data,
      ).toMatchObject({
        role: "PARTICIPANT",
        team: { code: "T1" },
      });
    }
    const bad = await t.participantLogin(
      post(
        "/api/auth/participant/login",
        { teamLoginId: "euclids", password: "team-password-1", admissionNo: "23JE9999" },
        undefined,
        null,
      ),
    );
    expect(bad.status).toBe(401);
  });
});

describe("authorisation (server-side, by the session's role)", () => {
  it("only a signed-in Super Admin may create an Admin", async () => {
    const t = setup();
    expect((await t.createAdmin(post("/api/super/admins", adminBody))).status).toBe(401);
    expect(
      (await t.createAdmin(post("/api/super/admins", adminBody, `${SESSION_COOKIE_NAME}=bad`)))
        .status,
    ).toBe(401);
    const adminCookie = await staffCookie(t, "existing_admin", "existing-pw-1");
    const denied = await t.createAdmin(post("/api/super/admins", adminBody, adminCookie));
    expect(denied.status).toBe(403);
    // a participant cannot either
    const p = await t.participantLogin(
      post(
        "/api/auth/participant/login",
        { teamLoginId: "old_team", password: "old-team-pw-1", admissionNo: "OLD11" },
        undefined,
        null,
      ),
    );
    const participant = await cookieFrom(p);
    expect((await t.createAdmin(post("/api/super/admins", adminBody, participant))).status).toBe(
      403,
    );
    expect(t.backend.controls.counts().staff).toBe(2);
  });

  it("only an Admin may create a team; the Super Admin and a participant may not", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    expect((await t.createTeam(post("/api/admin/teams", teamBody))).status).toBe(401);
    expect((await t.createTeam(post("/api/admin/teams", teamBody, root))).status).toBe(403);
    const p = await t.participantLogin(
      post(
        "/api/auth/participant/login",
        { teamLoginId: "old_team", password: "old-team-pw-1", admissionNo: "OLD11" },
        undefined,
        null,
      ),
    );
    expect(
      (await t.createTeam(post("/api/admin/teams", teamBody, await cookieFrom(p)))).status,
    ).toBe(403);
    expect(t.backend.controls.counts().teams).toBe(1);
  });

  it("My teams is the caller's own list: another Admin's teams, and the pre-existing ones, never appear", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    await t.createAdmin(post("/api/super/admins", adminBody, root));
    const alice = await staffCookie(t, "alice", "alice-password-1");
    const old = await staffCookie(t, "existing_admin", "existing-pw-1");
    await t.createTeam(post("/api/admin/teams", teamBody, alice));
    const aliceList = (await (await t.listTeams(get("/api/admin/teams", alice))).json()) as {
      data: { teams: { team_code: string }[] };
    };
    const oldList = (await (await t.listTeams(get("/api/admin/teams", old))).json()) as {
      data: { teams: { team_code: string }[] };
    };
    expect(aliceList.data.teams.map((x) => x.team_code)).toEqual(["T1"]);
    expect(oldList.data.teams.map((x) => x.team_code)).toEqual(["OLD1"]);
    // the Super Admin has no My teams, and an unauthenticated caller gets nothing
    expect((await t.listTeams(get("/api/admin/teams", root))).status).toBe(403);
    expect((await t.listTeams(get("/api/admin/teams"))).status).toBe(401);
  });

  it("the leaderboard is readable by staff only, ranks every team, and returns nothing else", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    await t.createAdmin(post("/api/super/admins", adminBody, root));
    const alice = await staffCookie(t, "alice", "alice-password-1");
    await t.createTeam(post("/api/admin/teams", teamBody, alice));
    // B16: the score is derived (a team that has not started shows its coins), so the test sets the balance
    t.backend.controls.setCoins({ loginId: teamBody.loginId, coins: 750 });
    for (const cookie of [root, alice]) {
      const res = await t.leaderboard(get("/api/leaderboard", cookie));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(JSON.parse(text).data.rows).toEqual([
        { rank: 1, team_id: "T1", score: 750 },
        { rank: 2, team_id: "OLD1", score: 500 },
      ]);
      for (const secret of ["euclids", "23JE", "password", "hash", "The Euclids"]) {
        expect(text).not.toContain(secret);
      }
    }
    expect((await t.leaderboard(get("/api/leaderboard"))).status).toBe(401);
    const p = await t.participantLogin(
      post(
        "/api/auth/participant/login",
        { teamLoginId: "old_team", password: "old-team-pw-1", admissionNo: "OLD11" },
        undefined,
        null,
      ),
    );
    expect((await t.leaderboard(get("/api/leaderboard", await cookieFrom(p)))).status).toBe(403);
  });
});

describe("request rules", () => {
  it("refuses another origin, a missing or malformed Idempotency-Key, and a non-JSON body", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    const alien = new Request(`${ORIGIN}/api/super/admins`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        cookie: root,
        "idempotency-key": newKey(),
      },
      body: JSON.stringify(adminBody),
    });
    expect((await t.createAdmin(alien)).status).toBe(403);
    expect((await t.createAdmin(post("/api/super/admins", adminBody, root, null))).status).toBe(
      400,
    );
    expect(
      (await t.createAdmin(post("/api/super/admins", adminBody, root, "not-a-uuid"))).status,
    ).toBe(400);
    const text = new Request(`${ORIGIN}/api/super/admins`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: ORIGIN,
        cookie: root,
        "idempotency-key": newKey(),
      },
      body: JSON.stringify(adminBody),
    });
    expect((await t.createAdmin(text)).status).toBe(400);
    expect(t.backend.controls.counts().staff).toBe(2);
  });

  it("is strict: a client-supplied owner, role, coins or any unknown field is rejected, never used", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    await t.createAdmin(post("/api/super/admins", adminBody, root));
    const alice = await staffCookie(t, "alice", "alice-password-1");
    const old = t.backend.controls.counts();
    for (const extra of [
      { adminId: "00000000-0000-4000-8000-0000000000aa" },
      { admin_id: "x" },
      { coins: 9999 },
      { initialCoins: 9999 },
      { status: "RUNNING" },
      { owner: "existing_admin" },
    ]) {
      const res = await t.createTeam(post("/api/admin/teams", { ...teamBody, ...extra }, alice));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_FAILED");
    }
    for (const extra of [{ role: "SUPER_ADMIN" }, { isActive: false }, { displayName: "x" }]) {
      const res = await t.createAdmin(
        post("/api/super/admins", { ...adminBody, username: "carol", ...extra }, root),
      );
      expect(res.status).toBe(400);
    }
    expect(t.backend.controls.counts()).toEqual(old);
  });

  it("validates on the server and reports field NAMES only (never the values)", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    const res = await t.createAdmin(
      post(
        "/api/super/admins",
        { username: "ab", password: "short-pw", confirmPassword: "different" },
        root,
      ),
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    const body = JSON.parse(text) as { error: { details: { fields: string[] } } };
    expect(body.error.details.fields.sort()).toEqual(["confirmPassword", "password", "username"]);
    expect(text).not.toContain("short-pw");
    expect(text).not.toContain("different");

    await t.createAdmin(post("/api/super/admins", adminBody, root));
    const alice = await staffCookie(t, "alice", "alice-password-1");
    const bad = await t.createTeam(
      post(
        "/api/admin/teams",
        { ...teamBody, confirmPassword: "nope-nope-1", admissionNos: ["A1", "a1", "", "ok"] },
        alice,
      ),
    );
    expect(bad.status).toBe(400);
    const fields = ((await bad.json()) as { error: { details: { fields: string[] } } }).error
      .details.fields;
    expect(fields).toEqual(
      expect.arrayContaining(["confirmPassword", "admissionNos.2", "admissionNos.3"]),
    );
    // three admission numbers is a shape error, not a half-created team
    const three = await t.createTeam(
      post("/api/admin/teams", { ...teamBody, admissionNos: ["A1", "A2", "A3"] }, alice),
    );
    expect(three.status).toBe(400);
    expect(t.backend.controls.counts().teams).toBe(1);
  });
});

describe("duplicates and idempotency", () => {
  it("rejects a duplicate username, Team ID, Login ID and admission number with safe, specific codes", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    await t.createAdmin(post("/api/super/admins", adminBody, root));
    const dup = await t.createAdmin(
      post("/api/super/admins", { ...adminBody, username: "ALICE" }, root),
    );
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("USERNAME_TAKEN");

    const alice = await staffCookie(t, "alice", "alice-password-1");
    expect((await t.createTeam(post("/api/admin/teams", teamBody, alice))).status).toBe(200);
    const cases: [Record<string, unknown>, string][] = [
      [{ loginId: "other_login", admissionNos: ["N1", "N2", "N3", "N4"] }, "TEAM_CODE_TAKEN"],
      [
        { teamCode: "T9", loginId: "EUCLIDS", admissionNos: ["N1", "N2", "N3", "N4"] },
        "LOGIN_ID_TAKEN",
      ],
      [
        { teamCode: "T9", loginId: "other_login", admissionNos: ["N1", "n2", "OLD13", "N4"] },
        "ADMISSION_NO_TAKEN",
      ],
    ];
    for (const [patch, code] of cases) {
      const res = await t.createTeam(post("/api/admin/teams", { ...teamBody, ...patch }, alice));
      expect(res.status).toBe(409);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe(code);
      expect(text).not.toContain("OLD13");
    }
    const taken = (await (
      await t.createTeam(
        post(
          "/api/admin/teams",
          {
            ...teamBody,
            teamCode: "T9",
            loginId: "other_login",
            admissionNos: ["N1", "N2", "OLD13", "N4"],
          },
          alice,
        ),
      )
    ).json()) as {
      error: { details: { slot: number } };
    };
    expect(taken.error.details).toEqual({ slot: 3 });
    expect(t.backend.controls.counts().teams).toBe(2);
  });

  it("a retry with the same Idempotency-Key replays the stored response and creates nothing", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    const key = newKey();
    const first = await t.createAdmin(post("/api/super/admins", adminBody, root, key));
    const again = await t.createAdmin(post("/api/super/admins", adminBody, root, key));
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replay")).toBe("true");
    expect(first.headers.get("idempotent-replay")).toBeNull();
    expect(((await again.json()) as { data: unknown }).data).toEqual(
      ((await first.json()) as { data: unknown }).data,
    );
    expect(t.backend.controls.counts().staff).toBe(3);

    await t.createAdmin(post("/api/super/admins", { ...adminBody, username: "carol" }, root));
    const alice = await staffCookie(t, "alice", "alice-password-1");
    const teamKey = newKey();
    const t1 = await t.createTeam(post("/api/admin/teams", teamBody, alice, teamKey));
    const t2 = await t.createTeam(post("/api/admin/teams", teamBody, alice, teamKey));
    expect(t2.headers.get("idempotent-replay")).toBe("true");
    expect(((await t2.json()) as { data: unknown }).data).toEqual(
      ((await t1.json()) as { data: unknown }).data,
    );
    const counts = t.backend.controls.counts();
    expect(counts.teams).toBe(2);
    expect(counts.members).toBe(8);

    // the same key for a different request is refused, not silently replayed
    const reused = await t.createTeam(
      post(
        "/api/admin/teams",
        { ...teamBody, teamCode: "T2", loginId: "second", admissionNos: ["S1", "S2", "S3", "S4"] },
        alice,
        teamKey,
      ),
    );
    expect(reused.status).toBe(409);
    expect(((await reused.json()) as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_KEY_REUSED",
    );
  });
});

describe("no leaks", () => {
  it("never returns a password, a hash, an admission number or a session token", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    const bodies: string[] = [];
    bodies.push(await (await t.createAdmin(post("/api/super/admins", adminBody, root))).text());
    const alice = await staffCookie(t, "alice", "alice-password-1");
    bodies.push(await (await t.createTeam(post("/api/admin/teams", teamBody, alice))).text());
    bodies.push(await (await t.listTeams(get("/api/admin/teams", alice))).text());
    bodies.push(await (await t.leaderboard(get("/api/leaderboard", alice))).text());
    const token = alice.split("=")[1]!;
    for (const body of bodies) {
      for (const secret of [
        "alice-password-1",
        "team-password-1",
        "23JE0001",
        "password_hash",
        "passwordHash",
        token,
        "bcrypt",
        "$2a$",
      ]) {
        expect(body).not.toContain(secret);
      }
    }
  });

  it("turns an unexpected database fault into a generic 503 without its text", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    const broken: AuthDeps = {
      db: () => ({
        rpc: async () => {
          throw new Error("connection to 10.0.0.5:5432 refused for user postgres password=hunter2");
        },
      }),
      env: () => ({
        APP_ORIGIN: ORIGIN,
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
        SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40),
        SESSION_TOKEN_PEPPER: PEPPER,
      }),
      now: () => Date.now(),
    };
    const res = await createCreateAdminHandler(broken)(post("/api/super/admins", adminBody, root));
    // the session cannot be resolved because the database is down: a generic retryable 503, never the raw text
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text).error.code).toBe("SERVICE_UNAVAILABLE");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("10.0.0.5");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import {
  createParticipantLoginHandler,
  createStaffLoginHandler,
  type AuthDeps,
} from "@/lib/auth/handlers";
import {
  createDeleteAdminsHandler,
  createDeleteTeamsHandler,
  createListDeletableAdminsHandler,
  createListDeletableTeamsHandler,
} from "@/lib/deletion/handlers";
import { DbError, type Db, type DbFunction } from "@/lib/db/adapter";
import {
  createCreateAdminHandler,
  createCreateTeamHandler,
  createLeaderboardHandler,
} from "@/lib/provisioning/handlers";

import { createFakeBackend } from "../e2e/support/fake-postgrest.mjs";

/**
 * The B18 handlers wired to the in-memory backend of the browser tests: who may list and delete, that the staff id always
 * comes from the session, strict bodies and selections, idempotency, safe errors, no leaks, and that a deleted account's
 * cookies and credentials stop working while its login names can be used again. The SQL itself (complete erasure, request-log cleanup, ledger,
 * atomicity, races) is proven against real PostgreSQL by supabase/tests/190_super_admin_deletion.test.sql and
 * concurrency/team_deletion.concurrency.mjs; this file proves the API layer.
 */
const ORIGIN = "https://concetto.example";
const PEPPER = "pepper-for-tests-0123456789abcdef0123";
const member = (code: string, n: number) => ({ slot: n, admissionNo: `${code}${n}` });
const identities = {
  staff: [
    { username: "root", password: "root-password-1", displayName: "Root", role: "SUPER_ADMIN" },
    { username: "adm_one", password: "admin-one-pw-1", displayName: "One", role: "ADMIN" },
    { username: "adm_two", password: "admin-two-pw-1", displayName: "Two", role: "ADMIN" },
  ],
  teams: [
    {
      code: "TA",
      name: "Team A",
      loginId: "team_a",
      password: "team-a-pw-123",
      members: [1, 2, 3, 4].map((n) => member("A", n)),
    },
    {
      code: "TB",
      name: "Team B",
      loginId: "team_b",
      password: "team-b-pw-123",
      members: [1, 2, 3, 4].map((n) => member("B", n)),
    },
  ],
};

function setup(dbWrap?: (db: Db) => Db) {
  const backend = createFakeBackend(identities);
  const raw: Db = {
    async rpc(fn: DbFunction, args: Record<string, unknown>) {
      let out: unknown;
      try {
        out = backend.rpc(fn, args);
      } catch (err) {
        const e = err as { message: string; details?: unknown };
        throw new DbError(fn, "P0001", {
          appCode: e.message,
          details: e.details as Record<string, unknown> | undefined,
        });
      }
      if (out === undefined) throw new Error(`no such function ${fn}`);
      return out;
    },
  };
  const db = dbWrap ? dbWrap(raw) : raw;
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
    leaderboard: createLeaderboardHandler(deps),
    listAdmins: createListDeletableAdminsHandler(deps),
    listTeams: createListDeletableTeamsHandler(deps),
    deleteAdmins: createDeleteAdminsHandler(deps),
    deleteTeams: createDeleteTeamsHandler(deps),
  };
}
type T = ReturnType<typeof setup>;

let keyCounter = 0;
const newKey = () => `00000000-0000-4000-8000-${String(++keyCounter).padStart(12, "0")}`;

function post(
  path: string,
  body: unknown,
  cookie?: string,
  key: string | null = newKey(),
  extra: Record<string, string> = {},
) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
      ...(key ? { "idempotency-key": key } : {}),
      ...extra,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
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
async function teamCookie(t: T, loginId: string, password: string, admissionNo: string) {
  const res = await t.participantLogin(
    post(
      "/api/auth/participant/login",
      { teamLoginId: loginId, password, admissionNo },
      undefined,
      null,
    ),
  );
  expect(res.status).toBe(200);
  return cookieFrom(res);
}
type Envelope = {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; details?: Record<string, unknown> };
};
const json = async (res: Response): Promise<Envelope> => (await res.json()) as Envelope;

async function adminsOf(t: T, root: string) {
  const r = await json(await t.listAdmins(get("/api/super/admins", root)));
  return (r.data as { admins: { id: string; username: string; team_count: number }[] }).admins;
}
async function teamsOf(t: T, root: string) {
  const r = await json(await t.listTeams(get("/api/super/teams", root)));
  return (r.data as { teams: { id: string; team_code: string; admin_username: string }[] }).teams;
}
async function canCall(t: T, cookie: string) {
  return (await t.leaderboard(get("/api/leaderboard", cookie))).status;
}

describe("authorisation: only an active, signed-in SUPER_ADMIN lists and deletes", () => {
  it("rejects every anonymous, admin and participant call to all four endpoints", async () => {
    const t = setup();
    const admin = await staffCookie(t, "adm_one", "admin-one-pw-1");
    const participant = await teamCookie(t, "team_a", "team-a-pw-123", "A1");
    const root = await staffCookie(t, "root", "root-password-1");
    const [ta] = await teamsOf(t, root);
    const [, a1] = await adminsOf(t, root);
    const calls = (cookie?: string) => [
      t.listAdmins(get("/api/super/admins", cookie)),
      t.listTeams(get("/api/super/teams", cookie)),
      t.deleteAdmins(post("/api/super/admins/delete", { adminIds: [a1!.id] }, cookie)),
      t.deleteTeams(post("/api/super/teams/delete", { teamIds: [ta!.id] }, cookie)),
    ];
    for (const r of await Promise.all(calls())) expect(r.status).toBe(401);
    for (const r of await Promise.all(calls(`${SESSION_COOKIE_NAME}=forged`)))
      expect(r.status).toBe(401);
    for (const r of await Promise.all(calls(admin))) expect(r.status).toBe(403);
    for (const r of await Promise.all(calls(participant))) expect(r.status).toBe(403);
    // nothing was deleted by any of them
    expect(t.backend.controls.counts()).toMatchObject({ staff: 3, teams: 2 });
  });

  it("ignores a forged role, staff id or owner: the body is strict and the principal is the session", async () => {
    const t = setup();
    const admin = await staffCookie(t, "adm_one", "admin-one-pw-1");
    const root = await staffCookie(t, "root", "root-password-1");
    const [ta] = await teamsOf(t, root);
    // an Admin cookie plus a body claiming to be the Super Admin: refused by role, before the body is even read
    const forged = await t.deleteTeams(
      post(
        "/api/super/teams/delete",
        { teamIds: [ta!.id], staffId: "x", role: "SUPER_ADMIN" },
        admin,
      ),
    );
    expect(forged.status).toBe(403);
    // the Super Admin cookie with extra fields is a 400 (strict), and nothing is deleted
    for (const extra of [
      { staffId: ta!.id },
      { role: "SUPER_ADMIN" },
      { adminId: ta!.id },
      { force: true },
    ]) {
      const r = await t.deleteTeams(
        post("/api/super/teams/delete", { teamIds: [ta!.id], ...extra }, root),
      );
      expect(r.status).toBe(400);
    }
    // a staff-id header is just a header
    const hdr = await t.deleteTeams(
      post("/api/super/teams/delete", { teamIds: [ta!.id] }, admin, newKey(), {
        "x-staff-id": "root",
      }),
    );
    expect(hdr.status).toBe(403);
    expect(t.backend.controls.counts().teams).toBe(2);
  });

  it("refuses a cross-origin POST and a missing or malformed Idempotency-Key", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    const [ta] = await teamsOf(t, root);
    const body = { teamIds: [ta!.id] };
    const evil = new Request(`${ORIGIN}/api/super/teams/delete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        cookie: root,
        "idempotency-key": newKey(),
      },
      body: JSON.stringify(body),
    });
    expect((await t.deleteTeams(evil)).status).toBe(403);
    expect((await t.deleteTeams(post("/api/super/teams/delete", body, root, null))).status).toBe(
      400,
    );
    expect(
      (await t.deleteTeams(post("/api/super/teams/delete", body, root, "not-a-uuid"))).status,
    ).toBe(400);
    expect(t.backend.controls.counts().teams).toBe(2);
  });

  it("the Super Admin cannot be deleted, alone or inside a selection; nothing else in the request goes either", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    const admins = await adminsOf(t, root);
    expect(admins.map((a) => a.username)).toEqual(["adm_one", "adm_two"]); // never listed
    const rootId = t.backend.controls.staffId({ username: "root" }) as string;
    expect(typeof rootId).toBe("string");
    const alone = await t.deleteAdmins(
      post("/api/super/admins/delete", { adminIds: [rootId] }, root),
    );
    expect(alone.status).toBe(403);
    const mixed = await t.deleteAdmins(
      post("/api/super/admins/delete", { adminIds: [admins[0]!.id, rootId] }, root),
    );
    expect(mixed.status).toBe(403);
    expect((await adminsOf(t, root)).length).toBe(2);
    expect(await canCall(t, root)).toBe(200);
  });
});

describe("strict selections", () => {
  it("rejects empty, malformed, duplicate, oversized and non-array selections with a 400 and changes nothing", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    const [ta] = await teamsOf(t, root);
    const id = ta!.id;
    const many = Array.from(
      { length: 101 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const bad: unknown[] = [
      {},
      { teamIds: [] },
      { teamIds: "x" },
      { teamIds: [id, id] },
      { teamIds: [id, id.toUpperCase()] },
      { teamIds: ["not-a-uuid"] },
      { teamIds: [1] },
      { teamIds: [null] },
      { teamIds: many },
      [id],
      "nope",
    ];
    for (const body of bad) {
      const r = await t.deleteTeams(post("/api/super/teams/delete", body, root));
      expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    const notJson = await t.deleteTeams(post("/api/super/teams/delete", "{broken", root));
    expect(notJson.status).toBe(400);
    expect(t.backend.controls.counts().teams).toBe(2);
  });

  it("an unknown id is a 404 and the known id in the same request is NOT deleted", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    const [ta] = await teamsOf(t, root);
    const unknown = "00000000-0000-4000-8000-0000000000ff";
    const r = await t.deleteTeams(
      post("/api/super/teams/delete", { teamIds: [ta!.id, unknown] }, root),
    );
    expect(r.status).toBe(404);
    expect(t.backend.controls.counts().teams).toBe(2);
    // a team id is not an admin id and vice versa
    const [a1] = await adminsOf(t, root);
    expect(
      (await t.deleteAdmins(post("/api/super/admins/delete", { adminIds: [ta!.id] }, root))).status,
    ).toBe(404);
    expect(
      (await t.deleteTeams(post("/api/super/teams/delete", { teamIds: [a1!.id] }, root))).status,
    ).toBe(404);
  });
});

describe("correctness and isolation", () => {
  it("lists every team of every admin and every admin with its team count, and no secret", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    const raw = JSON.stringify([
      await (await t.listAdmins(get("/api/super/admins", root))).json(),
      await (await t.listTeams(get("/api/super/teams", root))).json(),
    ]);
    expect(raw).not.toMatch(/password|hash|token|secret/i);
    const teams = await teamsOf(t, root);
    expect(teams.map((x) => x.team_code)).toEqual(["TA", "TB"]);
    expect((await adminsOf(t, root)).find((a) => a.username === "adm_one")!.team_count).toBe(2);
  });

  it("deletes one team; the other team, the admin and their cookies are unaffected; the team's cookie dies", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    const admin = await staffCookie(t, "adm_one", "admin-one-pw-1");
    const a = await teamCookie(t, "team_a", "team-a-pw-123", "A1");
    const b = await teamCookie(t, "team_b", "team-b-pw-123", "B1");
    const [ta, tb] = await teamsOf(t, root);

    const res = await t.deleteTeams(post("/api/super/teams/delete", { teamIds: [ta!.id] }, root));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data).toEqual({ deleted: { teams: 1 }, team_ids: [ta!.id] });
    expect(JSON.stringify(body)).not.toMatch(/password|hash|token|session/i);
    expect(res.headers.get("idempotent-replay")).toBeNull();

    expect((await teamsOf(t, root)).map((x) => x.id)).toEqual([tb!.id]);
    expect(await canCall(t, a)).toBe(401); // the deleted team's old cookie
    expect(await canCall(t, b)).toBe(403); // alive: authenticated, just not staff
    expect(await canCall(t, admin)).toBe(200);
    // the credentials are gone too
    const login = await t.participantLogin(
      post(
        "/api/auth/participant/login",
        { teamLoginId: "team_a", password: "team-a-pw-123", admissionNo: "A1" },
        undefined,
        null,
      ),
    );
    expect(login.status).toBe(401);
  });

  it("deletes several teams in one request; deleting an admin deletes its teams, its sessions, and its credentials", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    const one = await staffCookie(t, "adm_one", "admin-one-pw-1");
    const two = await staffCookie(t, "adm_two", "admin-two-pw-1");
    const a = await teamCookie(t, "team_a", "team-a-pw-123", "A2");
    const [a1, a2] = await adminsOf(t, root);

    const bulk = await json(
      await t.deleteAdmins(post("/api/super/admins/delete", { adminIds: [a1!.id, a2!.id] }, root)),
    );
    expect(bulk.data).toEqual({
      deleted: { admins: 2, teams: 2 },
      admin_ids: [a1!.id, a2!.id].sort(),
    });
    expect(await adminsOf(t, root)).toEqual([]);
    expect(await teamsOf(t, root)).toEqual([]);
    for (const dead of [one, two, a]) expect(await canCall(t, dead)).toBe(401);
    expect(await canCall(t, root)).toBe(200);
    const relog = await t.staffLogin(
      post(
        "/api/auth/staff/login",
        { username: "adm_one", password: "admin-one-pw-1" },
        undefined,
        null,
      ),
    );
    expect(relog.status).toBe(401);
  });

  it("a deleted username and a deleted team login ID can be used again; live ones are still taken", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    const [a1] = await adminsOf(t, root);
    const adminBody = {
      username: "adm_one",
      password: "brand-new-pw-1",
      confirmPassword: "brand-new-pw-1",
    };
    // taken while live
    expect((await t.createAdmin(post("/api/super/admins", adminBody, root))).status).toBe(409);
    expect(
      (await t.deleteAdmins(post("/api/super/admins/delete", { adminIds: [a1!.id] }, root))).status,
    ).toBe(200);
    // free after deletion, through the normal creation flow; the new account is a different identity
    const made = await t.createAdmin(post("/api/super/admins", adminBody, root));
    expect(made.status).toBe(200);
    const newId = ((await json(made)).data as { admin: { id: string } }).admin.id;
    expect(newId).not.toBe(a1!.id);
    expect((await t.createAdmin(post("/api/super/admins", adminBody, root))).status).toBe(409); // active uniqueness holds

    // team login ID, team code and admission numbers
    const fresh = await staffCookie(t, "adm_one", "brand-new-pw-1");
    const teamBody = {
      teamCode: "TA",
      name: "Reborn",
      loginId: "team_a",
      password: "reborn-pass-1",
      confirmPassword: "reborn-pass-1",
      admissionNos: ["A1", "A2", "A3", "A4"],
    };
    // deleting adm_one deleted its teams, so their code, login ID and admission numbers are free again ...
    const reborn = await t.createTeam(post("/api/admin/teams", teamBody, fresh));
    expect(reborn.status).toBe(200);
    // ... and are taken again as soon as they are live (active uniqueness holds)
    expect((await t.createTeam(post("/api/admin/teams", teamBody, fresh))).status).toBe(409);
  });
});

describe("idempotency and retries", () => {
  it("a retry with the same key replays the answer (and says so); the same key for another selection is refused", async () => {
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    const [ta, tb] = await teamsOf(t, root);
    const key = newKey();
    const first = await t.deleteTeams(
      post("/api/super/teams/delete", { teamIds: [ta!.id] }, root, key),
    );
    expect(first.status).toBe(200);
    const replay = await t.deleteTeams(
      post("/api/super/teams/delete", { teamIds: [ta!.id] }, root, key),
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(await json(replay)).toMatchObject({ ok: true, data: { deleted: { teams: 1 } } });
    const reused = await t.deleteTeams(
      post("/api/super/teams/delete", { teamIds: [tb!.id] }, root, key),
    );
    expect(reused.status).toBe(409);
    expect((await json(reused)).error!.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await teamsOf(t, root)).map((x) => x.id)).toEqual([tb!.id]); // team B was not touched by the reused key
    // a NEW key for an already deleted team is an honest 404, never a fake success
    const again = await t.deleteTeams(post("/api/super/teams/delete", { teamIds: [ta!.id] }, root));
    expect(again.status).toBe(404);
  });
});

describe("failures never look like success and never leak", () => {
  it("maps DELETE_BLOCKED to a 409, an unknown database error to a generic 503, and a malformed result to a 503", async () => {
    const blocked = setup((db) => ({
      async rpc(fn, args) {
        if (fn === "delete_teams") throw new DbError(fn, "P0001", { appCode: "DELETE_BLOCKED" });
        return db.rpc(fn, args);
      },
    }));
    const root = await staffCookie(blocked, "root", "root-password-1");
    const [ta] = await teamsOf(blocked, root);
    const r1 = await blocked.deleteTeams(
      post("/api/super/teams/delete", { teamIds: [ta!.id] }, root),
    );
    expect(r1.status).toBe(409);
    expect((await json(r1)).error!.code).toBe("DELETE_BLOCKED");

    const boom = setup((db) => ({
      async rpc(fn, args) {
        if (fn === "delete_admins") throw new DbError(fn, "23503"); // a raw foreign key violation
        return db.rpc(fn, args);
      },
    }));
    const root2 = await staffCookie(boom, "root", "root-password-1");
    const [a1] = await adminsOf(boom, root2);
    const r2 = await boom.deleteAdmins(
      post("/api/super/admins/delete", { adminIds: [a1!.id] }, root2),
    );
    expect(r2.status).toBe(503);
    expect(JSON.stringify(await json(r2))).not.toMatch(/23503|foreign|constraint|violat/i);

    const garbled = setup((db) => ({
      async rpc(fn, args) {
        if (fn === "list_deletable_teams")
          return { teams: [{ id: "x", password_hash: "$2a$12$leak" }] };
        return db.rpc(fn, args);
      },
    }));
    const root3 = await staffCookie(garbled, "root", "root-password-1");
    const r3 = await garbled.listTeams(get("/api/super/teams", root3));
    expect(r3.status).toBe(503);
    expect(JSON.stringify(await json(r3))).not.toMatch(/leak|hash/);
  });

  it("a result is whitelisted: extra fields from the database never reach the browser", async () => {
    const t = setup((db) => ({
      async rpc(fn, args) {
        const out = await db.rpc(fn, args);
        if (fn === "list_deletable_admins") {
          const o = out as { admins: Record<string, unknown>[] };
          return {
            admins: o.admins.map((a) => ({ ...a, password_hash: "$2a$12$leak", token: "t" })),
          };
        }
        return out;
      },
    }));
    const root = await staffCookie(t, "root", "root-password-1");
    const res = await t.listAdmins(get("/api/super/admins", root));
    expect(res.status).toBe(200);
    expect(JSON.stringify(await json(res))).not.toMatch(/leak|password_hash|token/);
  });
});

describe("DELETE_BLOCKED: the browser gets a fixed 409, the server log gets the constraint name and nothing else", () => {
  const BLOCKED_MESSAGE = "deletion: blocked by a foreign key";
  afterEach(() => vi.restoreAllMocks());

  /** A backend whose `fn` always fails like migration 20 does: P0001, DELETE_BLOCKED, with the diagnostics in the details. */
  const blockedBy = (fn: DbFunction, details: Record<string, unknown>) =>
    setup((db) => ({
      async rpc(f, args) {
        if (f === fn) throw new DbError(f, "P0001", { appCode: "DELETE_BLOCKED", details });
        return db.rpc(f, args);
      },
    }));
  const spy = () => vi.spyOn(console, "error").mockImplementation(() => undefined);
  const blockedCalls = (s: ReturnType<typeof spy>) =>
    s.mock.calls.filter((c) => c[0] === BLOCKED_MESSAGE);

  it("delete_teams: 409 DELETE_BLOCKED with no details; one log line with fn, constraint and table only", async () => {
    const log = spy();
    const t = blockedBy("delete_teams", {
      constraint: "coin_transactions_submission_id_fkey",
      table: "coin_transactions",
      // anything else a database might put there must never be logged or sent
      id: "11111111-2222-4333-8444-555555555555",
      password_hash: "$2a$12$leak",
      token: "tok-secret",
    });
    const root = await staffCookie(t, "root", "root-password-1");
    const [ta] = await teamsOf(t, root);
    const key = newKey();
    const res = await t.deleteTeams(
      post("/api/super/teams/delete", { teamIds: [ta!.id] }, root, key),
    );
    expect(res.status).toBe(409);
    const text = JSON.stringify(await json(res));
    const body = JSON.parse(text) as Envelope;
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("DELETE_BLOCKED");
    expect(body.error!.details).toBeUndefined();
    expect(text).not.toMatch(
      /coin_transactions|_fkey|constraint|11111111|leak|password_hash|tok-secret|foreign|violat/i,
    );

    expect(blockedCalls(log)).toHaveLength(1);
    expect(blockedCalls(log)[0]).toEqual([
      BLOCKED_MESSAGE,
      {
        fn: "delete_teams",
        constraint: "coin_transactions_submission_id_fkey",
        table: "coin_transactions",
      },
    ]);
    // nothing else the request carried reaches any log
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(ta!.id);
    expect(logged).not.toContain(key);
    expect(logged).not.toContain(root);
    expect(logged).not.toMatch(/leak|password_hash|tok-secret|11111111/);
    // and the failed call deleted nothing
    expect(t.backend.controls.counts()).toMatchObject({ staff: 3, teams: 2 });
  });

  it("delete_admins: the same, for the admin endpoint", async () => {
    const log = spy();
    const t = blockedBy("delete_admins", {
      constraint: "submissions_reviewed_by_fkey",
      table: "submissions",
    });
    const root = await staffCookie(t, "root", "root-password-1");
    const [a1] = await adminsOf(t, root);
    const res = await t.deleteAdmins(
      post("/api/super/admins/delete", { adminIds: [a1!.id] }, root),
    );
    expect(res.status).toBe(409);
    const text = JSON.stringify(await json(res));
    expect(JSON.parse(text).error.code).toBe("DELETE_BLOCKED");
    expect(JSON.parse(text).error.details).toBeUndefined();
    expect(text).not.toMatch(/submissions|reviewed_by|_fkey/i);
    expect(blockedCalls(log)).toEqual([
      [
        BLOCKED_MESSAGE,
        { fn: "delete_admins", constraint: "submissions_reviewed_by_fkey", table: "submissions" },
      ],
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(a1!.id);
    expect(t.backend.controls.counts()).toMatchObject({ staff: 3, teams: 2 });
  });

  it("a hostile or missing constraint is never logged: only identifier-shaped values pass", async () => {
    const log = spy();
    const cases: [Record<string, unknown> | undefined, unknown][] = [
      [undefined, { constraint: undefined, table: undefined }],
      [{}, { constraint: undefined, table: undefined }],
      [
        { constraint: "x'; drop table staff_users;--", table: "Teams And Spaces" },
        { constraint: undefined, table: undefined },
      ],
      [
        { constraint: "a".repeat(200), table: 42 },
        { constraint: undefined, table: undefined },
      ],
      [
        { constraint: { password: "pw" }, table: ["tok"] },
        { constraint: undefined, table: undefined },
      ],
      [
        { constraint: "teams_ufm_penalized_by_fkey", table: "evil\nforged log line" },
        { constraint: "teams_ufm_penalized_by_fkey", table: undefined },
      ],
    ];
    for (const [details, expected] of cases) {
      log.mockClear();
      const t = blockedBy("delete_teams", details as Record<string, unknown>);
      const root = await staffCookie(t, "root", "root-password-1");
      const [ta] = await teamsOf(t, root);
      const res = await t.deleteTeams(post("/api/super/teams/delete", { teamIds: [ta!.id] }, root));
      expect(res.status).toBe(409);
      expect(blockedCalls(log)).toEqual([
        [BLOCKED_MESSAGE, { fn: "delete_teams", ...(expected as object) }],
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/drop table|password|tok|forged|aaaa/);
    }
  });

  it("other failures and successes do not write the blocked line; a raw 23503 stays a generic 503", async () => {
    const log = spy();
    const boom = setup((db) => ({
      async rpc(fn, args) {
        if (fn === "delete_admins") throw new DbError(fn, "23503", {});
        return db.rpc(fn, args);
      },
    }));
    const root = await staffCookie(boom, "root", "root-password-1");
    const [a1] = await adminsOf(boom, root);
    const r = await boom.deleteAdmins(
      post("/api/super/admins/delete", { adminIds: [a1!.id] }, root),
    );
    expect(r.status).toBe(503);
    expect(blockedCalls(log)).toHaveLength(0);

    // a normal, successful deletion and an unknown id (404) do not log it either
    const ok = setup();
    const root2 = await staffCookie(ok, "root", "root-password-1");
    const [ta] = await teamsOf(ok, root2);
    const del = await ok.deleteTeams(post("/api/super/teams/delete", { teamIds: [ta!.id] }, root2));
    expect(del.status).toBe(200);
    const missing = await ok.deleteTeams(
      post("/api/super/teams/delete", { teamIds: ["99999999-9999-4999-8999-999999999999"] }, root2),
    );
    expect(missing.status).toBe(404);
    expect(blockedCalls(log)).toHaveLength(0);
  });

  it("through the stand-in: a blocker refuses the selection whole and atomically, passes when both sides are selected together, and a refused key is not recorded", async () => {
    const log = spy();
    const t = setup();
    const root = await staffCookie(t, "root", "root-password-1");
    const [a1, a2] = await adminsOf(t, root);
    t.backend.controls.blockDeletion({
      kind: "admin",
      target: a1!.username,
      partner: a2!.username,
      constraint: "staff_users_created_by_fkey",
      table: "staff_users",
    });
    const before = t.backend.controls.counts();
    const key = newKey();
    const alone = await t.deleteAdmins(
      post("/api/super/admins/delete", { adminIds: [a1!.id] }, root, key),
    );
    expect(alone.status).toBe(409);
    expect(t.backend.controls.counts()).toEqual(before); // nothing changed, not even an audit or idempotency row
    expect(blockedCalls(log)).toEqual([
      [
        BLOCKED_MESSAGE,
        { fn: "delete_admins", constraint: "staff_users_created_by_fkey", table: "staff_users" },
      ],
    ]);
    // the other side alone is fine (it holds the reference); then the referenced one no longer has a blocker
    const holderOnly = await t.deleteAdmins(
      post("/api/super/admins/delete", { adminIds: [a2!.id] }, root),
    );
    expect(holderOnly.status).toBe(200);
    // the refused key was never stored, so it executes now instead of replaying the failure
    const retry = await t.deleteAdmins(
      post("/api/super/admins/delete", { adminIds: [a1!.id] }, root, key),
    );
    expect(retry.status).toBe(200);
    expect(retry.headers.get("Idempotent-Replay")).toBeNull();

    // both sides in ONE request pass the blocker
    const u = setup();
    const root2 = await staffCookie(u, "root", "root-password-1");
    const [b1, b2] = await adminsOf(u, root2);
    u.backend.controls.blockDeletion({
      kind: "admin",
      target: b1!.username,
      partner: b2!.username,
      constraint: "staff_users_created_by_fkey",
      table: "staff_users",
    });
    const both = await u.deleteAdmins(
      post("/api/super/admins/delete", { adminIds: [b1!.id, b2!.id] }, root2),
    );
    expect(both.status).toBe(200);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read and deliberately malform JSON documents whose shape the assertions check */
import { describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import {
  createParticipantLoginHandler,
  createStaffLoginHandler,
  type AuthDeps,
} from "@/lib/auth/handlers";
import { OFFICIAL_RULES } from "@/lib/content/official-public";
import { DbError, type Db, type DbFunction } from "@/lib/db/adapter";
import { createCreateAdminHandler } from "@/lib/provisioning/handlers";
import { createGetRenewalHandler, createRenewHandler } from "@/lib/renewal/handlers";

import { createFakeBackend } from "../e2e/support/fake-postgrest.mjs";

/**
 * "Renew the Competition" (migration 21): the API layer wired to the in-memory backend of the browser tests. Who may read and
 * renew, that the staff id always comes from the session, the strict fixed-structure body, the stale-content check, the
 * preconditions, deletion scope and atomicity, idempotency and safe errors. The SQL itself is proven on a real PostgreSQL by
 * supabase/tests/200_renew_competition.test.sql (+ concurrency and upgrade scripts); this file proves the API layer and the
 * stand-in against the same expectations.
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

function setup() {
  const backend = createFakeBackend(identities);
  const db: Db = {
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
    read: createGetRenewalHandler(deps),
    renew: createRenewHandler(deps),
  };
}
type T = ReturnType<typeof setup>;

let keyCounter = 0;
const newKey = () => `00000000-0000-4000-8000-${String(++keyCounter).padStart(12, "0")}`;
const post = (
  path: string,
  body: unknown,
  cookie?: string,
  key: string | null = newKey(),
  origin = ORIGIN,
) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(cookie ? { cookie } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const get = (cookie?: string) =>
  new Request(`${ORIGIN}/api/super/renew`, { headers: cookie ? { cookie } : {} });

type Envelope = {
  ok: boolean;
  data?: Record<string, any>;
  error?: { code: string; details?: Record<string, any> };
};
const json = async (res: Response): Promise<Envelope> => (await res.json()) as Envelope;

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
const rootCookie = (t: T) => staffCookie(t, "root", "root-password-1");

async function load(t: T, cookie: string) {
  const res = await t.read(get(cookie));
  expect(res.status).toBe(200);
  const d = (await json(res)).data as {
    content: any;
    token: string;
    readiness: Record<string, any>;
  };
  return d;
}
const clone = <X>(x: X): X => JSON.parse(JSON.stringify(x)) as X;
const renew = (t: T, cookie: string, content: unknown, expectedToken: string, key?: string) =>
  t.renew(post("/api/super/renew", { content, expectedToken }, cookie, key));
const state = (t: T) =>
  t.backend.controls.renewalState() as { competition: any; rules: any; token: string };
const counts = (t: T) => t.backend.controls.counts() as Record<string, number>;

/** A running team with a question ACTIVE / submitted, driven through the stand-in's gameplay functions. */
function play(t: T, loginId: string, to: "running" | "active" | "pending") {
  const { teamId, memberId } = t.backend.controls.teamIds({ loginId }) as {
    teamId: string;
    memberId: string;
  };
  const base = { p_team_id: teamId, p_member_id: memberId };
  t.backend.rpc("start_team_competition", { ...base, p_idem_key: newKey() });
  if (to === "running") return;
  t.backend.rpc("unlock_theme", { ...base, p_theme_id: 1, p_idem_key: newKey() });
  t.backend.rpc("start_question", { ...base, p_question_id: 1, p_idem_key: newKey() });
  if (to === "active") return;
  t.backend.rpc("submit_answer", {
    ...base,
    p_question_id: 1,
    p_answer: "x",
    p_explanation: "y",
    p_idem_key: newKey(),
  });
}

const EDITED_NAME = "Renewed ☆ θέμα — “Quoted”, (punct.)!";
const EDITED_MULTILINE = "Line one\n\n  indented line two\r\nLine three: ½ ≤ π — ünïcödé 日本語 😀";

describe("authorisation: only an active, signed-in SUPER_ADMIN reads and renews", () => {
  it("rejects anonymous, forged, Admin and participant calls to both methods, changing nothing", async () => {
    const t = setup();
    const root = await rootCookie(t);
    const { content, token } = await load(t, root);
    const admin = await staffCookie(t, "adm_one", "admin-one-pw-1");
    const pRes = await t.participantLogin(
      post(
        "/api/auth/participant/login",
        { teamLoginId: "team_a", password: "team-a-pw-123", admissionNo: "A1" },
        undefined,
        null,
      ),
    );
    const participant = await cookieFrom(pRes);
    const before = { ...counts(t), token: state(t).token };

    for (const [cookie, status] of [
      [undefined, 401],
      [`${SESSION_COOKIE_NAME}=forged`, 401],
      [admin, 403],
      [participant, 403],
    ] as const) {
      expect((await t.read(get(cookie))).status, `GET ${String(cookie)}`).toBe(status);
      expect((await renew(t, cookie ?? "", content, token)).status, `POST ${String(cookie)}`).toBe(
        status,
      );
    }
    expect({ ...counts(t), token: state(t).token }).toEqual(before);
    expect(state(t).competition.status).toBe("RUNNING");
  });

  it("refuses a cross-origin POST and a missing or malformed Idempotency-Key", async () => {
    const t = setup();
    const root = await rootCookie(t);
    const { content, token } = await load(t, root);
    const body = { content, expectedToken: token };
    expect(
      (await t.renew(post("/api/super/renew", body, root, newKey(), "https://evil.example")))
        .status,
    ).toBe(403);
    expect((await t.renew(post("/api/super/renew", body, root, null))).status).toBe(400);
    expect((await t.renew(post("/api/super/renew", body, root, "not-a-uuid"))).status).toBe(400);
    expect(counts(t)).toMatchObject({ staff: 3, teams: 2 });
  });

  it("takes the staff id from the session only: the body is strict and carries no identity", async () => {
    const t = setup();
    const root = await rootCookie(t);
    const { content, token } = await load(t, root);
    const rootId = t.backend.controls.staffId({ username: "root" });
    for (const extra of [
      { staffId: rootId },
      { role: "SUPER_ADMIN" },
      { adminIds: [] },
      { force: true },
    ]) {
      const res = await t.renew(
        post("/api/super/renew", { content, expectedToken: token, ...extra }, root),
      );
      expect(res.status).toBe(400);
    }
    // an Admin session with a body that claims to be the Super Admin is refused by role, before the body matters
    const admin = await staffCookie(t, "adm_one", "admin-one-pw-1");
    const forged = await t.renew(
      post("/api/super/renew", { content, expectedToken: token, staffId: rootId }, admin),
    );
    expect(forged.status).toBe(403);
    expect(counts(t)).toMatchObject({ staff: 3, teams: 2 });
  });

  it("stops working when the Super Admin account is disabled", async () => {
    const t = setup();
    const root = await rootCookie(t);
    const { content, token } = await load(t, root);
    t.backend.controls.staffActive({ username: "root", active: false });
    const r = await renew(t, root, content, token);
    expect([401, 403]).toContain(r.status);
    expect([401, 403]).toContain((await t.read(get(root))).status);
    expect(counts(t)).toMatchObject({ staff: 3, teams: 2 });
  });
});

describe("GET /api/super/renew: the current content, its token and readiness", () => {
  it("returns exactly 10 themes (A–J) × 5 questions with two hints each, the rules in force and no secrets", async () => {
    const t = setup();
    const root = await rootCookie(t);
    const res = await t.read(get(root));
    expect(res.headers.get("cache-control")).toContain("no-store");
    const d = (await json(res)).data!;
    expect(d.token).toMatch(/^[0-9a-f]{64}$/);
    expect(d.content.themes.map((x: any) => x.id)).toEqual([..."ABCDEFGHIJ"]);
    for (const th of d.content.themes) {
      expect(th.questions.map((q: any) => q.id)).toEqual(
        [1, 2, 3, 4, 5].map((n) => `${th.id}.${n}`),
      );
      expect(th.name.length).toBeGreaterThan(0);
      for (const q of th.questions) {
        expect(Object.keys(q).sort()).toEqual(["hint1", "hint2", "id", "question", "reward"]);
        expect(q.reward).toBeGreaterThan(0);
      }
    }
    // never renewed: the built-in official rules are in force
    expect(d.content.rules).toEqual([...OFFICIAL_RULES]);
    expect(d.readiness).toMatchObject({
      ready: true,
      admins: 2,
      teams: 2,
      competition_status: "RUNNING",
    });
    expect(JSON.stringify(d)).not.toMatch(/referenceAnswer|E2E-SECRET|token_hash|p_staff_id/i);
  });
});

describe("the content is validated: fixed structure, complete, bounded", () => {
  const bad: [string, (c: any) => void][] = [
    ["9 themes", (c) => c.themes.pop()],
    ["11 themes", (c) => c.themes.push(clone(c.themes[0]))],
    ["4 questions in a theme", (c) => c.themes[2].questions.pop()],
    ["6 questions in a theme", (c) => c.themes[2].questions.push(clone(c.themes[2].questions[0]))],
    ["a third hint", (c) => (c.themes[0].questions[0].hint3 = "extra")],
    ["a missing hint", (c) => delete c.themes[0].questions[0].hint2],
    ["a changed theme id", (c) => (c.themes[1].id = "Z")],
    ["a duplicate theme id", (c) => (c.themes[1].id = "A")],
    ["a changed question id", (c) => (c.themes[1].questions[0].id = "B.9")],
    ["a duplicate question id", (c) => (c.themes[1].questions[1].id = "B.1")],
    ["an unexpected setting on a question", (c) => (c.themes[0].questions[0].timeLimit = 1)],
    ["an unexpected setting on a theme", (c) => (c.themes[0].unlockCost = 0)],
    ["an unexpected top-level setting", (c) => (c.startingCoins = 1)],
    ["an empty theme name", (c) => (c.themes[0].name = "")],
    ["a whitespace-only description", (c) => (c.themes[3].description = " \n\t ")],
    ["an empty question", (c) => (c.themes[4].questions[2].question = "")],
    ["an empty hint 1", (c) => (c.themes[4].questions[2].hint1 = "  ")],
    ["an empty hint 2", (c) => (c.themes[9].questions[4].hint2 = "")],
    ["a zero reward", (c) => (c.themes[0].questions[0].reward = 0)],
    ["a negative reward", (c) => (c.themes[0].questions[0].reward = -5)],
    ["a fractional reward", (c) => (c.themes[0].questions[0].reward = 2.5)],
    ["a string reward", (c) => (c.themes[0].questions[0].reward = "50")],
    ["a reward over the limit", (c) => (c.themes[0].questions[0].reward = 1_000_000)],
    ["no rules", (c) => (c.rules = [])],
    ["51 rules", (c) => (c.rules = Array.from({ length: 51 }, (_, i) => `rule ${i}`))],
    ["a blank rule", (c) => (c.rules[0] = "   ")],
    ["a NUL-like control character", (c) => (c.themes[0].name = "bad\u0001name")],
    ["an over-long theme name", (c) => (c.themes[0].name = "x".repeat(201))],
    ["an over-long question", (c) => (c.themes[0].questions[0].question = "x".repeat(8001))],
  ];

  it.each(bad)("rejects %s with 400, changing nothing", async (_name, mutate) => {
    const t = setup();
    const root = await rootCookie(t);
    const { content, token } = await load(t, root);
    const c = clone(content);
    mutate(c);
    const before = { ...counts(t), token: state(t).token };
    const res = await renew(t, root, c, token);
    expect(res.status).toBe(400);
    expect((await json(res)).error?.code).toBe("VALIDATION_FAILED");
    expect({ ...counts(t), token: state(t).token }).toEqual(before);
    expect(state(t).competition.status).toBe("RUNNING");
  });

  it("the database function rejects the same content on its own (defence in depth), naming the fields", async () => {
    const t = setup();
    const root = await rootCookie(t);
    const { content, token } = await load(t, root);
    const rootId = t.backend.controls.staffId({ username: "root" });
    const c = clone(content);
    c.themes[0].name = "";
    c.themes[2].questions[1].reward = 0;
    c.rules = [];
    let caught: any;
    try {
      t.backend.rpc("renew_competition", {
        p_staff_id: rootId,
        p_content: c,
        p_expected_token: token,
        p_idem_key: newKey(),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught?.message).toBe("VALIDATION_FAILED");
    expect(caught.details.fields).toEqual(["themes.A.name", "questions.C.2.reward", "rules"]);
    expect(counts(t)).toMatchObject({ staff: 3, teams: 2 });
  });
});

describe("a valid renewal", () => {
  it("applies every kind of edit, keeps multiline text, Unicode and punctuation, deletes the admins and teams, resets the lifecycle", async () => {
    const t = setup();
    const root = await rootCookie(t);
    const admin = await staffCookie(t, "adm_one", "admin-one-pw-1");
    const { content, token } = await load(t, root);
    const c = clone(content);
    c.themes[0].name = EDITED_NAME;
    c.themes[0].description = EDITED_MULTILINE;
    c.themes[4].questions[3].question = EDITED_MULTILINE;
    c.themes[4].questions[3].hint1 = `${EDITED_NAME}\n${EDITED_MULTILINE}`;
    c.themes[4].questions[3].hint2 = "  leading and trailing spaces are kept  ";
    c.themes[9].questions[4].reward = 777;
    c.rules = ["First new rule.\nSecond line.", EDITED_NAME, "  third  "];

    const res = await renew(t, root, c, token);
    expect(res.status).toBe(200);
    const out = (await json(res)).data!;
    expect(out).toMatchObject({
      deleted: { admins: 2, teams: 2 },
      discarded: { pending_submissions: 0 },
      changed: { themes: 1, questions: 2, hints: 2 },
      competition: { from: "RUNNING", to: "SETUP" },
    });
    expect(out.replayed).toBeUndefined();
    expect(out.token).toMatch(/^[0-9a-f]{64}$/);
    expect(out.token).not.toBe(token);

    // the content is exactly what was sent, character for character
    const after = await load(t, root);
    expect(after.token).toBe(out.token);
    expect(after.content).toEqual(c);
    expect(after.content.rules[2]).toBe("  third  ");
    // participants read the new rules from the database
    expect(t.backend.rpc("get_competition_rules", {})).toEqual({ rules: c.rules });

    // the previous admins and their teams are gone; the Super Admin remains and can act
    expect(counts(t)).toMatchObject({ staff: 1, teams: 0, members: 0 });
    expect((await t.read(get(admin))).status).toBe(401);
    expect((await t.read(get(root))).status).toBe(200);
    expect(state(t).competition.status).toBe("SETUP");
    expect(after.readiness).toMatchObject({
      ready: true,
      admins: 0,
      teams: 0,
      competition_status: "SETUP",
    });

    // new admins can be provisioned afterwards (the usernames are free again)
    const made = await t.createAdmin(
      post(
        "/api/super/admins",
        { username: "adm_one", password: "brand-new-pw-1", confirmPassword: "brand-new-pw-1" },
        root,
      ),
    );
    expect(made.status).toBe(200);
  });

  it("a request without any change still renews: it deletes and resets, and reports nothing changed", async () => {
    const t = setup();
    const root = await rootCookie(t);
    const { content, token } = await load(t, root);
    const res = await renew(t, root, content, token);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({
      deleted: { admins: 2, teams: 2 },
      changed: { themes: 0, questions: 0, hints: 0 },
    });
    // the rules were never customised, but a renewal writes the rules it was given (the official ones here)
    expect(state(t).rules).toEqual([...OFFICIAL_RULES]);
  });

  it("is idempotent: the same key and body replays the answer; another body with that key is refused", async () => {
    const t = setup();
    const root = await rootCookie(t);
    const { content, token } = await load(t, root);
    const key = newKey();
    const first = await renew(t, root, content, token, key);
    expect(first.status).toBe(200);
    const again = await renew(t, root, content, token, key);
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replay")).toBe("true");
    expect((await json(again)).data).toEqual((await json(first)).data);
    const other = clone(content);
    other.rules = ["different"];
    const reused = await renew(t, root, other, token, key);
    expect(reused.status).toBe(409);
    expect((await json(reused)).error?.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(state(t).rules).toEqual(content.rules);
  });

  it("refuses edits built on content that has since changed (a second renewal on the old token, or a concurrent edit)", async () => {
    const t = setup();
    const root = await rootCookie(t);
    const { content, token } = await load(t, root);
    const mine = clone(content);
    mine.themes[0].name = "My edit";
    // somebody else changes the content after this editor loaded it
    t.backend.controls.editThemeName({ code: "B", name: "Their edit" });
    const stale = await renew(t, root, mine, token);
    expect(stale.status).toBe(409);
    expect((await json(stale)).error?.code).toBe("CONTENT_CHANGED");
    expect(counts(t)).toMatchObject({ staff: 3, teams: 2 }); // nothing deleted
    expect((await load(t, root)).content.themes[0].name).toBe(content.themes[0].name);
    expect((await load(t, root)).content.themes[1].name).toBe("Their edit");
  });
});

describe("preconditions are read from the authoritative state, before anything is deleted", () => {
  async function blocked(t: T, cookie: string) {
    const { content, token } = await load(t, cookie);
    const c = clone(content);
    c.themes[0].name = "Should not be applied";
    const res = await renew(t, cookie, c, token, "11111111-1111-4111-8111-111111111111");
    return { res, c, token };
  }

  it("is blocked while a team is actively solving a question, and says which team", async () => {
    const t = setup();
    const root = await rootCookie(t);
    play(t, "team_a", "active");
    const before = { ...counts(t), token: state(t).token };
    const { res } = await blocked(t, root);
    expect(res.status).toBe(409);
    const e = (await json(res)).error!;
    expect(e.code).toBe("RENEWAL_BLOCKED");
    expect(e.details).toMatchObject({
      blocked_count: 1,
      teams: 2,
      blockers: [{ team_code: "TA", name: "Team A", reason: "ACTIVE_QUESTION" }],
    });
    expect({ ...counts(t), token: state(t).token }).toEqual(before);
    expect(state(t).competition.status).toBe("RUNNING");
    // the GET tells the editor the same
    expect((await load(t, root)).readiness).toMatchObject({ ready: false, blocked_count: 1 });
  });

  it("is blocked while a started team's timer runs without a submission", async () => {
    const t = setup();
    const root = await rootCookie(t);
    play(t, "team_b", "running");
    const { res } = await blocked(t, root);
    expect(res.status).toBe(409);
    expect((await json(res)).error?.details?.blockers).toEqual([
      { team_code: "TB", name: "Team B", reason: "TEAM_TIMER_RUNNING" },
    ]);
  });

  it("is allowed when every team has not started, has submitted for approval, or has run out of time", async () => {
    const t = setup();
    const root = await rootCookie(t);
    play(t, "team_a", "pending"); // submitted, awaiting approval
    play(t, "team_b", "active");
    expect((await blocked(t, root)).res.status).toBe(409); // B is still solving
    t.backend.controls.ageAllTeams({ ms: 14_400_000 + 1000 }); // B's overall timer has run out
    const { content, token } = await load(t, root);
    expect((await load(t, root)).readiness).toMatchObject({ ready: true, pending_submissions: 1 });
    const res = await renew(t, root, content, token);
    expect(res.status).toBe(200);
    // the approved policy: the pending submission goes with its team, and the answer says how many were discarded
    expect((await json(res)).data).toMatchObject({ discarded: { pending_submissions: 1 } });
    expect(counts(t)).toMatchObject({ teams: 0 });
  });

  it("a blocked request does not consume its Idempotency-Key: the same request succeeds once the teams are done", async () => {
    const t = setup();
    const root = await rootCookie(t);
    play(t, "team_a", "active");
    const { content, token } = await load(t, root);
    const key = newKey();
    expect((await renew(t, root, content, token, key)).status).toBe(409);
    t.backend.controls.ageAllTeams({ ms: 14_400_000 + 1000 });
    const ok = await renew(t, root, content, token, key);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("idempotent-replay")).toBeNull();
  });

  it("rolls back completely when the deletion pathway refuses (nothing deleted, nothing published, no lifecycle change)", async () => {
    const t = setup();
    const root = await rootCookie(t);
    t.backend.controls.blockDeletion({
      kind: "admin",
      target: "adm_two",
      constraint: "some_fk",
      table: "some_table",
    });
    const { content, token } = await load(t, root);
    const c = clone(content);
    c.themes[0].name = "Should not be applied";
    c.rules = ["nor this"];
    const before = { ...counts(t), token: state(t).token };
    const res = await renew(t, root, c, token);
    expect(res.status).toBe(409);
    const raw = await res.text();
    expect((JSON.parse(raw) as Envelope).error?.code).toBe("DELETE_BLOCKED");
    expect({ ...counts(t), token: state(t).token }).toEqual(before);
    expect(state(t).competition.status).toBe("RUNNING");
    expect(state(t).rules).toBeNull();
    expect(raw).not.toMatch(/some_fk|some_table/);
  });
});

describe("deletion scope", () => {
  it("never deletes an Admin the Super Admin did not create: it refuses with RENEWAL_INCOMPLETE and changes nothing", async () => {
    const t = setup();
    const root = await rootCookie(t);
    t.backend.controls.unattributeAdmin({ username: "adm_two" });
    const { content, token } = await load(t, root);
    const c = clone(content);
    c.themes[0].name = "Should not be applied";
    const before = { ...counts(t), token: state(t).token };
    const res = await renew(t, root, c, token);
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("RENEWAL_INCOMPLETE");
    expect({ ...counts(t), token: state(t).token }).toEqual(before);
    expect(state(t).competition.status).toBe("RUNNING");
    // the Super Admin survives any renewal
    expect((await t.read(get(root))).status).toBe(200);
  });

  it("deletes exactly the admins the Super Admin created, with their teams, and keeps the Super Admin", async () => {
    const t = setup();
    const root = await rootCookie(t);
    const { content, token } = await load(t, root);
    expect((await renew(t, root, content, token)).status).toBe(200);
    expect(counts(t)).toMatchObject({ staff: 1, teams: 0, members: 0 });
    expect(t.backend.controls.staffId({ username: "root" })).toBeTruthy();
  });
});

describe("errors are safe", () => {
  it("never echoes a stack, a SQL text or the content in an error response", async () => {
    const t = setup();
    const root = await rootCookie(t);
    const { content, token } = await load(t, root);
    const c = clone(content);
    c.themes[0].name = "";
    const res = await renew(t, root, c, token);
    const text = await res.text();
    expect(text).not.toMatch(/at .*\(|stack|select |p_staff_id|renew_competition/i);
    const garbage = await t.renew(post("/api/super/renew", "{not json", root));
    expect(garbage.status).toBe(400);
  });
});

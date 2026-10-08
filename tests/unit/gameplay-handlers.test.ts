import { describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import { generateSessionToken } from "@/lib/auth/session";
import { DbError, type Db, type DbFunction } from "@/lib/db/adapter";
import {
  createApproveSubmissionHandler,
  createDisapproveSubmissionHandler,
  createEnterQuestionHandler,
  createGetQuestionHandler,
  createReviewQueueHandler,
  createSaveDraftHandler,
  createSubmitAnswerHandler,
  createUnlockThemeHandler,
  type GameplayDeps,
} from "@/lib/gameplay/handlers";

const ORIGIN = "https://concetto.example";
const PEPPER = "pepper-for-tests-0123456789abcdef0123";
const NOW = 1_760_000_000_000;
const DB_NOW = 1_760_000_123_456;
const SESSION_ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const TEAM_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OTHER_TEAM_ID = "0e3c1f2a-9b7d-4c55-8a10-5d2f6b1c9e44";
const MEMBER_ID = "9b2c1f4e-5d1a-4c3b-8e7f-0a1b2c3d4e5f";
const STAFF_ID = "1f0d3c2b-4a59-4687-9a7b-6c5d4e3f2a10";
const SUB_ID = "2a8f4c1e-6b3d-4e7a-9c50-1d2e3f4a5b6c";
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

const question = (over: Record<string, unknown> = {}) => ({
  id: 3,
  theme_id: 1,
  theme_code: "A",
  ordinal: 3,
  state: "ACTIVE",
  reward_coins: 50,
  time_limit_seconds: 240,
  body_md: "Find x.",
  deadline: DB_NOW + 100_000,
  remaining_seconds: 100,
  draft: { answer: "", explanation: "", version: 0, updated_by_slot: null, updated_at: null },
  ...over,
});
const teamState = () => ({
  server_now: DB_NOW,
  state_version: 9,
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
    coins: 400,
    started_at: DB_NOW - 1000,
    ends_at: DB_NOW + 7_199_000,
    ended_at: null,
    final_submitted_at: null,
    duration_seconds: 7200,
    remaining_seconds: 7199,
    expired: false,
  },
  themes: [],
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
const deps = (db: Db): GameplayDeps => ({
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
function req(
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string>; key?: boolean } = {},
) {
  const headers: Record<string, string> = { origin: ORIGIN, cookie: COOKIE, ...init.headers };
  if (init.key !== false && method !== "GET") headers["idempotency-key"] = KEY;
  let body: string | undefined;
  if (init.body !== undefined) {
    body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    headers["content-type"] ??= "application/json";
  }
  return new Request(`${ORIGIN}${path}`, { method, headers, body });
}
const ctx = <P extends string>(params: Record<P, string>) => ({ params: Promise.resolve(params) });
const json = async (res: Response) => JSON.parse(await res.text());
const raised = (appCode: string, details?: Record<string, unknown>) =>
  new DbError("start_question", "P0001", { appCode, details });

describe("GET /api/p/questions/:questionId", () => {
  it("returns the caller's own question; ids come from the session, the selector from the path", async () => {
    const { db, ops } = fakeDb(participant, () => ({
      server_now: DB_NOW,
      state_version: 9,
      question: question(),
    }));
    const res = await createGetQuestionHandler(deps(db))(
      req("GET", "/api/p/questions/3"),
      ctx({ questionId: "3" }),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ ok: true, server_now: DB_NOW, state_version: 9 });
    expect(body.data.question).toMatchObject({ id: 3, state: "ACTIVE", body_md: "Find x." });
    expect(ops()).toEqual([
      {
        fn: "get_question_for_team",
        args: { p_team_id: TEAM_ID, p_member_id: MEMBER_ID, p_question_id: 3 },
      },
    ]);
  });
  it("never forwards a reference answer or solution notes even if the database sent them", async () => {
    const leaky = question({ reference_answer: "TOP-SECRET", solution_notes: "TOP-SECRET" });
    const { db } = fakeDb(participant, () => ({
      server_now: DB_NOW,
      state_version: 9,
      question: leaky,
    }));
    const res = await createGetQuestionHandler(deps(db))(
      req("GET", "/api/p/questions/3"),
      ctx({ questionId: "3" }),
    );
    expect(await res.text()).not.toMatch(/TOP-SECRET|reference_answer|solution_notes/);
  });
  it.each(["0", "51", "abc", "1.5", "3; drop"])(
    "rejects the malformed selector %s without touching the database",
    async (id) => {
      const { db, ops } = fakeDb(participant, () => ({}));
      const res = await createGetQuestionHandler(deps(db))(
        req("GET", "/api/p/questions/x"),
        ctx({ questionId: id }),
      );
      expect(res.status).toBe(404);
      expect(ops()).toHaveLength(0);
    },
  );
  it("maps the engine's refusals (locked theme, locked question) to 409 and staff to 403", async () => {
    for (const code of ["THEME_LOCKED", "QUESTION_NOT_ACTIVE"]) {
      const { db } = fakeDb(participant, () => raised(code));
      const res = await createGetQuestionHandler(deps(db))(
        req("GET", "/api/p/questions/3"),
        ctx({ questionId: "3" }),
      );
      expect(res.status).toBe(409);
      expect((await json(res)).error.code).toBe(code);
    }
    const { db, ops } = fakeDb(staff("ADMIN"), () => ({}));
    const res = await createGetQuestionHandler(deps(db))(
      req("GET", "/api/p/questions/3"),
      ctx({ questionId: "3" }),
    );
    expect(res.status).toBe(403);
    expect(ops()).toHaveLength(0);
  });
  it("is 401 without a session", async () => {
    const { db } = fakeDb({ ok: false }, () => ({}));
    const res = await createGetQuestionHandler(deps(db))(
      new Request(`${ORIGIN}/api/p/questions/3`),
      ctx({ questionId: "3" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/p/questions/:questionId/enter", () => {
  const result = (over: Record<string, unknown> = {}) => ({
    replayed: false,
    started_now: true,
    question: question(),
    ...over,
  });
  it("starts (or joins) the question with only session ids and the header key", async () => {
    const { db, ops } = fakeDb(participant, () => result());
    const res = await createEnterQuestionHandler(deps(db))(
      req("POST", "/api/p/questions/3/enter"),
      ctx({ questionId: "3" }),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data.started_now).toBe(true);
    expect(body.data.question.deadline).toBe(DB_NOW + 100_000);
    expect(ops()).toEqual([
      {
        fn: "start_question",
        args: { p_team_id: TEAM_ID, p_member_id: MEMBER_ID, p_question_id: 3, p_idem_key: KEY },
      },
    ]);
  });
  it("marks a replay and never accepts a body, a missing key, a foreign origin or a staff session", async () => {
    const h = createEnterQuestionHandler(
      deps(fakeDb(participant, () => result({ replayed: true, started_now: false })).db),
    );
    const replay = await h(req("POST", "/api/p/questions/3/enter"), ctx({ questionId: "3" }));
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    const { db, ops } = fakeDb(participant, () => result());
    const handler = createEnterQuestionHandler(deps(db));
    expect(
      (
        await handler(
          req("POST", "/api/p/questions/3/enter", { key: false }),
          ctx({ questionId: "3" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handler(
          req("POST", "/api/p/questions/3/enter", { body: { deadline: 1 } }),
          ctx({ questionId: "3" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handler(
          req("POST", "/api/p/questions/3/enter", { headers: { origin: "https://evil.example" } }),
          ctx({ questionId: "3" }),
        )
      ).status,
    ).toBe(403);
    expect(ops()).toHaveLength(0);
    const asStaff = createEnterQuestionHandler(deps(fakeDb(staff("ADMIN"), () => result()).db));
    expect(
      (await asStaff(req("POST", "/api/p/questions/3/enter"), ctx({ questionId: "3" }))).status,
    ).toBe(403);
  });
  it.each([
    ["QUESTION_NOT_AVAILABLE", 409],
    ["THEME_LOCKED", 409],
    ["COMPETITION_PAUSED", 423],
    ["TEAM_NOT_STARTED", 409],
  ])("maps %s to %i", async (code, status) => {
    const { db } = fakeDb(participant, () => raised(code));
    const res = await createEnterQuestionHandler(deps(db))(
      req("POST", "/api/p/questions/3/enter"),
      ctx({ questionId: "3" }),
    );
    expect(res.status).toBe(status);
    expect((await json(res)).error.code).toBe(code);
  });
});

describe("POST /api/p/themes/:themeId/unlock", () => {
  it("unlocks team-wide and returns the fresh snapshot", async () => {
    const { db, ops } = fakeDb(participant, () => ({
      replayed: false,
      theme_id: 2,
      state: teamState(),
    }));
    const res = await createUnlockThemeHandler(deps(db))(
      req("POST", "/api/p/themes/2/unlock"),
      ctx({ themeId: "2" }),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data.theme_id).toBe(2);
    expect(body.data.team.coins).toBe(400);
    expect(body.state_version).toBe(9);
    expect(ops()).toEqual([
      {
        fn: "unlock_theme",
        args: { p_team_id: TEAM_ID, p_member_id: MEMBER_ID, p_theme_id: 2, p_idem_key: KEY },
      },
    ]);
  });
  it("INSUFFICIENT_COINS carries have/need only; THEME_ALREADY_UNLOCKED is a plain 409", async () => {
    const poor = fakeDb(participant, () =>
      raised("INSUFFICIENT_COINS", { have: 20, need: 100, secret: "x" }),
    );
    const res = await createUnlockThemeHandler(deps(poor.db))(
      req("POST", "/api/p/themes/2/unlock"),
      ctx({ themeId: "2" }),
    );
    const body = await json(res);
    expect(res.status).toBe(409);
    expect(body.error).toMatchObject({
      code: "INSUFFICIENT_COINS",
      details: { have: 20, need: 100, secret: "x" },
    });
    const dup = fakeDb(participant, () => raised("THEME_ALREADY_UNLOCKED"));
    const res2 = await createUnlockThemeHandler(deps(dup.db))(
      req("POST", "/api/p/themes/2/unlock"),
      ctx({ themeId: "2" }),
    );
    expect(res2.status).toBe(409);
    expect((await json(res2)).error.code).toBe("THEME_ALREADY_UNLOCKED");
  });
  it("a client cannot name a team, a price or a coin balance", async () => {
    const { db, ops } = fakeDb(participant, () => ({
      replayed: false,
      theme_id: 2,
      state: teamState(),
    }));
    const h = createUnlockThemeHandler(deps(db));
    expect(
      (
        await h(
          req("POST", "/api/p/themes/2/unlock", { body: { teamId: OTHER_TEAM_ID, cost: 0 } }),
          ctx({ themeId: "2" }),
        )
      ).status,
    ).toBe(400);
    expect((await h(req("POST", "/api/p/themes/11/unlock"), ctx({ themeId: "11" }))).status).toBe(
      404,
    );
    expect(ops()).toHaveLength(0);
    await h(
      req("POST", "/api/p/themes/2/unlock", { headers: { "x-team-id": OTHER_TEAM_ID } }),
      ctx({ themeId: "2" }),
    );
    expect(ops()[0]?.args.p_team_id).toBe(TEAM_ID);
  });
});

describe("PUT /api/p/questions/:questionId/draft", () => {
  const ok = { version: 4, updated_by_slot: 2, updated_at: DB_NOW };
  it("saves with compare-and-set and passes the text through untouched", async () => {
    const { db, ops } = fakeDb(participant, () => ok);
    const res = await createSaveDraftHandler(deps(db))(
      req("PUT", "/api/p/questions/3/draft", {
        body: { answer: " x = 4 ", explanation: "why", expectedVersion: 3 },
        key: false,
      }),
      ctx({ questionId: "3" }),
    );
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual(ok);
    expect(ops()).toEqual([
      {
        fn: "save_draft",
        args: {
          p_team_id: TEAM_ID,
          p_member_id: MEMBER_ID,
          p_question_id: 3,
          p_answer: " x = 4 ",
          p_explanation: "why",
          p_expected_version: 3,
        },
      },
    ]);
  });
  it("accepts a body of two long texts but not an oversized one", async () => {
    const { db } = fakeDb(participant, () => ok);
    const h = createSaveDraftHandler(deps(db));
    const big = { answer: "a".repeat(10_000), explanation: "b".repeat(10_000), expectedVersion: 0 };
    expect(
      (await h(req("PUT", "/api/p/questions/3/draft", { body: big }), ctx({ questionId: "3" })))
        .status,
    ).toBe(200);
    const huge = { answer: "a".repeat(30_000), expectedVersion: 0 };
    expect(
      (await h(req("PUT", "/api/p/questions/3/draft", { body: huge }), ctx({ questionId: "3" })))
        .status,
    ).toBe(400);
  });
  it("STALE_DRAFT is a 409 that tells the client the server's version", async () => {
    const { db } = fakeDb(participant, () => raised("STALE_DRAFT", { version: 5 }));
    const res = await createSaveDraftHandler(deps(db))(
      req("PUT", "/api/p/questions/3/draft", { body: { answer: "x", expectedVersion: 3 } }),
      ctx({ questionId: "3" }),
    );
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatchObject({ code: "STALE_DRAFT", details: { version: 5 } });
  });
  it.each([
    [{ answer: "x" }, "missing expectedVersion"],
    [{ answer: "x", expectedVersion: 0, teamId: OTHER_TEAM_ID }, "an unknown field"],
    [{ answer: "x", expectedVersion: 0, state: "APPROVED" }, "a client-supplied state"],
  ])("rejects %j (%s)", async (body, _why) => {
    const { db, ops } = fakeDb(participant, () => ok);
    const res = await createSaveDraftHandler(deps(db))(
      req("PUT", "/api/p/questions/3/draft", { body }),
      ctx({ questionId: "3" }),
    );
    expect(res.status).toBe(400);
    expect(ops()).toHaveLength(0);
  });
  it("maps a timed-out or non-active question to 409", async () => {
    for (const code of ["QUESTION_TIMED_OUT", "QUESTION_NOT_ACTIVE"]) {
      const { db } = fakeDb(participant, () => raised(code));
      const res = await createSaveDraftHandler(deps(db))(
        req("PUT", "/api/p/questions/3/draft", { body: { answer: "x", expectedVersion: 0 } }),
        ctx({ questionId: "3" }),
      );
      expect(res.status).toBe(409);
      expect((await json(res)).error.code).toBe(code);
    }
  });
});

describe("POST /api/p/questions/:questionId/submit", () => {
  const result = (over: Record<string, unknown> = {}) => ({
    replayed: false,
    question: question({ state: "PENDING_APPROVAL", deadline: undefined, remaining_seconds: 120 }),
    ...over,
  });
  it("submits as the session's member and returns the pending question", async () => {
    const { db, ops } = fakeDb(participant, () => result());
    const res = await createSubmitAnswerHandler(deps(db))(
      req("POST", "/api/p/questions/3/submit", { body: { answer: "42", explanation: "because" } }),
      ctx({ questionId: "3" }),
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data.question).toMatchObject({ state: "PENDING_APPROVAL", remaining_seconds: 120 });
    expect(body.data.question).not.toHaveProperty("deadline");
    expect(ops()).toEqual([
      {
        fn: "submit_answer",
        args: {
          p_team_id: TEAM_ID,
          p_member_id: MEMBER_ID,
          p_question_id: 3,
          p_answer: "42",
          p_explanation: "because",
          p_idem_key: KEY,
        },
      },
    ]);
  });
  it("needs the key and a non-blank answer; a replay is flagged", async () => {
    const { db, ops } = fakeDb(participant, () => result());
    const h = createSubmitAnswerHandler(deps(db));
    expect(
      (
        await h(
          req("POST", "/api/p/questions/3/submit", { body: { answer: "42" }, key: false }),
          ctx({ questionId: "3" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await h(
          req("POST", "/api/p/questions/3/submit", { body: { answer: "   " } }),
          ctx({ questionId: "3" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await h(
          req("POST", "/api/p/questions/3/submit", { body: { answer: "42", score: 100 } }),
          ctx({ questionId: "3" }),
        )
      ).status,
    ).toBe(400);
    expect(ops()).toHaveLength(0);
    const rep = createSubmitAnswerHandler(
      deps(fakeDb(participant, () => result({ replayed: true })).db),
    );
    const res = await rep(
      req("POST", "/api/p/questions/3/submit", { body: { answer: "42" } }),
      ctx({ questionId: "3" }),
    );
    expect(res.headers.get("idempotent-replay")).toBe("true");
  });
  it.each([
    ["SUBMISSION_PENDING", 409],
    ["QUESTION_TIMED_OUT", 409],
    ["QUESTION_NOT_ACTIVE", 409],
    ["COMPETITION_PAUSED", 423],
    ["TEAM_ENDED", 409],
    ["ALREADY_SUBMITTED", 409],
  ])("maps %s to %i", async (code, status) => {
    const { db } = fakeDb(participant, () => raised(code));
    const res = await createSubmitAnswerHandler(deps(db))(
      req("POST", "/api/p/questions/3/submit", { body: { answer: "42" } }),
      ctx({ questionId: "3" }),
    );
    expect(res.status).toBe(status);
    expect((await json(res)).error.code).toBe(code);
  });
});

describe("POST /api/admin/submissions/:id/approve | disapprove", () => {
  const approved = {
    replayed: false,
    submission: { id: SUB_ID, status: "APPROVED" },
    reward_awarded: 50,
    next_question_activated: true,
  };
  it("an Admin or Super Admin approves with the session's staff id; a participant cannot", async () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"] as const) {
      const { db, ops } = fakeDb(staff(role), () => approved);
      const res = await createApproveSubmissionHandler(deps(db))(
        req("POST", `/api/admin/submissions/${SUB_ID}/approve`),
        ctx({ submissionId: SUB_ID }),
      );
      expect(res.status).toBe(200);
      expect((await json(res)).data).toEqual({
        submission: { id: SUB_ID, status: "APPROVED" },
        reward_awarded: 50,
        next_question_activated: true,
      });
      expect(ops()).toEqual([
        {
          fn: "approve_submission",
          args: { p_staff_id: STAFF_ID, p_submission_id: SUB_ID, p_idem_key: KEY },
        },
      ]);
    }
    const p = fakeDb(participant, () => approved);
    const res = await createApproveSubmissionHandler(deps(p.db))(
      req("POST", `/api/admin/submissions/${SUB_ID}/approve`),
      ctx({ submissionId: SUB_ID }),
    );
    expect(res.status).toBe(403);
    expect(p.ops()).toHaveLength(0);
  });
  it("the reward cannot be chosen by the caller", async () => {
    const { db, ops } = fakeDb(staff("ADMIN"), () => approved);
    const res = await createApproveSubmissionHandler(deps(db))(
      req("POST", `/api/admin/submissions/${SUB_ID}/approve`, { body: { reward: 9999 } }),
      ctx({ submissionId: SUB_ID }),
    );
    expect(res.status).toBe(400);
    expect(ops()).toHaveLength(0);
  });
  it("a malformed id is 404; a submission already reviewed is 409; another admin's team is 404", async () => {
    const { db, ops } = fakeDb(staff("ADMIN"), () => approved);
    const bad = await createApproveSubmissionHandler(deps(db))(
      req("POST", "/api/admin/submissions/x/approve"),
      ctx({ submissionId: "x" }),
    );
    expect(bad.status).toBe(404);
    expect(ops()).toHaveLength(0);
    for (const [code, status] of [
      ["SUBMISSION_NOT_PENDING", 409],
      ["NOT_FOUND", 404],
    ] as const) {
      const f = fakeDb(staff("ADMIN"), () => raised(code));
      const res = await createApproveSubmissionHandler(deps(f.db))(
        req("POST", `/api/admin/submissions/${SUB_ID}/approve`),
        ctx({ submissionId: SUB_ID }),
      );
      expect(res.status).toBe(status);
    }
  });
  it("disapprove takes an optional note and passes null when there is none", async () => {
    const rejected = { replayed: false, submission: { id: SUB_ID, status: "REJECTED" } };
    const { db, ops } = fakeDb(staff("ADMIN"), () => rejected);
    const h = createDisapproveSubmissionHandler(deps(db));
    const path = `/api/admin/submissions/${SUB_ID}/disapprove`;
    expect((await h(req("POST", path), ctx({ submissionId: SUB_ID }))).status).toBe(200);
    expect(
      (
        await h(
          req("POST", path, { body: { note: " Check units " } }),
          ctx({ submissionId: SUB_ID }),
        )
      ).status,
    ).toBe(200);
    expect(ops().map((o) => o.args.p_note)).toEqual([null, "Check units"]);
    expect(
      (
        await h(
          req("POST", path, { body: { note: "x".repeat(501) } }),
          ctx({ submissionId: SUB_ID }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await h(req("POST", path, { body: { note: "x", score: 1 } }), ctx({ submissionId: SUB_ID })))
        .status,
    ).toBe(400);
    expect(ops()).toHaveLength(2);
  });
});

describe("GET /api/admin/queue", () => {
  const row = {
    id: SUB_ID,
    team_code: "T17",
    team_name: "Team Seventeen",
    theme_code: "A",
    ordinal: 1,
    question_id: 1,
    body_md: "Find x.",
    answer: "x = 4",
    explanation: "",
    submitted_by_slot: 2,
    submitted_at: NOW,
  };
  it("lists the pending submissions with the session's staff id; reference data never passes the whitelist", async () => {
    const { db, ops } = fakeDb(staff("ADMIN"), () => ({
      server_now: DB_NOW,
      submissions: [{ ...row, reference_answer: "SECRET", solution_notes: "SECRET" }],
    }));
    const res = await createReviewQueueHandler(deps(db))(req("GET", "/api/admin/queue"));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.submissions).toEqual([row]);
    expect(JSON.stringify(body)).not.toContain("SECRET");
    expect(ops()).toEqual([{ fn: "list_pending_submissions", args: { p_staff_id: STAFF_ID } }]);
  });
  it("is for staff only", async () => {
    const { db, ops } = fakeDb(participant, () => ({ server_now: DB_NOW, submissions: [] }));
    const res = await createReviewQueueHandler(deps(db))(req("GET", "/api/admin/queue"));
    expect(res.status).toBe(403);
    expect(ops()).toEqual([]);
  });
  it("rejects a malformed database answer instead of passing it on", async () => {
    const { db } = fakeDb(staff("ADMIN"), () => ({ submissions: [{ id: "x" }] }));
    const res = await createReviewQueueHandler(deps(db))(req("GET", "/api/admin/queue"));
    expect(res.status).toBe(503);
  });
});

describe("database faults", () => {
  it("an unexpected database error is a generic retryable 503 with no database text", async () => {
    const { db } = fakeDb(participant, () => new DbError("submit_answer", "XX000"));
    const res = await createSubmitAnswerHandler(deps(db))(
      req("POST", "/api/p/questions/3/submit", { body: { answer: "42" } }),
      ctx({ questionId: "3" }),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).not.toMatch(/XX000|submit_answer/);
  });
  it("a malformed result (an unlisted state) is a fault, not forwarded", async () => {
    const { db } = fakeDb(participant, () => ({
      server_now: DB_NOW,
      state_version: 1,
      question: question({ state: "LOCKED" }),
    }));
    const res = await createGetQuestionHandler(deps(db))(
      req("GET", "/api/p/questions/3"),
      ctx({ questionId: "3" }),
    );
    expect(res.status).toBe(503);
  });
});

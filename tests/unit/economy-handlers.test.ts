import { describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import { generateSessionToken } from "@/lib/auth/session";
import { DbError, type Db, type DbFunction } from "@/lib/db/adapter";
import {
  createBuyHintHandler,
  createBuyTimeHandler,
  createFinalSubmitHandler,
} from "@/lib/economy/handlers";
import type { GameplayDeps } from "@/lib/gameplay/handlers";

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

const question = (over: Record<string, unknown> = {}) => ({
  id: 3,
  theme_id: 1,
  theme_code: "A",
  ordinal: 3,
  state: "ACTIVE",
  reward_coins: 50,
  time_limit_seconds: 240,
  hints: [{ tier: 1, cost: 20, owned: true, purchasable: false, body_md: "Think small." }],
  buy_time: {
    purchase_count: 1,
    extra_seconds: 120,
    can_buy: true,
    options: [
      {
        id: 7,
        seconds: 120,
        cost: 20,
        max_purchases: null,
        purchased: 1,
        remaining_purchases: null,
      },
    ],
  },
  body_md: "Find x.",
  deadline: DB_NOW + 220_000,
  remaining_seconds: 220,
  draft: { answer: "", explanation: "", version: 0, updated_by_slot: null, updated_at: null },
  ...over,
});
const state = (over: Record<string, unknown> = {}) => ({
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
    coins: 380,
    started_at: DB_NOW - 1000,
    ends_at: DB_NOW + 14_399_000,
    ended_at: null,
    final_submitted_at: null,
    duration_seconds: 14400,
    remaining_seconds: 14399,
    expired: false,
    frozen: false,
  },
  themes: [],
  ...over,
});
const hintResult = (over: Record<string, unknown> = {}) => ({
  replayed: false,
  already_owned: false,
  tier: 1,
  hint: { tier: 1, body_md: "Think small." },
  question: question(),
  state: state(),
  ...over,
});
const timeResult = (over: Record<string, unknown> = {}) => ({
  replayed: false,
  purchase: { seq: 2, option_id: 7, seconds: 120, cost: 20 },
  question: question(),
  state: state(),
  ...over,
});
const finalResult = (over: Record<string, unknown> = {}) => ({
  replayed: false,
  state: state({
    team: { ...state().team, status: "FINAL_SUBMITTED", frozen: true, final_submitted_at: DB_NOW },
  }),
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
const ctx = (questionId: string) => ({ params: Promise.resolve({ questionId }) });
const raised = (fn: DbFunction, appCode: string, details?: Record<string, unknown>) =>
  new DbError(fn, "P0001", { appCode, details });

describe("POST /api/p/questions/:questionId/hints", () => {
  const call = (db: Db, init?: Parameters<typeof post>[1], id = "3") =>
    createBuyHintHandler(deps(db))(
      post(`/api/p/questions/${id}/hints`, init ?? { body: { tier: 1 } }),
      ctx(id),
    );

  it("buys as the session's team and member, with only a selector and the header key", async () => {
    const { db, calls, ops } = fakeDb(participant, () => hintResult());
    const res = await call(db);
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("idempotent-replay")).toBeNull();
    expect(body).toMatchObject({ ok: true, server_now: DB_NOW, state_version: 9 });
    expect(body.data.hint).toEqual({ tier: 1, body_md: "Think small." });
    expect(body.data.already_owned).toBe(false);
    expect(body.data.state.team.coins).toBe(380);
    expect(body.data).not.toHaveProperty("replayed");
    expect(calls[0]!.fn).toBe("resolve_session");
    expect(ops()).toEqual([
      {
        fn: "buy_hint",
        args: {
          p_team_id: TEAM_ID,
          p_member_id: MEMBER_ID,
          p_question_id: 3,
          p_tier: 1,
          p_idem_key: KEY,
        },
      },
    ]);
  });

  it("flags a replay with a header", async () => {
    const { db } = fakeDb(participant, () => hintResult({ replayed: true }));
    expect((await call(db)).headers.get("idempotent-replay")).toBe("true");
  });

  it("never accepts a price, coins, a team or a state from the client (strict body → 400, no database call)", async () => {
    for (const body of [
      { tier: 1, cost: 0 },
      { tier: 1, coins: 9999 },
      { tier: 1, team_id: OTHER_TEAM_ID },
      { tier: 1, state: "APPROVED" },
      { tier: 3 },
      { tier: "1" },
      { tier: 0 },
      {},
      [],
    ]) {
      const { db, ops } = fakeDb(participant);
      const res = await call(db, { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(ops()).toHaveLength(0);
    }
  });

  it("needs Origin, a valid key, a participant session and a well-formed question id", async () => {
    const a = fakeDb(participant);
    expect(
      (await call(a.db, { body: { tier: 1 }, headers: { origin: "https://evil.example" } })).status,
    ).toBe(403);
    const b = fakeDb(participant);
    expect(
      (await call(b.db, { body: { tier: 1 }, headers: { "idempotency-key": "nope" } })).status,
    ).toBe(400);
    const c = fakeDb(staff("ADMIN"));
    expect((await call(c.db)).status).toBe(403);
    const d = fakeDb(participant);
    expect((await call(d.db, undefined, "abc")).status).toBe(404);
    expect((await call(d.db, undefined, "51")).status).toBe(404);
    for (const x of [a, b, c, d]) expect(x.ops()).toHaveLength(0);
  });

  it("maps every refusal to its code and never forwards database text", async () => {
    const cases: [string, number, Record<string, unknown> | undefined][] = [
      ["INSUFFICIENT_COINS", 409, { have: 5, need: 20 }],
      ["HINT_TIER1_REQUIRED", 409, undefined],
      ["QUESTION_NOT_ACTIVE", 409, undefined],
      ["QUESTION_TIMED_OUT", 409, undefined],
      ["THEME_LOCKED", 409, undefined],
      ["COMPETITION_PAUSED", 423, undefined],
      ["ALREADY_SUBMITTED", 409, undefined],
      ["NOT_FOUND", 404, undefined],
    ];
    for (const [code, status, details] of cases) {
      const { db } = fakeDb(participant, () => raised("buy_hint", code, details));
      const res = await call(db);
      const body = await json(res);
      expect(res.status, code).toBe(status);
      expect(body.error.code).toBe(code);
    }
    const poor = fakeDb(participant, () =>
      raised("buy_hint", "INSUFFICIENT_COINS", { have: 5, need: 20, nested: { secret: "x" } }),
    );
    expect((await json(await call(poor.db))).error.details).toEqual({ have: 5, need: 20 });
    const odd = fakeDb(participant, () => new DbError("buy_hint", "23505"));
    expect((await call(odd.db)).status).toBe(503);
  });

  it("a malformed database result is a 503, never forwarded", async () => {
    for (const bad of [null, {}, hintResult({ hint: { tier: 1 } }), hintResult({ tier: 9 })]) {
      const { db } = fakeDb(participant, () => bad);
      expect((await call(db)).status).toBe(503);
    }
  });

  it("strips whatever the database adds beyond the whitelist (a hint's neighbour, an answer key)", async () => {
    const { db } = fakeDb(participant, () =>
      hintResult({ answer_key: "SECRET", question: question({ reference_answer: "SECRET" }) }),
    );
    expect(await (await call(db)).text()).not.toContain("SECRET");
  });

  it("TEAM_ENDED persists the end before the error goes back; other errors do not", async () => {
    const ended = fakeDb(participant, (fn) =>
      fn === "buy_hint" ? raised("buy_hint", "TEAM_ENDED") : { finalized: true, status: "ENDED" },
    );
    const res = await call(ended.db);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("TEAM_ENDED");
    expect(ended.ops().map((c) => c.fn)).toEqual(["buy_hint", "finalize_team_if_due"]);
    expect(ended.ops()[1]!.args).toEqual({ p_team_id: TEAM_ID });

    const other = fakeDb(participant, () => raised("buy_hint", "INSUFFICIENT_COINS"));
    await call(other.db);
    expect(other.ops().map((c) => c.fn)).toEqual(["buy_hint"]);
  });

  it("a failing finalize never changes the answer the participant gets", async () => {
    const { db } = fakeDb(participant, (fn) =>
      fn === "buy_hint" ? raised("buy_hint", "TEAM_ENDED") : new Error("db down"),
    );
    const res = await call(db);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("TEAM_ENDED");
  });
});

describe("POST /api/p/questions/:questionId/time", () => {
  const body = { optionId: 7, expectedPurchaseCount: 1 };
  const call = (db: Db, init: Parameters<typeof post>[1] = { body }, id = "3") =>
    createBuyTimeHandler(deps(db))(post(`/api/p/questions/${id}/time`, init), ctx(id));

  it("buys with the option id and the count the client saw; the price and seconds are the database's", async () => {
    const { db, ops } = fakeDb(participant, () => timeResult());
    const res = await call(db);
    const out = await json(res);
    expect(res.status).toBe(200);
    expect(out.data.purchase).toEqual({ seq: 2, option_id: 7, seconds: 120, cost: 20 });
    expect(out.state_version).toBe(9);
    expect(ops()).toEqual([
      {
        fn: "buy_time",
        args: {
          p_team_id: TEAM_ID,
          p_member_id: MEMBER_ID,
          p_question_id: 3,
          p_option_id: 7,
          p_expected_count: 1,
          p_idem_key: KEY,
        },
      },
    ]);
  });

  it("rejects forged prices, seconds, coins and malformed numbers with no database call", async () => {
    for (const b of [
      { optionId: 7, expectedPurchaseCount: 1, cost: 0 },
      { optionId: 7, expectedPurchaseCount: 1, seconds: 99999 },
      { optionId: 7, expectedPurchaseCount: 1, coins: 1e9 },
      { optionId: 7, expectedPurchaseCount: 1, deadline: 1 },
      { optionId: 0, expectedPurchaseCount: 1 },
      { optionId: 32768, expectedPurchaseCount: 1 },
      { optionId: 7.5, expectedPurchaseCount: 1 },
      { optionId: 7, expectedPurchaseCount: -1 },
      { optionId: 7, expectedPurchaseCount: 1001 },
      { optionId: "7", expectedPurchaseCount: 1 },
      { optionId: 7 },
      { expectedPurchaseCount: 1 },
    ]) {
      const { db, ops } = fakeDb(participant);
      const res = await call(db, { body: b });
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect(ops()).toHaveLength(0);
    }
  });

  it("maps STALE_PURCHASE_COUNT (with the count), TIME_PURCHASE_LIMIT, INSUFFICIENT_COINS and the state codes", async () => {
    const stale = fakeDb(participant, () =>
      raised("buy_time", "STALE_PURCHASE_COUNT", { count: 2 }),
    );
    const res = await call(stale.db);
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatchObject({
      code: "STALE_PURCHASE_COUNT",
      details: { count: 2 },
    });
    for (const code of [
      "TIME_PURCHASE_LIMIT",
      "INSUFFICIENT_COINS",
      "QUESTION_NOT_ACTIVE",
      "QUESTION_TIMED_OUT",
      "COMPETITION_PAUSED",
      "ALREADY_SUBMITTED",
    ]) {
      const { db } = fakeDb(participant, () => raised("buy_time", code));
      expect((await json(await call(db))).error.code).toBe(code);
    }
  });

  it("origin, key, role and selector are checked before the database", async () => {
    const a = fakeDb(participant);
    expect((await call(a.db, { body, headers: { origin: "https://evil.example" } })).status).toBe(
      403,
    );
    const b = fakeDb(participant);
    expect((await call(b.db, { body, headers: { "idempotency-key": "" } })).status).toBe(400);
    const c = fakeDb(staff("SUPER_ADMIN"));
    expect((await call(c.db)).status).toBe(403);
    const d = fakeDb(participant);
    expect((await call(d.db, { body }, "0")).status).toBe(404);
    for (const x of [a, b, c, d]) expect(x.ops()).toHaveLength(0);
  });

  it("TEAM_ENDED persists the end first", async () => {
    const { db, ops } = fakeDb(participant, (fn) =>
      fn === "buy_time" ? raised("buy_time", "TEAM_ENDED") : { finalized: true, status: "ENDED" },
    );
    expect((await call(db)).status).toBe(409);
    expect(ops().map((c) => c.fn)).toEqual(["buy_time", "finalize_team_if_due"]);
  });
});

describe("POST /api/p/final-submit", () => {
  const call = (db: Db, init: Parameters<typeof post>[1] = { body: { confirm: true } }) =>
    createFinalSubmitHandler(deps(db))(post("/api/p/final-submit", init));

  it("submits as the session's team with confirm: true and returns the frozen snapshot", async () => {
    const { db, ops } = fakeDb(participant, () => finalResult());
    const res = await call(db);
    const out = await json(res);
    expect(res.status).toBe(200);
    expect(out.data.team).toMatchObject({ status: "FINAL_SUBMITTED", frozen: true });
    expect(out.state_version).toBe(9);
    expect(ops()).toEqual([
      {
        fn: "final_submit",
        args: { p_team_id: TEAM_ID, p_member_id: MEMBER_ID, p_confirm: true, p_idem_key: KEY },
      },
    ]);
  });

  it("flags a replay", async () => {
    const { db } = fakeDb(participant, () => finalResult({ replayed: true }));
    expect((await call(db)).headers.get("idempotent-replay")).toBe("true");
  });

  it("requires an explicit confirm: true and nothing else", async () => {
    for (const body of [
      {},
      { confirm: false },
      { confirm: "true" },
      { confirm: 1 },
      { confirm: true, score: 9999 },
      { confirm: true, team_id: OTHER_TEAM_ID },
      "confirm",
    ]) {
      const { db, ops } = fakeDb(participant);
      const res = await call(db, { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(ops()).toHaveLength(0);
    }
    const none = fakeDb(participant);
    expect((await call(none.db, { body: undefined })).status).toBe(400);
  });

  it("origin, key and role are checked first; staff cannot final-submit for a team", async () => {
    const a = fakeDb(participant);
    expect(
      (await call(a.db, { body: { confirm: true }, headers: { origin: "https://evil.example" } }))
        .status,
    ).toBe(403);
    const b = fakeDb(participant);
    expect(
      (await call(b.db, { body: { confirm: true }, headers: { "idempotency-key": "x" } })).status,
    ).toBe(400);
    const c = fakeDb(staff("ADMIN"));
    expect((await call(c.db)).status).toBe(403);
    for (const x of [a, b, c]) expect(x.ops()).toHaveLength(0);
  });

  it("maps ALREADY_SUBMITTED, TEAM_ENDED, paused and not-started refusals", async () => {
    for (const [code, status] of [
      ["ALREADY_SUBMITTED", 409],
      ["TEAM_ENDED", 409],
      ["COMPETITION_PAUSED", 423],
      ["TEAM_NOT_STARTED", 409],
      ["COMPETITION_NOT_RUNNING", 423],
    ] as const) {
      const { db } = fakeDb(participant, (fn) =>
        fn === "final_submit" ? raised("final_submit", code) : { finalized: false, status: "x" },
      );
      const res = await call(db);
      expect(res.status, code).toBe(status);
      expect((await json(res)).error.code).toBe(code);
    }
  });

  it("only TEAM_ENDED triggers the extra finalize call", async () => {
    const a = fakeDb(participant, () => raised("final_submit", "ALREADY_SUBMITTED"));
    await call(a.db);
    expect(a.ops().map((c) => c.fn)).toEqual(["final_submit"]);
    const b = fakeDb(participant, (fn) =>
      fn === "final_submit"
        ? raised("final_submit", "TEAM_ENDED")
        : { finalized: true, status: "ENDED" },
    );
    await call(b.db);
    expect(b.ops().map((c) => c.fn)).toEqual(["final_submit", "finalize_team_if_due"]);
  });
});

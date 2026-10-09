import { randomBytes, randomUUID } from "node:crypto";

import { request, type APIRequestContext, type BrowserContext } from "@playwright/test";

import type { E2ETeam } from "./identities";
import { control, loginForCookies, participantCredentials, staffCredentials } from "./session";

/**
 * Helpers for the gameplay specs (B13). Every test that changes game state builds its OWN team through the real
 * `POST /api/admin/teams` endpoint (as the E2E admin), so tests never share a clock, a balance or a draft and can run
 * in parallel. All state changes below go through the real routes with the real cookies; the only back door is the
 * read-only `inspect` control of the in-memory database, used to prove "exactly once".
 */
const origin = () => `http://localhost:${process.env.PORT ?? 3100}`;

type Cookies = Awaited<ReturnType<BrowserContext["cookies"]>>;

export async function api(cookies: Cookies = []): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: origin(),
    extraHTTPHeaders: { Origin: origin() },
    storageState: { cookies, origins: [] },
  });
}

const suffix = () => randomBytes(5).toString("hex").toUpperCase();

/** A brand-new team of four, owned by the E2E admin, with random credentials. */
export async function createPlayerTeam(): Promise<E2ETeam> {
  const tag = suffix();
  const password = randomBytes(15).toString("base64url");
  const team: E2ETeam = {
    code: `G${tag}`,
    name: `Game Team ${tag}`,
    loginId: `game_${tag.toLowerCase()}`,
    password,
    members: [1, 2, 3, 4].map((slot) => ({ slot, admissionNo: `G${tag}${slot}` })),
  };
  const admin = await api(
    await loginForCookies("/api/auth/staff/login", staffCredentials("e2e_admin")),
  );
  try {
    const res = await admin.post("/api/admin/teams", {
      headers: { "Idempotency-Key": randomUUID() },
      data: {
        teamCode: team.code,
        name: team.name,
        loginId: team.loginId,
        password,
        confirmPassword: password,
        admissionNos: team.members.map((m) => m.admissionNo),
      },
    });
    if (!res.ok()) throw new Error(`could not create the test team: ${res.status()}`);
  } finally {
    await admin.dispose();
  }
  return team;
}

/** Signs one member in through the real login endpoint and installs the session cookie in the browser context. */
export async function signInMember(
  context: BrowserContext,
  team: E2ETeam,
  slot: 1 | 2 | 3 | 4,
): Promise<Cookies> {
  const cookies = await loginForCookies(
    "/api/auth/participant/login",
    participantCredentials(team, slot),
  );
  await context.addCookies(cookies);
  return cookies;
}

export interface Json {
  ok: boolean;
  status: number;
  /** The API marks an idempotent replay with the `Idempotent-Replay: true` response header. */
  replayed: boolean;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper: shapes are asserted by the specs
}

async function send(
  ctx: APIRequestContext,
  method: "get" | "post" | "put",
  url: string,
  data?: unknown,
  key: string | null = null,
): Promise<Json> {
  const headers: Record<string, string> = {};
  if (key) headers["Idempotency-Key"] = key;
  const res = await ctx[method](url, { headers, ...(data === undefined ? {} : { data }) });
  return {
    ok: res.ok(),
    status: res.status(),
    replayed: res.headers()["idempotent-replay"] === "true",
    body: await res.json(),
  };
}

/** The participant API as one member sees it (cookie-authenticated, same-origin). */
export function player(ctx: APIRequestContext) {
  return {
    state: () => send(ctx, "get", "/api/p/state"),
    start: (key = randomUUID()) => send(ctx, "post", "/api/p/start", undefined, key),
    unlock: (themeId: number, key = randomUUID()) =>
      send(ctx, "post", `/api/p/themes/${themeId}/unlock`, undefined, key),
    enter: (questionId: number, key = randomUUID()) =>
      send(ctx, "post", `/api/p/questions/${questionId}/enter`, undefined, key),
    question: (questionId: number) => send(ctx, "get", `/api/p/questions/${questionId}`),
    draft: (questionId: number, answer: string, expectedVersion: number) =>
      send(ctx, "put", `/api/p/questions/${questionId}/draft`, { answer, expectedVersion }),
    submit: (questionId: number, answer: string, key = randomUUID()) =>
      send(ctx, "post", `/api/p/questions/${questionId}/submit`, { answer }, key),
    hint: (questionId: number, tier: number, key = randomUUID()) =>
      send(ctx, "post", `/api/p/questions/${questionId}/hints`, { tier }, key),
    buyTime: (
      questionId: number,
      optionId: number,
      expectedPurchaseCount: number,
      key = randomUUID(),
    ) =>
      send(
        ctx,
        "post",
        `/api/p/questions/${questionId}/time`,
        { optionId, expectedPurchaseCount },
        key,
      ),
    finalSubmit: (key = randomUUID(), body: unknown = { confirm: true }) =>
      send(ctx, "post", "/api/p/final-submit", body, key),
  };
}

/** The admin's review path (the minimal controlled approval of B13). */
export function reviewer(ctx: APIRequestContext) {
  return {
    approve: (submissionId: string, key = randomUUID()) =>
      send(ctx, "post", `/api/admin/submissions/${submissionId}/approve`, undefined, key),
    disapprove: (submissionId: string, note?: string, key = randomUUID()) =>
      send(
        ctx,
        "post",
        `/api/admin/submissions/${submissionId}/disapprove`,
        note ? { note } : {},
        key,
      ),
  };
}

export async function adminReviewer(): Promise<{
  api: APIRequestContext;
  review: ReturnType<typeof reviewer>;
}> {
  const ctx = await api(
    await loginForCookies("/api/auth/staff/login", staffCredentials("e2e_admin")),
  );
  return { api: ctx, review: reviewer(ctx) };
}

/** Enter the competition, unlock theme A and enter Q1, all through the API as member `slot` (default 1). */
export async function beginTheme(team: E2ETeam, opts: { enterQ1?: boolean } = {}): Promise<void> {
  const ctx = await api(
    await loginForCookies("/api/auth/participant/login", participantCredentials(team, 1)),
  );
  try {
    const p = player(ctx);
    for (const step of [
      await p.start(),
      await p.unlock(1),
      ...(opts.enterQ1 === false ? [] : [await p.enter(1)]),
    ]) {
      if (!step.ok)
        throw new Error(`setup step failed: ${step.status} ${JSON.stringify(step.body)}`);
    }
  } finally {
    await ctx.dispose();
  }
}

/** What the in-memory database holds for a team (never reachable from the app). */
export async function inspect(team: E2ETeam): Promise<{
  coins: number;
  version: number;
  status: string;
  startedAt: number | null;
  endsAt: number | null;
  endedAt: number | null;
  finalSubmittedAt: number | null;
  timerSeconds: number | null;
  /** The frozen gameplay score parts (B16), or null while the team is still playing. */
  final: { completed: number; solved: number; minutes: number; score: number } | null;
  /** When the UFM penalty was applied, or null. */
  penalizedAt: number | null;
  /** The OFFICIAL score now (0 when penalised). */
  score: number;
  hints: string[];
  ledger: { type: string; amount: number; qid: number }[];
  themes: number[];
  questions: Record<
    string,
    {
      state: string;
      deadline: number | null;
      remaining: number | null;
      timeCount: number;
      extra: number;
    }
  >;
  submissions: { id: string; qid: number; status: string; reward: number | null }[];
  audit: string[];
}> {
  return (await control("inspect", { loginId: team.loginId })) as never;
}

/** Time passes for one team only (see `ageTeam` in fake-gameplay.mjs): its clocks move `ms` towards their ends. */
export async function ageTeam(
  team: E2ETeam,
  ms: number,
  opts: { questions?: boolean } = {},
): Promise<void> {
  await control("ageTeam", { loginId: team.loginId, ms, questions: opts.questions ?? true });
}

/** A team started under the pre-B15 2-hour rule (its allowance snapshot stays 7200 whatever the competition says). */
export async function makeLegacyTimer(team: E2ETeam, seconds = 7200): Promise<void> {
  await control("legacyTimer", { loginId: team.loginId, seconds });
}

/** A signed-in API context for one member of a team. */
export async function memberApi(team: E2ETeam, slot: 1 | 2 | 3 | 4): Promise<APIRequestContext> {
  return api(
    await loginForCookies("/api/auth/participant/login", participantCredentials(team, slot)),
  );
}

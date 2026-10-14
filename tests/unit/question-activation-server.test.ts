import { describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import { createParticipantLoginHandler, type AuthDeps } from "@/lib/auth/handlers";
import { toDbError, type Db, type DbFunction } from "@/lib/db/adapter";
import { createFinalSubmitHandler } from "@/lib/economy/handlers";
import {
  createEnterQuestionHandler,
  createGetQuestionHandler,
  createUnlockThemeHandler,
} from "@/lib/gameplay/handlers";
import { createStartTeamHandler } from "@/lib/runtime/handlers";

import { createFakeBackend } from "../e2e/support/fake-postgrest.mjs";

/**
 * B19-r2. The fullscreen gate in the browser keeps the PAGE from calling the question APIs early. The SERVER must keep
 * refusing invalid activation on its own, whatever any client does, and it has no idea what fullscreen is. These tests
 * call the real handlers over the in-memory backend (which mirrors the SQL engine; the SQL itself is covered by
 * supabase/tests/) directly, the way a modified client or curl would, with a perfectly valid session.
 */
const ORIGIN = "https://concetto.example";
const identities = {
  staff: [{ username: "asha", password: "asha-pw-1", displayName: "Asha", role: "ADMIN" }],
  teams: [
    {
      code: "T1",
      name: "Team One",
      loginId: "team_one",
      password: "team-pw-1",
      members: [{ slot: 1, admissionNo: "ADM1" }],
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
        // what PostgREST does with `raise exception 'CODE'` (SQLSTATE P0001), exactly as the app's adapter reads it
        if (err instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.message)) {
          const d = (err as Error & { details?: unknown }).details;
          throw toDbError(fn, {
            code: "P0001",
            message: err.message,
            details: d ? JSON.stringify(d) : null,
          });
        }
        throw err;
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
      SESSION_TOKEN_PEPPER: "pepper-for-tests-0123456789abcdef0123",
    }),
    now: () => Date.now(),
  };
  return {
    backend,
    login: createParticipantLoginHandler(deps),
    start: createStartTeamHandler(deps),
    unlock: createUnlockThemeHandler(deps),
    enter: createEnterQuestionHandler(deps),
    read: createGetQuestionHandler(deps),
    finalSubmit: createFinalSubmitHandler(deps),
  };
}
type T = ReturnType<typeof setup>;

let n = 0;
const key = () => `5d6f1c1a-3b8e-4f0a-9c21-${String(++n).padStart(12, "0")}`;
const post = (path: string, cookie: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      cookie,
      "idempotency-key": key(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = <K extends string>(name: K, id: number) => ({
  params: Promise.resolve({ [name]: String(id) } as Record<K, string>),
});

async function signIn(t: T) {
  const res = await t.login(
    new Request(`${ORIGIN}/api/auth/participant/login`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        teamLoginId: "team_one",
        password: "team-pw-1",
        admissionNo: "ADM1",
      }),
    }),
  );
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
const code = async (res: Response) =>
  ((await res.json()) as { error?: { code: string } }).error?.code;
const enter = (t: T, cookie: string, id = 1, over: Record<string, string> = {}) =>
  t.enter(post(`/api/p/questions/${id}/enter`, cookie, undefined, over), ctx("questionId", id));

describe("the server refuses invalid question activation by itself, with a valid session and no fullscreen anywhere", () => {
  it("a team that has not started cannot enter a question or unlock a theme (TEAM_NOT_STARTED / THEME_LOCKED), and nothing becomes ACTIVE", async () => {
    const t = setup();
    const cookie = await signIn(t);
    t.backend.controls.competition({ loginId: "team_one", status: "RUNNING" });
    const entered = await enter(t, cookie);
    expect(entered.status).toBeGreaterThanOrEqual(400);
    expect(await code(entered)).toBe("TEAM_NOT_STARTED"); // assert_playable runs before any question lookup
    const unlocked = await t.unlock(post("/api/p/themes/1/unlock", cookie), ctx("themeId", 1));
    expect(await code(unlocked)).toBe("TEAM_NOT_STARTED");
    const inspect = t.backend.controls.inspect({ loginId: "team_one" }) as {
      status: string;
      startedAt: number | null;
      questions: Record<string, { state: string }>;
    };
    expect(inspect.status).toBe("NOT_STARTED");
    expect(inspect.startedAt).toBeNull();
    expect(Object.values(inspect.questions).filter((q) => q.state === "ACTIVE")).toHaveLength(0);
  });

  it("a running team whose theme is still locked cannot enter its Q1 (THEME_LOCKED); a locked Q2 is refused too (QUESTION_NOT_AVAILABLE)", async () => {
    const t = setup();
    const cookie = await signIn(t);
    t.backend.controls.competition({ loginId: "team_one", status: "RUNNING" });
    expect((await t.start(post("/api/p/start", cookie))).status).toBe(200);
    expect(await code(await enter(t, cookie, 1))).toBe("THEME_LOCKED");
    expect((await t.unlock(post("/api/p/themes/1/unlock", cookie), ctx("themeId", 1))).status).toBe(
      200,
    );
    expect(await code(await enter(t, cookie, 2))).toBe("QUESTION_NOT_AVAILABLE");
  });

  it("reading a question of a team that has not started, or of a theme it has not unlocked, returns no question text", async () => {
    const t = setup();
    const cookie = await signIn(t);
    t.backend.controls.competition({ loginId: "team_one", status: "RUNNING" });
    const read = async () =>
      t.read(
        new Request(`${ORIGIN}/api/p/questions/1`, { headers: { cookie } }),
        ctx("questionId", 1),
      );
    for (const phase of ["not started", "started, theme locked"]) {
      if (phase === "started, theme locked") await t.start(post("/api/p/start", cookie));
      const res = await read();
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await code(res)).toBe("THEME_LOCKED"); // an error, not a question: no text, hints or draft
    }
  });

  it("a paused or closed competition refuses activation (COMPETITION_PAUSED / COMPETITION_NOT_RUNNING)", async () => {
    const t = setup();
    const cookie = await signIn(t);
    t.backend.controls.competition({ loginId: "team_one", status: "RUNNING" });
    await t.start(post("/api/p/start", cookie));
    await t.unlock(post("/api/p/themes/1/unlock", cookie), ctx("themeId", 1));
    t.backend.controls.competition({ loginId: "team_one", status: "PAUSED" });
    expect(await code(await enter(t, cookie, 1))).toBe("COMPETITION_PAUSED");
    t.backend.controls.competition({ loginId: "team_one", status: "ENDED" });
    expect(await code(await enter(t, cookie, 1))).toBe("COMPETITION_NOT_RUNNING");
    const q = (
      t.backend.controls.inspect({ loginId: "team_one" }) as {
        questions: Record<string, { state: string }>;
      }
    ).questions["1"]!;
    expect(q.state).toBe("AVAILABLE"); // never activated
  });

  it("after the team's final submission activation is refused (ALREADY_SUBMITTED) and the question stays unactivated", async () => {
    const t = setup();
    const cookie = await signIn(t);
    t.backend.controls.competition({ loginId: "team_one", status: "RUNNING" });
    await t.start(post("/api/p/start", cookie));
    await t.unlock(post("/api/p/themes/1/unlock", cookie), ctx("themeId", 1));
    const done = await t.finalSubmit(post("/api/p/final-submit", cookie, { confirm: true }));
    expect(done.status).toBe(200);
    expect(await code(await enter(t, cookie, 1))).toBe("ALREADY_SUBMITTED");
    const q = (
      t.backend.controls.inspect({ loginId: "team_one" }) as {
        questions: Record<string, { state: string }>;
      }
    ).questions["1"]!;
    expect(q.state).toBe("AVAILABLE");
  });

  it("the deadline is the database's: the body, query and headers of the request cannot set it, and a second entry returns the same one", async () => {
    const t = setup();
    const cookie = await signIn(t);
    t.backend.controls.competition({ loginId: "team_one", status: "RUNNING" });
    await t.start(post("/api/p/start", cookie));
    await t.unlock(post("/api/p/themes/1/unlock", cookie), ctx("themeId", 1));
    // a request body is refused outright (the route takes none) ...
    const withBody = await t.enter(
      post("/api/p/questions/1/enter", cookie, { deadline: 1, fullscreen: true }),
      ctx("questionId", 1),
    );
    expect(withBody.status).toBeGreaterThanOrEqual(400);
    // ... and a header or query claiming a deadline or fullscreen changes nothing
    const first = await t.enter(
      new Request(`${ORIGIN}/api/p/questions/1/enter?deadline=1&fullscreen=1`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          cookie,
          "idempotency-key": key(),
          "x-deadline": "1",
          "sec-fetch-dest": "fullscreen",
        },
      }),
      ctx("questionId", 1),
    );
    expect(first.status).toBe(200);
    const a = (await first.json()) as { data: { question: { state: string; deadline: number } } };
    expect(a.data.question.state).toBe("ACTIVE");
    expect(a.data.question.deadline).toBeGreaterThan(Date.now());
    const second = await enter(t, cookie, 1);
    const b = (await second.json()) as { data: { question: { deadline: number } } };
    expect(b.data.question.deadline).toBe(a.data.question.deadline); // never restarted or extended
  });

  it("without a session none of this is reachable (401), and a revoked session is dead", async () => {
    const t = setup();
    for (const cookie of [`${SESSION_COOKIE_NAME}=forged`, "other=1"]) {
      expect((await enter(t, cookie)).status).toBe(401);
      expect(
        (
          await t.read(
            new Request(`${ORIGIN}/api/p/questions/1`, { headers: { cookie } }),
            ctx("questionId", 1),
          )
        ).status,
      ).toBe(401);
    }
  });

  it("LIMIT, stated plainly: the server cannot tell whether the browser is in fullscreen, so a modified client with a valid session can activate Q1 without it", async () => {
    // The UI gate is a deterrent for ordinary participants, not a server control. What the server does guarantee is
    // that only a live session, a started team, an unlocked theme and an open competition can ever activate anything.
    const t = setup();
    const cookie = await signIn(t);
    t.backend.controls.competition({ loginId: "team_one", status: "RUNNING" });
    await t.start(post("/api/p/start", cookie));
    await t.unlock(post("/api/p/themes/1/unlock", cookie), ctx("themeId", 1));
    expect((await enter(t, cookie, 1)).status).toBe(200);
  });
});

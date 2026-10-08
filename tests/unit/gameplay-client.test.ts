import { describe, expect, it, vi } from "vitest";

import {
  enterCompetition,
  enterQuestionCall,
  fetchQuestion,
  fetchTeamState,
  saveDraftCall,
  submitAnswerCall,
  unlockThemeCall,
} from "@/lib/gameplay/client";

const q = {
  id: 1,
  theme_id: 1,
  theme_code: "A",
  ordinal: 1,
  state: "ACTIVE",
  reward_coins: 50,
  time_limit_seconds: 240,
  body_md: "Find x.",
  deadline: 5,
  remaining_seconds: 4,
  draft: { answer: "", explanation: "", version: 0, updated_by_slot: null, updated_at: null },
};
const envelope = (data: unknown, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ ok: true, data, server_now: 123, ...extra }), { status: 200 });
const failureBody = (code: string, status: number, details?: unknown) =>
  new Response(
    JSON.stringify({ ok: false, error: { code, message: "m", details }, server_now: 1 }),
    { status },
  );

function stubFetch(res: Response | Error) {
  const f = vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
  vi.stubGlobal("fetch", f);
  return f;
}

describe("gameplay client", () => {
  it("sends the Idempotency-Key only on state-changing calls and never a team, member or time", async () => {
    const f = stubFetch(envelope({ question: q, started_now: true }));
    await enterQuestionCall(7, "5d6f1c1a-3b8e-4f0a-9c21-7e4d2a9b8c10");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/p/questions/7/enter");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
    expect(init.headers).toMatchObject({
      "Idempotency-Key": "5d6f1c1a-3b8e-4f0a-9c21-7e4d2a9b8c10",
    });
    expect(init.body).toBeUndefined();
    f.mockClear();
    stubFetch(envelope({ question: q }));
    const g = vi.mocked(fetch);
    await fetchQuestion(7);
    expect((g.mock.calls[0] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty(
      "Idempotency-Key",
    );
    expect((g.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe("GET");
  });

  it("draft save is a PUT with exactly answer, explanation and expectedVersion", async () => {
    const f = stubFetch(envelope({ version: 2, updated_by_slot: 1, updated_at: 9 }));
    const r = await saveDraftCall(3, "x = 4", 1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/p/questions/3/draft");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      answer: "x = 4",
      explanation: "",
      expectedVersion: 1,
    });
    expect(r).toMatchObject({ ok: true, data: { version: 2 }, serverNow: 123 });
  });

  it("submit sends the answer with its key", async () => {
    const f = stubFetch(
      envelope({ question: { ...q, state: "PENDING_APPROVAL", deadline: undefined } }),
    );
    const r = await submitAnswerCall(3, "42", "5d6f1c1a-3b8e-4f0a-9c21-7e4d2a9b8c10");
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ answer: "42", explanation: "" });
    expect(r.ok && r.data.state).toBe("PENDING_APPROVAL");
  });

  it("reports the envelope's stable error code and details, never its message", async () => {
    stubFetch(failureBody("INSUFFICIENT_COINS", 409, { have: 1, need: 100 }));
    const r = await unlockThemeCall(2, "5d6f1c1a-3b8e-4f0a-9c21-7e4d2a9b8c10");
    expect(r).toEqual({
      ok: false,
      status: 409,
      code: "INSUFFICIENT_COINS",
      details: { have: 1, need: 100 },
    });
  });

  it("a lost connection is NETWORK_ERROR; a non-JSON answer is BAD_RESPONSE", async () => {
    stubFetch(new TypeError("offline"));
    expect(await fetchTeamState()).toEqual({ ok: false, status: 0, code: "NETWORK_ERROR" });
    stubFetch(new Response("<html>gateway</html>", { status: 502 }));
    expect(await enterCompetition("5d6f1c1a-3b8e-4f0a-9c21-7e4d2a9b8c10")).toEqual({
      ok: false,
      status: 502,
      code: "BAD_RESPONSE",
    });
  });

  it("a payload that does not match the whitelist is refused, not trusted", async () => {
    stubFetch(envelope({ question: { ...q, state: "LOCKED" } }));
    expect(await fetchQuestion(1)).toMatchObject({ ok: false, code: "BAD_RESPONSE" });
    stubFetch(envelope({ nope: true }));
    expect(await fetchTeamState()).toMatchObject({ ok: false, code: "BAD_RESPONSE" });
  });

  it("strips anything outside the whitelist (a reference answer can never be surfaced)", async () => {
    stubFetch(
      envelope({ question: { ...q, reference_answer: "SECRET", solution_notes: "SECRET" } }),
    );
    const r = await fetchQuestion(1);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });
});

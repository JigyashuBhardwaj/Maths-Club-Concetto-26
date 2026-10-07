import { describe, expect, it, vi } from "vitest";

import { postJson } from "@/lib/auth/client";
import { INVALID_CREDENTIALS_TEXT, loginFailureMessage } from "@/lib/auth/login-messages";

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("postJson", () => {
  it("returns the data of a success envelope and posts JSON with the same-origin cookie policy", async () => {
    const fetchImpl = reply(200, { ok: true, data: { role: "ADMIN" }, server_now: 1 });
    const result = await postJson<{ role: string }>("/api/auth/staff/login", { a: 1 }, fetchImpl);
    expect(result).toEqual({ ok: true, data: { role: "ADMIN" } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/staff/login");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("sends no body and no content type when there is no body (logout)", async () => {
    const fetchImpl = reply(200, { ok: true, data: {}, server_now: 1 });
    await postJson("/api/auth/logout", undefined, fetchImpl);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it("returns the stable code and details of a failure envelope", async () => {
    const result = await postJson(
      "/x",
      {},
      reply(429, {
        ok: false,
        error: { code: "RATE_LIMITED", message: "m", details: { retry_after_seconds: 30 } },
        server_now: 1,
      }),
    );
    expect(result).toEqual({
      ok: false,
      status: 429,
      code: "RATE_LIMITED",
      details: { retry_after_seconds: 30 },
    });
  });

  it("never trusts a body that is not an envelope", async () => {
    for (const [status, body] of [
      [200, { ok: true }],
      [200, "text"],
      [200, null],
      [500, { something: "else" }],
      [502, []],
    ] as const) {
      const r = await postJson("/x", {}, reply(status, body));
      if (status === 200 && (body as { ok?: boolean } | null)?.ok === true) {
        expect(r.ok).toBe(true); // an ok envelope with a 200 is a success; its data is simply undefined
      } else {
        expect(r).toMatchObject({ ok: false, code: "BAD_RESPONSE" });
      }
    }
    expect(
      await postJson(
        "/x",
        {},
        vi.fn(async () => new Response("<html>", { status: 502 })),
      ),
    ).toEqual({
      ok: false,
      status: 502,
      code: "BAD_RESPONSE",
    });
  });

  it("does not treat a failure status as success even if the body claims ok", async () => {
    const r = await postJson("/x", {}, reply(401, { ok: true, data: {}, server_now: 1 }));
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("reports a network failure as status 0", async () => {
    const r = await postJson(
      "/x",
      {},
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    expect(r).toEqual({ ok: false, status: 0, code: "NETWORK_ERROR" });
  });
});

describe("loginFailureMessage", () => {
  const fail = (code: string, details?: Record<string, unknown>) =>
    ({ ok: false, status: 400, code, details }) as const;

  it("gives one answer for every kind of wrong credential", () => {
    expect(loginFailureMessage(fail("UNAUTHENTICATED"), "participant")).toBe(
      INVALID_CREDENTIALS_TEXT,
    );
    expect(loginFailureMessage(fail("UNAUTHENTICATED"), "staff")).toBe(INVALID_CREDENTIALS_TEXT);
    expect(INVALID_CREDENTIALS_TEXT).not.toMatch(/password|admission|username|team/i);
  });

  it("shows the wait only as a number", () => {
    expect(loginFailureMessage(fail("RATE_LIMITED", { retry_after_seconds: 29.2 }), "staff")).toBe(
      "Too many attempts. Please wait 30 seconds and try again.",
    );
    expect(
      loginFailureMessage(fail("RATE_LIMITED", { retry_after_seconds: "<script>" }), "staff"),
    ).toBe("Too many attempts. Please wait a little and try again.");
    expect(loginFailureMessage(fail("RATE_LIMITED"), "staff")).toMatch(/Too many attempts/);
  });

  it("explains a closed competition to a participant", () => {
    expect(loginFailureMessage(fail("COMPETITION_NOT_RUNNING"), "participant")).toMatch(
      /isn't open for sign-in/,
    );
  });

  it("falls back to a generic message for anything else, never to server text", () => {
    for (const code of ["SERVICE_UNAVAILABLE", "BAD_RESPONSE", "WHATEVER", "NETWORK_ERROR"]) {
      const text = loginFailureMessage(
        fail(code, { message: "select * from teams" }),
        "participant",
      );
      expect(text).not.toMatch(/select|teams|WHATEVER/);
    }
    expect(loginFailureMessage(fail("NETWORK_ERROR"), "staff")).toMatch(/reach the server/);
    expect(loginFailureMessage(fail("SERVICE_UNAVAILABLE"), "staff")).toMatch(
      /temporarily unavailable/,
    );
  });
});

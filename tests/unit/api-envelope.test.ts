import { afterEach, describe, expect, it, vi } from "vitest";

import { failure, respond, success } from "@/lib/api/envelope";
import { ApiError, ERROR_STATUS, authFailureToError } from "@/lib/api/errors";

const NOW = 1_760_000_000_000;

describe("envelope", () => {
  it("success: { ok, data, server_now }, no-store", async () => {
    const res = success({ a: 1 }, NOW);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, data: { a: 1 }, server_now: NOW });
  });

  it("failure: { ok:false, error:{code,message,details?}, server_now } with the code's status and extra headers", async () => {
    const res = failure(
      new ApiError("RATE_LIMITED", "Slow down.", {
        details: { retry_after_seconds: 30 },
        headers: { "Retry-After": "30" },
      }),
      NOW,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "RATE_LIMITED", message: "Slow down.", details: { retry_after_seconds: 30 } },
      server_now: NOW,
    });
    const plain = await failure(new ApiError("FORBIDDEN", "No."), NOW).json();
    expect(plain.error).toEqual({ code: "FORBIDDEN", message: "No." });
  });
});

describe("error codes", () => {
  it("map to the documented HTTP statuses (docs/API_SPEC.md §1–§2)", () => {
    expect(ERROR_STATUS).toEqual({
      UNAUTHENTICATED: 401,
      FORBIDDEN: 403,
      VALIDATION_FAILED: 400,
      RATE_LIMITED: 429,
      NOT_FOUND: 404,
      COMPETITION_NOT_RUNNING: 423,
      COMPETITION_PAUSED: 423,
      TEAM_NOT_STARTED: 409,
      TEAM_ENDED: 409,
      ALREADY_SUBMITTED: 409,
      COMPETITION_NOT_READY: 409,
      INVALID_COMPETITION_TRANSITION: 409,
      IDEMPOTENCY_KEY_REUSED: 409,
      USERNAME_TAKEN: 409,
      TEAM_CODE_TAKEN: 409,
      LOGIN_ID_TAKEN: 409,
      ADMISSION_NO_TAKEN: 409,
      THEME_ALREADY_UNLOCKED: 409,
      THEME_LOCKED: 409,
      INSUFFICIENT_COINS: 409,
      QUESTION_NOT_ACTIVE: 409,
      QUESTION_NOT_AVAILABLE: 409,
      QUESTION_TIMED_OUT: 409,
      SUBMISSION_PENDING: 409,
      SUBMISSION_NOT_PENDING: 409,
      STALE_DRAFT: 409,
      HINT_TIER1_REQUIRED: 409,
      STALE_PURCHASE_COUNT: 409,
      TIME_PURCHASE_LIMIT: 409,
      SERVICE_UNAVAILABLE: 503,
    });
  });

  it("authFailureToError: invalid credentials and unknown codes are the same generic 401", () => {
    for (const code of ["INVALID_CREDENTIALS", "UNAUTHENTICATED", "SOMETHING_NEW", ""]) {
      const e = authFailureToError({ code });
      expect([e.code, e.status, e.message]).toEqual([
        "UNAUTHENTICATED",
        401,
        "Invalid credentials",
      ]);
      expect(e.details).toBeUndefined();
    }
  });

  it("authFailureToError: RATE_LIMITED carries Retry-After (at least 1 s, rounded up); a closed competition is 423", () => {
    const a = authFailureToError({ code: "RATE_LIMITED", retry_after_seconds: 29.2 });
    expect([a.status, a.headers, a.details]).toEqual([
      429,
      { "Retry-After": "30" },
      { retry_after_seconds: 30 },
    ]);
    expect(authFailureToError({ code: "RATE_LIMITED", retry_after_seconds: 0 }).headers).toEqual({
      "Retry-After": "1",
    });
    expect(authFailureToError({ code: "RATE_LIMITED" }).headers).toEqual({ "Retry-After": "1" });
    expect(authFailureToError({ code: "COMPETITION_NOT_RUNNING" }).status).toBe(423);
  });
});

describe("respond", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes a handler's response through", async () => {
    const res = await respond(
      () => NOW,
      async () => success({}, NOW),
    );
    expect(res.status).toBe(200);
  });

  it("turns an ApiError into its envelope", async () => {
    const res = await respond(
      () => NOW,
      async () => {
        throw new ApiError("VALIDATION_FAILED", "Bad.", { details: { fields: ["x"] } });
      },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.details).toEqual({ fields: ["x"] });
  });

  it("turns anything else into a generic 503 that leaks nothing, and logs only the error's name", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await respond(
      () => NOW,
      async () => {
        throw new Error("connect ECONNREFUSED postgres://user:hunter2@db/prod  password=hunter2");
      },
    );
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text).error).toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: "Temporarily unavailable. Please retry.",
    });
    expect(text).not.toMatch(/hunter2|postgres|ECONNREFUSED/);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/hunter2|postgres|ECONNREFUSED/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("clears the session cookie on a 401 only when asked to", async () => {
    const clear = () => "__Host-session=; Max-Age=0";
    const unauth = await respond(
      () => NOW,
      async () => {
        throw new ApiError("UNAUTHENTICATED", "Nope.");
      },
      clear,
    );
    expect(unauth.headers.get("set-cookie")).toBe("__Host-session=; Max-Age=0");
    const forbidden = await respond(
      () => NOW,
      async () => {
        throw new ApiError("FORBIDDEN", "Nope.");
      },
      clear,
    );
    expect(forbidden.headers.get("set-cookie")).toBeNull();
    const without = await respond(
      () => NOW,
      async () => {
        throw new ApiError("UNAUTHENTICATED", "Nope.");
      },
    );
    expect(without.headers.get("set-cookie")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import { assertSameOrigin } from "@/lib/auth/origin";

const APP = "https://concetto.example";
const req = (method: string, origin?: string) =>
  new Request("https://concetto.example/api/x", {
    method,
    headers: origin === undefined ? {} : { origin },
  });

describe("assertSameOrigin", () => {
  it("lets safe methods through without an Origin header", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"])
      expect(() => assertSameOrigin(req(m), APP)).not.toThrow();
  });

  it("accepts a state-changing request from this origin (APP_ORIGIN may carry a path or trailing slash)", () => {
    expect(() => assertSameOrigin(req("POST", APP), APP)).not.toThrow();
    expect(() => assertSameOrigin(req("POST", APP), `${APP}/`)).not.toThrow();
    expect(() =>
      assertSameOrigin(req("POST", "http://localhost:3100"), "http://localhost:3100"),
    ).not.toThrow();
  });

  it.each([
    ["missing", undefined],
    ["null", "null"],
    ["other host", "https://evil.example"],
    ["other scheme", "http://concetto.example"],
    ["other port", "https://concetto.example:8443"],
    ["suffix trick", "https://concetto.example.evil.example"],
    ["empty", ""],
  ])("refuses a POST with a %s Origin as FORBIDDEN (403)", (_name, origin) => {
    try {
      assertSameOrigin(req("POST", origin), APP);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("FORBIDDEN");
      expect((e as ApiError).status).toBe(403);
    }
  });

  it("checks every non-safe method", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"])
      expect(() => assertSameOrigin(req(m), APP)).toThrow(ApiError);
  });
});

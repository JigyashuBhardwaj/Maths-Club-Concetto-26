import { describe, expect, it } from "vitest";

import { parseServerEnv } from "@/lib/env/schema";

describe("parseServerEnv", () => {
  it("applies safe defaults", () => {
    expect(parseServerEnv({})).toEqual({
      APP_ENV: "development",
      APP_ORIGIN: "http://localhost:3000",
    });
  });

  it("treats empty strings as unset", () => {
    expect(parseServerEnv({ APP_ENV: "", APP_ORIGIN: "" }).APP_ENV).toBe("development");
  });

  it("accepts valid values", () => {
    const env = parseServerEnv({ APP_ENV: "production", APP_ORIGIN: "https://portal.example.org" });
    expect(env).toEqual({ APP_ENV: "production", APP_ORIGIN: "https://portal.example.org" });
  });

  it("rejects bad values and names the variable but never leaks the value", () => {
    expect(() => parseServerEnv({ APP_ORIGIN: "not a url s3cret" })).toThrowError(/APP_ORIGIN/);
    try {
      parseServerEnv({ APP_ENV: "hunter2" });
    } catch (e) {
      expect(String(e)).toContain("APP_ENV");
      expect(String(e)).not.toContain("hunter2");
    }
  });
});

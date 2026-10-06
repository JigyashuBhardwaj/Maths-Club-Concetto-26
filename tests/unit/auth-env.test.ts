import { describe, expect, it } from "vitest";

import { parseAuthEnv } from "@/lib/env/auth";

const valid = {
  APP_ORIGIN: "https://concetto.example",
  NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789",
  SESSION_TOKEN_PEPPER: "p".repeat(32),
};

describe("parseAuthEnv", () => {
  it("accepts a complete configuration", () => {
    expect(parseAuthEnv(valid)).toEqual(valid);
  });

  it("names the missing or weak variables and never their values", () => {
    expect(() => parseAuthEnv({ ...valid, SESSION_TOKEN_PEPPER: "short-secret-value" })).toThrow(
      "Invalid authentication environment: SESSION_TOKEN_PEPPER",
    );
    expect(() =>
      parseAuthEnv({
        ...valid,
        SUPABASE_SERVICE_ROLE_KEY: undefined,
        NEXT_PUBLIC_SUPABASE_URL: "",
      }),
    ).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL/,
    );
    try {
      parseAuthEnv({ ...valid, SESSION_TOKEN_PEPPER: "short-secret-value" });
    } catch (e) {
      expect(String(e)).not.toContain("short-secret-value");
    }
  });

  it("is only required where used: the page-level server env stays valid without database credentials", async () => {
    const { parseServerEnv } = await import("@/lib/env/schema");
    expect(() => parseServerEnv({})).not.toThrow();
  });
});

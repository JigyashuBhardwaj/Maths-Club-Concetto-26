import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy, buildSecurityHeaders } from "@/config/security";

describe("content security policy", () => {
  const prod = buildContentSecurityPolicy({ isDev: false });
  const dev = buildContentSecurityPolicy({ isDev: true });

  it("is locked to same-origin by default and forbids framing and plugins", () => {
    expect(prod).toContain("default-src 'self'");
    expect(prod).toContain("frame-ancestors 'none'");
    expect(prod).toContain("object-src 'none'");
    expect(prod).toContain("base-uri 'self'");
    expect(prod).toContain("form-action 'self'");
  });

  it("allows eval and skips HTTPS upgrade only in development", () => {
    expect(dev).toContain("'unsafe-eval'");
    expect(prod).not.toContain("'unsafe-eval'");
    expect(prod).toContain("upgrade-insecure-requests");
    expect(dev).not.toContain("upgrade-insecure-requests");
  });

  it("does not allow third-party origins", () => {
    expect(prod).not.toMatch(/https?:\/\//);
  });
});

describe("security headers", () => {
  const map = new Map(buildSecurityHeaders({ isDev: false }).map((h) => [h.key, h.value]));

  it("includes the baseline set", () => {
    expect(map.get("X-Content-Type-Options")).toBe("nosniff");
    expect(map.get("X-Frame-Options")).toBe("DENY");
    expect(map.get("Referrer-Policy")).toBe("same-origin");
    expect(map.get("Strict-Transport-Security")).toMatch(/max-age=\d+/);
    expect(map.get("Content-Security-Policy")).toBeTruthy();
    expect(map.get("Permissions-Policy")).toContain("fullscreen=(self)");
  });
});

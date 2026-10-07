import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import { generateSessionToken } from "@/lib/auth/session";
import { config, proxy } from "@/proxy";

const request = (path: string, cookie?: string) =>
  new NextRequest(`https://concetto.example${path}`, {
    headers: cookie ? { cookie } : undefined,
  });

describe("proxy (first line of route protection)", () => {
  it("covers exactly the three protected trees", () => {
    expect(config.matcher).toEqual(["/participant/:path*", "/admin/:path*", "/superadmin/:path*"]);
  });

  it.each([
    ["/participant", "/login/participant"],
    ["/participant/theme/A/1", "/login/participant"],
    ["/admin", "/login/admin"],
    ["/admin/anything", "/login/admin"],
    ["/superadmin", "/login/superadmin"],
    ["/superadmin/anything?x=1", "/login/superadmin"],
  ])("redirects %s without a cookie to %s, uncached", (path, login) => {
    const res = proxy(request(path));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe(login);
    expect(location.search).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("treats a malformed or empty session cookie as no cookie", () => {
    for (const cookie of [
      `${SESSION_COOKIE_NAME}=`,
      `${SESSION_COOKIE_NAME}=short`,
      `${SESSION_COOKIE_NAME}=${"A".repeat(44)}`,
      `${SESSION_COOKIE_NAME}=${"!".repeat(43)}`,
      "other=" + generateSessionToken(),
    ]) {
      expect(proxy(request("/admin", cookie)).status, cookie).toBe(307);
    }
  });

  it("lets a well-formed cookie through (the page decides whether it is live) with no-store", () => {
    const res = proxy(request("/participant", `${SESSION_COOKIE_NAME}=${generateSessionToken()}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does nothing for public paths", () => {
    for (const path of ["/", "/login/admin", "/api/health"]) {
      const res = proxy(request(path));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBeNull();
    }
  });
});

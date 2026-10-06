import { describe, expect, it } from "vitest";

import {
  buildClearedSessionCookie,
  buildSessionCookie,
  readSessionToken,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/cookies";
import {
  SESSION_TTL_SECONDS,
  generateSessionToken,
  hashSessionToken,
  isWellFormedToken,
} from "@/lib/auth/session";

const PEPPER = "pepper-for-tests-0123456789abcdef0123";

describe("session tokens", () => {
  it("are 32 random bytes, base64url, 43 characters, and never repeat", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateSessionToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(t, "base64url")).toHaveLength(32);
      expect(isWellFormedToken(t)).toBe(true);
    }
  });

  it("recognise only well-formed tokens", () => {
    for (const bad of [
      "",
      "short",
      "a".repeat(42),
      "a".repeat(44),
      `${"a".repeat(42)}=`,
      `${"a".repeat(42)}!`,
      null,
      undefined,
      7,
    ]) {
      expect(isWellFormedToken(bad)).toBe(false);
    }
  });

  it("expire after 12 hours (SEC-05)", () => {
    expect(SESSION_TTL_SECONDS).toBe(43_200);
  });
});

describe("hashSessionToken", () => {
  const token = generateSessionToken();

  it("is HMAC-SHA256 as a bytea hex literal, deterministic, and never contains the token", () => {
    const h = hashSessionToken(token, PEPPER);
    expect(h).toMatch(/^\\x[0-9a-f]{64}$/);
    expect(hashSessionToken(token, PEPPER)).toBe(h);
    expect(h).not.toContain(token);
  });

  it("depends on both the token and the pepper", () => {
    const h = hashSessionToken(token, PEPPER);
    expect(hashSessionToken(generateSessionToken(), PEPPER)).not.toBe(h);
    expect(hashSessionToken(token, `${PEPPER}x`)).not.toBe(h);
  });

  it("matches a known HMAC-SHA256 vector", () => {
    // HMAC-SHA256(key="key", msg="The quick brown fox jumps over the lazy dog")
    expect(hashSessionToken("The quick brown fox jumps over the lazy dog", "key")).toBe(
      "\\xf7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });
});

describe("session cookie", () => {
  const token = generateSessionToken();

  it("is __Host-session with HttpOnly, Secure, SameSite=Lax, Path=/, a 12 h Max-Age and no Domain", () => {
    const c = buildSessionCookie(token);
    expect(SESSION_COOKIE_NAME).toBe("__Host-session");
    expect(c.startsWith(`__Host-session=${token};`)).toBe(true);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=43200"]) {
      expect(c.split("; ")).toContain(attr);
    }
    expect(c).not.toMatch(/Domain=/i);
  });

  it("is cleared with an immediate expiry and the same protective attributes", () => {
    const c = buildClearedSessionCookie();
    expect(c.startsWith("__Host-session=;")).toBe(true);
    expect(c).toContain("Max-Age=0");
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"])
      expect(c.split("; ")).toContain(attr);
  });

  it("is read from a Cookie header, ignoring other cookies and malformed values", () => {
    expect(readSessionToken(`a=1; __Host-session=${token}; b=2`)).toBe(token);
    expect(readSessionToken(`__Host-session=${token}`)).toBe(token);
    expect(readSessionToken(null)).toBeNull();
    expect(readSessionToken("")).toBeNull();
    expect(readSessionToken("a=1; b=2")).toBeNull();
    expect(readSessionToken("__Host-session=not-a-token")).toBeNull();
    expect(readSessionToken(`session=${token}`)).toBeNull();
    expect(readSessionToken(`x__Host-session=${token}`)).toBeNull();
  });
});

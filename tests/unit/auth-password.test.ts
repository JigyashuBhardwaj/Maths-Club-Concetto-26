import { describe, expect, it } from "vitest";

import {
  BCRYPT_COST,
  MAX_PASSWORD_BYTES,
  STAFF_PASSWORD_MIN_LENGTH,
  isPasswordWithinLimit,
  passwordByteLength,
  validateStaffPassword,
} from "@/lib/auth/password";
import {
  THROTTLE_FIRST_LOCK_SECONDS,
  THROTTLE_MAX_FAILURES,
  THROTTLE_MAX_LOCK_SECONDS,
  THROTTLE_WINDOW_SECONDS,
  lockSecondsForFailures,
} from "@/lib/auth/throttle";

describe("password rules", () => {
  it("document bcrypt cost 12 and its 72-byte limit", () => {
    expect(BCRYPT_COST).toBe(12);
    expect(MAX_PASSWORD_BYTES).toBe(72);
  });

  it("count bytes, not characters", () => {
    expect(passwordByteLength("abc")).toBe(3);
    expect(passwordByteLength("é")).toBe(2);
    expect(passwordByteLength("😀")).toBe(4);
    expect(isPasswordWithinLimit("a".repeat(72))).toBe(true);
    expect(isPasswordWithinLimit("a".repeat(73))).toBe(false);
    expect(isPasswordWithinLimit("é".repeat(36))).toBe(true);
    expect(isPasswordWithinLimit("é".repeat(37))).toBe(false);
    expect(isPasswordWithinLimit("")).toBe(false);
  });

  it("require at least 10 characters for a staff password and refuse more than 72 bytes", () => {
    expect(STAFF_PASSWORD_MIN_LENGTH).toBe(10);
    expect(validateStaffPassword("123456789")).toMatch(/at least 10/);
    expect(validateStaffPassword("1234567890")).toBeNull();
    expect(validateStaffPassword("a".repeat(72))).toBeNull();
    expect(validateStaffPassword("a".repeat(73))).toMatch(/72 bytes/);
  });
});

describe("throttle policy (mirrors the database)", () => {
  it("is 8 failures per 10 minutes, then 30 s doubling up to 300 s", () => {
    expect(THROTTLE_MAX_FAILURES).toBe(8);
    expect(THROTTLE_WINDOW_SECONDS).toBe(600);
    expect(THROTTLE_FIRST_LOCK_SECONDS).toBe(30);
    expect(THROTTLE_MAX_LOCK_SECONDS).toBe(300);
    expect([1, 7, 8, 9, 10, 11, 12, 40].map(lockSecondsForFailures)).toEqual([
      0, 0, 30, 60, 120, 240, 300, 300,
    ]);
  });
});

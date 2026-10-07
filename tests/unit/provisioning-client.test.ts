import { describe, expect, it } from "vitest";

import { ApiError, dbRaisedToApiError } from "@/lib/api/errors";
import {
  fieldMessage,
  newIdempotencyKey,
  outcomeUnknown,
  provisioningFailure,
} from "@/lib/provisioning/client";

const fail = (code: string, status = 400, details?: Record<string, unknown>) =>
  ({ ok: false, status, code, message: "SERVER TEXT", details }) as never;

describe("newIdempotencyKey", () => {
  it("is a v4 UUID and different each time", () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newIdempotencyKey()).not.toBe(a);
  });
});

describe("provisioningFailure", () => {
  it("maps VALIDATION_FAILED field names to fixed wording and ignores junk names", () => {
    const r = provisioningFailure(
      fail("VALIDATION_FAILED", 400, { fields: ["username", "admissionNos.2", 7, "x".repeat(80)] }),
      "team",
    );
    expect(Object.keys(r.fields).sort()).toEqual(["admissionNos.2", "username"]);
    expect(JSON.stringify(r)).not.toContain("SERVER TEXT");
  });

  it("falls back to a form message when no field is named", () => {
    expect(provisioningFailure(fail("VALIDATION_FAILED"), "admin").form).toMatch(
      /Check the details/,
    );
  });

  it.each([
    ["USERNAME_TAKEN", "username"],
    ["TEAM_CODE_TAKEN", "teamCode"],
    ["LOGIN_ID_TAKEN", "loginId"],
  ])("%s lands on the %s field", (code, field) => {
    expect(Object.keys(provisioningFailure(fail(code, 409), "team").fields)).toEqual([field]);
  });

  it("puts ADMISSION_NO_TAKEN on the right member slot, and on the form for a bad slot", () => {
    expect(
      Object.keys(provisioningFailure(fail("ADMISSION_NO_TAKEN", 409, { slot: 4 }), "team").fields),
    ).toEqual(["admissionNos.4"]);
    for (const slot of [0, 5, 2.5, "3", null]) {
      const r = provisioningFailure(fail("ADMISSION_NO_TAKEN", 409, { slot }), "team");
      expect(r.fields).toEqual({});
      expect(r.form).toBeTruthy();
    }
  });

  it("uses fixed wording for session, permission, network and unknown failures", () => {
    for (const code of [
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "IDEMPOTENCY_KEY_REUSED",
      "NETWORK_ERROR",
      "WHATEVER",
    ]) {
      const r = provisioningFailure(fail(code, 500), "admin");
      expect(r.form).toBeTruthy();
      expect(r.form).not.toContain("SERVER TEXT");
    }
  });
});

describe("fieldMessage", () => {
  it("differs by form for the password rule", () => {
    expect(fieldMessage("admin", "password")).toMatch(/10/);
    expect(fieldMessage("team", "password")).toMatch(/8/);
    expect(fieldMessage("team", "admissionNos.3")).toMatch(/M3/);
    expect(fieldMessage("team", "unheard-of")).toBe("Check this field.");
  });
});

describe("outcomeUnknown", () => {
  it("is true only for a lost/garbled/5xx response", () => {
    expect(outcomeUnknown(fail("NETWORK_ERROR", 0))).toBe(true);
    expect(outcomeUnknown(fail("INTERNAL", 503))).toBe(true);
    expect(outcomeUnknown(fail("BAD_RESPONSE", 200))).toBe(true);
    expect(outcomeUnknown(fail("USERNAME_TAKEN", 409))).toBe(false);
    expect(outcomeUnknown(fail("VALIDATION_FAILED", 400))).toBe(false);
  });
});

describe("dbRaisedToApiError for the provisioning codes", () => {
  it.each(["USERNAME_TAKEN", "TEAM_CODE_TAKEN", "LOGIN_ID_TAKEN", "ADMISSION_NO_TAKEN"])(
    "%s is a 409 with a fixed message",
    (code) => {
      const e = dbRaisedToApiError(code, undefined);
      expect(e).toBeInstanceOf(ApiError);
      expect(e).toMatchObject({ code, status: 409 });
    },
  );

  it("keeps the slot of ADMISSION_NO_TAKEN but drops details from the others", () => {
    expect(dbRaisedToApiError("ADMISSION_NO_TAKEN", { slot: 3 }).details).toEqual({ slot: 3 });
    expect(dbRaisedToApiError("USERNAME_TAKEN", { leak: "x" }).details).toBeUndefined();
  });
});

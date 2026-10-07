import { describe, expect, it } from "vitest";

import { dbRaisedToApiError } from "@/lib/api/errors";
import {
  idempotencyKeySchema,
  setCompetitionStatusSchema,
  statusResultSchema,
  teamStateSchema,
} from "@/lib/contracts/runtime";
import { DbError, toDbError } from "@/lib/db/adapter";

const ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const base = {
  server_now: 1_760_000_000_000,
  state_version: 3,
  competition: { status: "RUNNING" },
  me: { member_id: ID, slot: 1, team_id: ID, team_code: "T01", team_name: "Team" },
  team: {
    status: "RUNNING",
    coins: 500,
    started_at: 1,
    ends_at: 2,
    ended_at: null,
    final_submitted_at: null,
    duration_seconds: 7200,
    remaining_seconds: 100,
    expired: false,
  },
  themes: [],
};
const withTeam = (over: Record<string, unknown>) => ({ ...base, team: { ...base.team, ...over } });

/**
 * The timer formula as the database computes it (supabase/migrations/…_runtime_engine.sql, app.team_state_json):
 *   remaining = max(0, floor(ends_at − ref_time)), ref_time = least(now, ended_at, paused_at while PAUSED).
 * These vectors are the same boundary cases that supabase/tests/80_runtime.test.sql asserts against PostgreSQL; this
 * reference exists only so the parity is written down. No client or handler ever computes a remaining time.
 */
const refRemaining = (endsAtMs: number, refMs: number) =>
  Math.max(0, Math.floor((endsAtMs - refMs) / 1000));

describe("timer formula boundary vectors (parity with the database tests)", () => {
  const start = 1_796_127_000_000; // 2026-12-01 12:10:00 UTC
  const ends = start + 7_200_000;
  it.each([
    ["at the start", start, 7200],
    ["0.4 s in: 7199.6 floors to 7199", start + 400, 7199],
    ["1 s in", start + 1000, 7199],
    ["one hour in", start + 3_600_000, 3600],
    ["1 s left", ends - 1000, 1],
    ["0.5 s left floors to 0", ends - 500, 0],
    ["exactly at ends_at", ends, 0],
    ["hours after: clamped, never negative", ends + 6 * 3_600_000, 0],
  ])("%s", (_name, ref, expected) => {
    expect(refRemaining(ends, ref)).toBe(expected);
  });
  it("a paused competition freezes the reference at paused_at", () => {
    const pausedAt = start + 3_000_000;
    expect(refRemaining(ends, Math.min(start + 9_000_000, pausedAt))).toBe(4200);
  });
});

describe("team state contract", () => {
  it("accepts the boundary values 0 and the full duration", () => {
    expect(
      teamStateSchema.safeParse(withTeam({ remaining_seconds: 0, expired: true })).success,
    ).toBe(true);
    expect(teamStateSchema.safeParse(withTeam({ remaining_seconds: 7200 })).success).toBe(true);
  });
  it.each([
    ["more than the competition allows", { remaining_seconds: 7201 }],
    ["negative", { remaining_seconds: -1 }],
    ["fractional", { remaining_seconds: 10.5 }],
    ["a string", { remaining_seconds: "100" }],
    ["fractional epoch ms", { started_at: 1.5 }],
    ["an unknown team status", { status: "PAUSED" }],
    ["negative coins", { coins: -1 }],
  ])("rejects remaining/time/status that is %s", (_n, over) => {
    expect(teamStateSchema.safeParse(withTeam(over)).success).toBe(false);
  });
  it("strips every key it does not list (a hash can never be forwarded)", () => {
    const parsed = teamStateSchema.parse({
      ...base,
      password_hash: "x",
      team: { ...base.team, token_hash: "y" },
      me: { ...base.me, admission_no: "23JE0001" },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/hash|admission/);
  });
  it("carries a deadline only where the database sends one", () => {
    const s = teamStateSchema.parse({
      ...base,
      themes: [
        {
          id: 1,
          code: "A",
          status: "IN_PROGRESS",
          questions: [
            { id: 1, ordinal: 1, state: "ACTIVE", deadline: 5 },
            { id: 2, ordinal: 2, state: "LOCKED" },
          ],
        },
      ],
    });
    expect(s.themes[0]?.questions[1]).not.toHaveProperty("deadline");
  });
});

describe("request contracts", () => {
  it("competition status body is strict and needs an explicit confirmation", () => {
    expect(setCompetitionStatusSchema.safeParse({ action: "end", confirm: true }).success).toBe(
      true,
    );
    for (const bad of [
      { action: "end" },
      { action: "end", confirm: false },
      { action: "stop", confirm: true },
      { action: "end", confirm: true, x: 1 },
    ]) {
      expect(setCompetitionStatusSchema.safeParse(bad).success).toBe(false);
    }
  });
  it("Idempotency-Key must be a UUID", () => {
    expect(idempotencyKeySchema.safeParse("5d6f1c1a-3b8e-4f0a-9c21-7e4d2a9b8c10").success).toBe(
      true,
    );
    expect(idempotencyKeySchema.safeParse("5D6F1C1A-3B8E-4F0A-9C21-7E4D2A9B8C10").success).toBe(
      true,
    );
    for (const bad of [
      "",
      "abc",
      "5d6f1c1a3b8e4f0a9c217e4d2a9b8c10",
      "5d6f1c1a-3b8e-4f0a-9c21-7e4d2a9b8c1",
      "5d6f1c1a-3b8e-4f0a-9c21-7e4d2a9b8c10; drop table",
    ]) {
      expect(idempotencyKeySchema.safeParse(bad).success).toBe(false);
    }
  });
  it("status results keep the competition snapshot and drop unknown keys", () => {
    const r = statusResultSchema.parse({
      replayed: false,
      changed: false,
      action: "pause",
      from: "PAUSED",
      to: "PAUSED",
      competition: {
        status: "PAUSED",
        opened_at: 1,
        paused_at: 2,
        ended_at: null,
        state_version: 4,
      },
      secret: "x",
    });
    expect(r).not.toHaveProperty("secret");
    expect(r.competition.state_version).toBe(4);
  });
});

describe("database error mapping", () => {
  it("toDbError trusts only P0001 + a code-shaped message", () => {
    expect(
      toDbError("get_team_state", { code: "P0001", message: "COMPETITION_PAUSED" }).appCode,
    ).toBe("COMPETITION_PAUSED");
    for (const e of [
      { code: "P0001", message: "invalid input syntax for type uuid" },
      { code: "23505", message: "TEAM_ENDED" },
      { code: "42501", message: "permission denied for function secret_fn" },
      { code: "P0001", message: "lowercase_code" },
      { code: undefined, message: "COMPETITION_PAUSED" },
    ]) {
      const err = toDbError("get_team_state", e);
      expect(err).toBeInstanceOf(DbError);
      expect(err.appCode).toBeUndefined();
      expect(err.message).not.toMatch(/permission denied|invalid input|secret_fn/);
    }
  });
  it("parses the JSON DETAIL of an application error and ignores anything else", () => {
    const ok = toDbError("set_competition_status", {
      code: "P0001",
      message: "COMPETITION_NOT_READY",
      details: '{"teams":0,"themes":10}',
    });
    expect(ok.details).toEqual({ teams: 0, themes: 10 });
    for (const details of [
      "not json",
      "[1,2]",
      "{broken",
      null,
      undefined,
      "Key (id)=(1) already exists.",
    ]) {
      expect(
        toDbError("set_competition_status", { code: "P0001", message: "NOT_FOUND", details })
          .details,
      ).toBeUndefined();
    }
  });
  it("dbRaisedToApiError maps known codes and turns everything else into a generic 503", () => {
    expect(dbRaisedToApiError("COMPETITION_PAUSED", undefined)).toMatchObject({
      code: "COMPETITION_PAUSED",
      status: 423,
    });
    expect(dbRaisedToApiError("TEAM_ENDED", undefined)).toMatchObject({ status: 409 });
    expect(dbRaisedToApiError("NOT_FOUND", undefined)).toMatchObject({ status: 404 });
    for (const code of [
      undefined,
      "NOPE",
      "UNAUTHENTICATED",
      "RATE_LIMITED",
      "SERVICE_UNAVAILABLE",
    ]) {
      expect(dbRaisedToApiError(code, undefined)).toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        status: 503,
      });
    }
  });
  it("only a few codes carry details, and only flat primitives", () => {
    const e = dbRaisedToApiError("INVALID_COMPETITION_TRANSITION", {
      from: "ENDED",
      action: "open",
      nested: { a: 1 },
      fn: () => 1,
    });
    expect(e.details).toEqual({ from: "ENDED", action: "open" });
    expect(dbRaisedToApiError("TEAM_ENDED", { secret: "x" }).details).toBeUndefined();
    expect(dbRaisedToApiError("FORBIDDEN", { team: "other" }).details).toBeUndefined();
    expect(
      dbRaisedToApiError("VALIDATION_FAILED", { fields: ["Idempotency-Key"] }).details,
    ).toEqual({ fields: ["Idempotency-Key"] });
  });
});

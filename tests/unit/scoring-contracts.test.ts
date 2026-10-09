import { describe, expect, it } from "vitest";

import {
  boardRowSchema,
  participantBoardSchema,
  penalizeResultSchema,
  penalizeSchema,
  staffBoardSchema,
} from "@/lib/contracts/scoring";

describe("board schemas", () => {
  it("accepts negative scores and strips unknown keys", () => {
    expect(boardRowSchema.parse({ rank: 3, team_id: "T5", score: -800, coins: 1 })).toEqual({
      rank: 3,
      team_id: "T5",
      score: -800,
    });
  });
  it("rejects a rank below 1 and a fractional score", () => {
    expect(boardRowSchema.safeParse({ rank: 0, team_id: "T1", score: 1 }).success).toBe(false);
    expect(boardRowSchema.safeParse({ rank: 1, team_id: "T1", score: 1.5 }).success).toBe(false);
  });
  it("the participant board has a nullable own line; the staff board has none", () => {
    expect(participantBoardSchema.parse({ server_now: 1, rows: [], me: null }).me).toBeNull();
    expect(
      participantBoardSchema.safeParse({ server_now: 1, rows: [] }).success,
      "me is required (null when the team is unknown)",
    ).toBe(false);
    expect(staffBoardSchema.parse({ rows: [], me: { rank: 1, team_id: "x", score: 1 } })).toEqual({
      rows: [],
    });
  });
});

describe("penalty schemas", () => {
  it("the request is exactly { confirm: true }", () => {
    expect(penalizeSchema.safeParse({ confirm: true }).success).toBe(true);
    for (const bad of [{}, { confirm: false }, { confirm: 1 }, { confirm: true, extra: 1 }]) {
      expect(penalizeSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("the result always reports an official score of 0", () => {
    const base = {
      replayed: false,
      changed: true,
      team: {
        id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        team_code: "T1",
        status: "ENDED",
        official_score: 0,
        penalized_at: 5,
      },
    };
    expect(penalizeResultSchema.safeParse(base).success).toBe(true);
    expect(
      penalizeResultSchema.safeParse({ ...base, team: { ...base.team, official_score: 1 } })
        .success,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  canPlay,
  clockOffset,
  clocksRunning,
  currentOrdinal,
  effectiveState,
  findTheme,
  isNewer,
  questionRemainingMs,
  serverTime,
  teamFrozen,
  teamRemainingSeconds,
} from "@/lib/gameplay/derive";
import type { TeamState } from "@/lib/contracts/runtime";

const NOW = 1_760_000_000_000;
const state = (
  over: {
    competition?: "RUNNING" | "PAUSED" | "ENDED" | "SETUP";
    team?: Partial<TeamState["team"]>;
    version?: number;
    serverNow?: number;
  } = {},
): TeamState => ({
  server_now: over.serverNow ?? NOW,
  state_version: over.version ?? 1,
  competition: { status: over.competition ?? "RUNNING" },
  me: {
    member_id: "9b2c1f4e-5d1a-4c3b-8e7f-0a1b2c3d4e5f",
    slot: 1,
    team_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    team_code: "T1",
    team_name: "T",
  },
  team: {
    status: "RUNNING",
    coins: 400,
    started_at: NOW - 60_000,
    ends_at: NOW + 14_340_000,
    ended_at: null,
    final_submitted_at: null,
    duration_seconds: 14_400,
    remaining_seconds: 14_340,
    expired: false,
    frozen: false,
    ...over.team,
  },
  themes: [
    {
      id: 1,
      code: "A",
      name: "A",
      description: "d",
      topics: [],
      difficulty: "EASY",
      unlock_cost: 100,
      status: "IN_PROGRESS",
      questions: [
        { id: 1, ordinal: 1, state: "APPROVED" },
        { id: 2, ordinal: 2, state: "ACTIVE", deadline: NOW + 100_000, remaining_seconds: 100 },
        { id: 3, ordinal: 3, state: "LOCKED" },
      ],
    },
  ],
});

describe("clock alignment", () => {
  it("the offset maps the browser clock onto the server clock", () => {
    const offset = clockOffset(NOW + 5000, NOW);
    expect(offset).toBe(5000);
    expect(serverTime(NOW + 1000, offset)).toBe(NOW + 6000);
  });
});

describe("team timer", () => {
  it("counts down to the server's deadline while clocks run", () => {
    const s = state();
    expect(teamRemainingSeconds(s, NOW)).toBe(14340);
    expect(teamRemainingSeconds(s, NOW + 10_500)).toBe(14329);
    expect(teamRemainingSeconds(s, NOW + 14_340_000)).toBe(0);
    expect(teamRemainingSeconds(s, NOW + 19_999_000)).toBe(0);
  });
  it("never exceeds the competition duration, even with a clock running ahead of the server", () => {
    expect(teamRemainingSeconds(state(), NOW - 99_999_000)).toBe(14400);
  });
  it("is frozen at the server's value while the competition is paused or the team has not started", () => {
    const paused = state({ competition: "PAUSED", team: { remaining_seconds: 3600 } });
    expect(clocksRunning(paused)).toBe(false);
    expect(teamRemainingSeconds(paused, NOW + 600_000)).toBe(3600);
    const notStarted = state({
      team: { status: "NOT_STARTED", ends_at: null, started_at: null, remaining_seconds: 14400 },
    });
    expect(teamRemainingSeconds(notStarted, NOW + 600_000)).toBe(14400);
  });
});

describe("question timer and effective state", () => {
  const q = (s: TeamState, i: number) => s.themes[0]!.questions[i]!;
  it("an ACTIVE question counts down to its own deadline; the team timer does not move it", () => {
    const s = state();
    expect(questionRemainingMs(q(s, 1), s, NOW)).toBe(100_000);
    expect(questionRemainingMs(q(s, 1), s, NOW + 40_000)).toBe(60_000);
    expect(questionRemainingMs(q(s, 1), s, NOW + 500_000)).toBe(0);
  });
  it("a pending question shows the frozen time whatever the clock says", () => {
    const s = state();
    const pending = {
      id: 2,
      ordinal: 2,
      state: "PENDING_APPROVAL" as const,
      remaining_seconds: 77,
    };
    expect(questionRemainingMs(pending, s, NOW)).toBe(77_000);
    expect(questionRemainingMs(pending, s, NOW + 9_000_000)).toBe(77_000);
  });
  it("a paused competition freezes an ACTIVE question at the server's remaining seconds", () => {
    const s = state({ competition: "PAUSED" });
    expect(questionRemainingMs(q(s, 1), s, NOW + 50_000)).toBe(100_000);
  });
  it("an ACTIVE question past its deadline is shown TIMED_OUT only while clocks run", () => {
    const s = state();
    expect(effectiveState(q(s, 1), s, NOW + 99_999)).toBe("ACTIVE");
    expect(effectiveState(q(s, 1), s, NOW + 100_000)).toBe("TIMED_OUT");
    const paused = state({ competition: "PAUSED" });
    expect(effectiveState(q(paused, 1), paused, NOW + 500_000)).toBe("ACTIVE");
    expect(effectiveState(q(s, 0), s, NOW + 500_000)).toBe("APPROVED");
    expect(effectiveState(q(s, 2), s, NOW + 500_000)).toBe("LOCKED");
  });
});

describe("navigation and snapshot ordering", () => {
  it("the current question is the first one not yet approved", () => {
    const s = state();
    expect(currentOrdinal(s.themes[0]!)).toBe(2);
    expect(findTheme(s, "A")?.id).toBe(1);
    expect(findTheme(s, "Z")).toBeUndefined();
    const done = {
      ...s.themes[0]!,
      questions: s.themes[0]!.questions.map((x) => ({ ...x, state: "APPROVED" as const })),
    };
    expect(currentOrdinal(done)).toBe(3);
  });
  it("the database clock decides which snapshot is newer; equal clocks fall back to the version", () => {
    const a = state({ serverNow: NOW, version: 3 });
    expect(isNewer(a, null)).toBe(true);
    expect(isNewer(state({ serverNow: NOW + 1, version: 1 }), a)).toBe(true);
    expect(isNewer(state({ serverNow: NOW - 1, version: 9 }), a)).toBe(false);
    expect(isNewer(state({ serverNow: NOW, version: 3 }), a)).toBe(true);
    expect(isNewer(state({ serverNow: NOW, version: 2 }), a)).toBe(false);
  });
});

describe("frozen team (time up or final submission)", () => {
  const q = (s: TeamState, i: number) => s.themes[0]!.questions[i]!;
  const TEAM_END = NOW + 14_340_000;

  it("is not frozen while the timer runs, a pause is not a freeze, and the zero boundary freezes", () => {
    const s = state();
    expect(teamFrozen(s, NOW)).toBe(false);
    expect(teamFrozen(s, TEAM_END - 1)).toBe(false);
    expect(teamFrozen(s, TEAM_END)).toBe(true); // the instant ends_at is reached, before the next snapshot arrives
    const paused = state({ competition: "PAUSED" });
    expect(teamFrozen(paused, TEAM_END + 1_000_000)).toBe(false);
    expect(canPlay(paused, NOW)).toBe(false); // but nothing can be done while paused
  });

  it("every terminal status and the server's own flag freeze the team", () => {
    for (const status of ["FINAL_SUBMITTED", "ENDED", "DISQUALIFIED"] as const) {
      const s = state({ team: { status, frozen: true } });
      expect(teamFrozen(s, NOW)).toBe(true);
      expect(clocksRunning(s)).toBe(false);
      expect(canPlay(s, NOW)).toBe(false);
    }
    // an expired RUNNING team that the database has not stored as ENDED yet
    const expired = state({ team: { expired: true, frozen: true, remaining_seconds: 0 } });
    expect(clocksRunning(expired)).toBe(false);
    expect(teamRemainingSeconds(expired, NOW + 60_000)).toBe(0);
    expect(canPlay(state(), NOW)).toBe(true);
  });

  it("a frozen team's timers stand still: the server's remaining value, whatever the browser clock says", () => {
    const frozen = state({
      team: { status: "FINAL_SUBMITTED", frozen: true, remaining_seconds: 9000 },
    });
    expect(teamRemainingSeconds(frozen, NOW)).toBe(9000);
    expect(teamRemainingSeconds(frozen, NOW + 5_000_000)).toBe(9000);
    expect(questionRemainingMs(q(frozen, 1), frozen, NOW + 5_000_000)).toBe(100_000);
  });

  it("bought time can push a question deadline past the team's end, but the countdown never shows more than the team has", () => {
    // question deadline 20 minutes after the team's end (e.g. 3 purchases late in the game)
    const s = state();
    const long = { ...q(s, 1), deadline: TEAM_END + 1_200_000, remaining_seconds: 14_940 };
    expect(questionRemainingMs(long, s, TEAM_END - 60_000)).toBe(60_000);
    expect(questionRemainingMs(long, s, TEAM_END)).toBe(0);
    // far from the end the question's own deadline is not the binding one
    const short = { ...q(s, 1), deadline: NOW + 100_000 };
    expect(questionRemainingMs(short, s, NOW)).toBe(100_000);
  });
});

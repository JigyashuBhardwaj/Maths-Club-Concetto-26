import { describe, expect, it } from "vitest";

import {
  QUESTIONS_PER_THEME,
  THEME_COUNT,
  THEME_IDS,
  TOTAL_QUESTIONS,
  TOTAL_TICKETS,
  TEAM_TIMER_MINUTES,
  TEAM_TIMER_SECONDS,
  INITIAL_COINS,
  UFM_RESET_FLOOR_SCORE,
  UFM_DISQUALIFY_SCORE,
  UFM_RESET_SCORE,
  type QuestionState,
  type SubmissionState,
  type TeamStatus,
} from "@/lib/contracts/competition";

// `Record<Union, true>` fails to compile if a name is missing or an unknown one is added,
// so these tables keep the contracts and docs/DATA_MODEL.md on the same canonical terminology.
const questionStates: Record<QuestionState, true> = {
  LOCKED: true,
  AVAILABLE: true,
  ACTIVE: true,
  PENDING_APPROVAL: true,
  APPROVED: true,
  TIMED_OUT: true,
};
const submissionStates: Record<SubmissionState, true> = {
  PENDING: true,
  APPROVED: true,
  REJECTED: true,
};
const teamStatuses: Record<TeamStatus, true> = {
  NOT_STARTED: true,
  RUNNING: true,
  FINAL_SUBMITTED: true,
  ENDED: true,
  DISQUALIFIED: true,
};

describe("competition contracts (types only)", () => {
  it("uses the canonical state names", () => {
    expect(Object.keys(questionStates)).toEqual([
      "LOCKED",
      "AVAILABLE",
      "ACTIVE",
      "PENDING_APPROVAL",
      "APPROVED",
      "TIMED_OUT",
    ]);
    expect(Object.keys(submissionStates)).toEqual(["PENDING", "APPROVED", "REJECTED"]);
    expect(Object.keys(teamStatuses)).toEqual([
      "NOT_STARTED",
      "RUNNING",
      "FINAL_SUBMITTED",
      "ENDED",
      "DISQUALIFIED",
    ]);
  });

  it("keeps the locked numeric constants", () => {
    expect(TEAM_TIMER_SECONDS).toBe(14_400);
    expect(TEAM_TIMER_MINUTES).toBe(240);
    expect(INITIAL_COINS).toBe(500);
    expect(UFM_RESET_SCORE).toBe(0);
    expect(UFM_RESET_FLOOR_SCORE).toBe(-1200);
    expect(UFM_DISQUALIFY_SCORE).toBe(UFM_RESET_FLOOR_SCORE - 1);
    expect(UFM_DISQUALIFY_SCORE).toBe(-1201);
  });
});

describe("competition shape (locked: 10 themes x 5 questions + Final Submit)", () => {
  it("has themes A-J only", () => {
    expect([...THEME_IDS]).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
    expect(THEME_IDS as readonly string[]).not.toContain("K");
    expect(THEME_IDS as readonly string[]).not.toContain("L");
  });
  it("derives 50 questions and 11 tickets", () => {
    expect(THEME_COUNT).toBe(10);
    expect(QUESTIONS_PER_THEME).toBe(5);
    expect(TOTAL_QUESTIONS).toBe(50);
    expect(TOTAL_TICKETS).toBe(11);
  });
});

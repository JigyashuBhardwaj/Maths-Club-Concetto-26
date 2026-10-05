import { describe, expect, it } from "vitest";

import {
  TEAM_TIMER_SECONDS,
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
    expect(UFM_RESET_SCORE).toBe(0);
    expect(UFM_DISQUALIFY_SCORE).toBe(-1201);
  });
});

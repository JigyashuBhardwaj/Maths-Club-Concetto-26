import type { ReactNode } from "react";
import { vi } from "vitest";

import { GameProvider } from "@/components/game/game-provider";
import type { BuyTime, Hint, Question } from "@/lib/contracts/gameplay";
import type { TeamState } from "@/lib/contracts/runtime";

/** Shared fixtures for the participant component tests: a team snapshot builder and a mocked gameplay client. */
export const NOW = 1_760_000_000_000;

export type QState = TeamState["themes"][number]["questions"][number]["state"];

const CODES = "ABCDEFGHIJ";

const TERMINAL = ["FINAL_SUBMITTED", "ENDED", "DISQUALIFIED"];

function teamOf(serverNow: number, over: Partial<TeamState["team"]> = {}): TeamState["team"] {
  const team = {
    status: "RUNNING" as TeamState["team"]["status"],
    coins: 400,
    started_at: serverNow - 60_000,
    ends_at: serverNow + 14_340_000,
    ended_at: null,
    final_submitted_at: null,
    duration_seconds: 14_400,
    remaining_seconds: 14_340,
    expired: false,
    ...over,
  };
  // the server's flag: terminal, or the timer reached zero
  return { ...team, frozen: over.frozen ?? (TERMINAL.includes(team.status) || team.expired) };
}

export function snapshot(
  opts: {
    team?: Partial<TeamState["team"]>;
    competition?: "SETUP" | "RUNNING" | "PAUSED" | "ENDED";
    /** per theme code: its status and the states of its 5 questions */
    themes?: Record<string, { status?: TeamState["themes"][number]["status"]; q?: QState[] }>;
    serverNow?: number;
    version?: number;
  } = {},
): TeamState {
  const serverNow = opts.serverNow ?? NOW;
  return {
    server_now: serverNow,
    state_version: opts.version ?? 1,
    competition: { status: opts.competition ?? "RUNNING" },
    me: {
      member_id: "9b2c1f4e-5d1a-4c3b-8e7f-0a1b2c3d4e5f",
      slot: 1,
      team_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      team_code: "T17",
      team_name: "Team Seventeen",
    },
    team: teamOf(serverNow, opts.team),
    themes: [...CODES].map((code, i) => {
      const t = opts.themes?.[code];
      const states = t?.q ?? [];
      return {
        id: i + 1,
        code,
        name: `Name of ${code}`,
        description: `Server description of theme ${code}.`,
        topics: ["algebra"],
        difficulty: "EASY" as const,
        unlock_cost: 100,
        status: t ? (t.status ?? "IN_PROGRESS") : ("LOCKED" as const),
        questions: states.map((state, k) => ({
          id: i * 5 + k + 1,
          ordinal: k + 1,
          state,
          ...(state === "LOCKED" ? {} : { reward_coins: 50, time_limit_seconds: 240 }),
          ...(state === "ACTIVE"
            ? { deadline: serverNow + 200_000, remaining_seconds: 200 }
            : state === "PENDING_APPROVAL"
              ? { remaining_seconds: 120 }
              : {}),
        })),
      };
    }),
  };
}

export function question(over: Partial<Question> = {}): Question {
  return {
    id: 1,
    theme_id: 1,
    theme_code: "A",
    ordinal: 1,
    state: "ACTIVE",
    reward_coins: 50,
    time_limit_seconds: 240,
    body_md: "Find the value of x.",
    deadline: NOW + 200_000,
    remaining_seconds: 200,
    draft: { answer: "", explanation: "", version: 0, updated_by_slot: null, updated_at: null },
    hints: [hint(1), hint(2)],
    buy_time: buyTime(),
    ...over,
  };
}

/** A hint as the server sends it: price always, text only when owned. Prices are the fixtures' own, not the app's. */
export function hint(tier: 1 | 2, over: Partial<Hint> = {}): Hint {
  return { tier, cost: tier === 1 ? 20 : 40, owned: false, purchasable: tier === 1, ...over };
}

/** A Buy Time state with three packs; the numbers are a test fixture (the app reads them from the server). */
export function buyTime(over: Partial<BuyTime> = {}): BuyTime {
  const pack = (id: number, seconds: number, cost: number): BuyTime["options"][number] => ({
    id,
    seconds,
    cost,
    max_purchases: null,
    purchased: 0,
    remaining_purchases: null,
  });
  return {
    purchase_count: 0,
    extra_seconds: 0,
    can_buy: true,
    options: [pack(1, 120, 20), pack(2, 240, 40), pack(3, 480, 80)],
    ...over,
  };
}

/** The mocked client: `vi.mock("@/lib/gameplay/client", () => clientMock)` in the test file (hoisted by the caller). */
export function makeClient() {
  const ok = <T,>(data: T) => ({ ok: true as const, data, serverNow: NOW, stateVersion: 1 });
  return {
    ok,
    fail: (code: string, status = 409, details?: Record<string, unknown>) => ({
      ok: false as const,
      status,
      code,
      details,
    }),
    fetchTeamState: vi.fn(),
    enterCompetition: vi.fn(),
    unlockThemeCall: vi.fn(),
    fetchQuestion: vi.fn(),
    enterQuestionCall: vi.fn(),
    saveDraftCall: vi.fn(),
    submitAnswerCall: vi.fn(),
    // B14 presence heartbeat: fire-and-forget, its answer is ignored
    sendHeartbeat: vi.fn(async () => ({
      ok: true as const,
      data: {},
      serverNow: NOW,
      stateVersion: null,
    })),
  };
}

/** The mocked economy client (`vi.mock("@/lib/economy/client", () => economyMock)`). */
export function makeEconomy() {
  return {
    buyHintCall: vi.fn(),
    buyTimeCall: vi.fn(),
    finalSubmitCall: vi.fn(),
  };
}

export function Game({ initial, children }: { initial: TeamState | null; children: ReactNode }) {
  return <GameProvider initial={initial}>{children}</GameProvider>;
}

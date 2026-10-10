import { describe, expect, it } from "vitest";

import { formatDuration } from "@/lib/home/format";
import {
  compareEntries,
  MAX_TEAMS,
  rankEntries,
  withPlaceholderRows,
} from "@/lib/home/leaderboard";
import {
  depth,
  frontIndex,
  normalizeAngle,
  rotationToFront,
  STEP_DEG,
  TICKET_COUNT,
  ticketAngle,
} from "@/lib/home/spiral";
import { FINAL_TICKET, THEMES, TICKETS } from "@/lib/home/themes";
import content from "../../content/concetto26/official-content.json";

describe("formatDuration", () => {
  it("formats HH:MM:SS", () => {
    expect(formatDuration(3 * 3600 + 46 * 60 + 54)).toBe("03:46:54");
    expect(formatDuration(14_400)).toBe("04:00:00");
    expect(formatDuration(0)).toBe("00:00:00");
  });
  it("clamps and floors", () => {
    expect(formatDuration(-5)).toBe("00:00:00");
    expect(formatDuration(59.9)).toBe("00:00:59");
  });
});

describe("leaderboard ordering (DEC-11)", () => {
  it("sorts by score desc, then fewer minutes, then team code", () => {
    const rows = rankEntries([
      { teamId: "B", score: 10, minutesTaken: 50 },
      { teamId: "A", score: 10, minutesTaken: 50 },
      { teamId: "C", score: 10, minutesTaken: 40 },
      { teamId: "D", score: 90, minutesTaken: 200 },
    ]);
    expect(rows.map((r) => r.teamId)).toEqual(["D", "C", "A", "B"]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });
  it("compares team codes by code point, not locale", () => {
    expect(
      compareEntries(
        { teamId: "Z", score: 1, minutesTaken: 1 },
        { teamId: "a", score: 1, minutesTaken: 1 },
      ),
    ).toBeLessThan(0);
  });
  it("pads to 100 placeholder rows", () => {
    const rows = withPlaceholderRows([]);
    expect(rows).toHaveLength(MAX_TEAMS);
    expect(rows[0]).toEqual({ rank: 1, teamId: null, score: null });
    expect(rows[99]!.rank).toBe(100);
  });
  it("keeps real rows first when padding", () => {
    const rows = withPlaceholderRows(rankEntries([{ teamId: "T1", score: 5, minutesTaken: 1 }]));
    expect(rows[0]!.teamId).toBe("T1");
    expect(rows[1]!.teamId).toBeNull();
  });
});

describe("spiral geometry", () => {
  it("normalises angles", () => {
    expect(normalizeAngle(190)).toBeCloseTo(-170);
    expect(normalizeAngle(-190)).toBeCloseTo(170);
    expect(normalizeAngle(360)).toBeCloseTo(0);
  });
  it("puts ticket 0 at the front at rotation 0", () => {
    expect(ticketAngle(0, 0)).toBe(0);
    expect(frontIndex(0)).toBe(0);
    expect(depth(0)).toBe(1);
    expect(depth(180)).toBeCloseTo(0);
  });
  it("rotationToFront brings any ticket to the front by the shortest way", () => {
    for (let i = 0; i < 11; i++) {
      const r = rotationToFront(i, 123);
      expect(frontIndex(r)).toBe(i);
      expect(Math.abs(r - 123)).toBeLessThanOrEqual(180 + 1e-9);
      expect(Math.abs(ticketAngle(i, r))).toBeLessThan(1e-6);
    }
    expect(STEP_DEG).toBeCloseTo(360 / 11);
  });
});

describe("tickets", () => {
  it("has exactly 10 themes A-J plus the final ticket (11 tickets), and no K or L", () => {
    expect(THEMES).toHaveLength(10);
    // B17: the ticket label is the official theme name; the theme id (A-J) stays the key
    expect(THEMES.map((t) => t.id)).toEqual("ABCDEFGHIJ".split(""));
    expect(THEMES.map((t) => t.label)).toEqual(content.themes.map((t) => t.name));
    expect(THEMES.map((t) => t.description)).toEqual(content.themes.map((t) => t.description));
    expect(THEMES.some((t) => /^THEME [A-Z]$/.test(t.label))).toBe(false);
    expect(TICKETS).toHaveLength(11);
    expect(TICKETS[10]).toBe(FINAL_TICKET);
    expect(TICKETS.filter((t) => t.kind === "final")).toHaveLength(1);
    expect(TICKET_COUNT).toBe(11);
    expect(FINAL_TICKET.label).toBe("FINAL SUBMIT");
  });
});

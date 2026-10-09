// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StaffLeaderboard } from "@/components/provisioning/staff-leaderboard";

const rows = [
  { rank: 1, team_id: "T2", score: 700 },
  { rank: 2, team_id: "T1", score: 0 },
];
const board = (r: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify({ ok: true, data: { rows: r }, server_now: 1 }), { status: 200 }),
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5); // centred jitter: exact intervals on the fake clock
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("<StaffLeaderboard />", () => {
  it("shows rank 1..N with Team_ID and Score, and no 'your team' row", () => {
    const fetchMock = vi.fn();
    render(
      <StaffLeaderboard initialRows={rows} fetchImpl={fetchMock as unknown as typeof fetch} />,
    );
    expect(screen.getByRole("heading", { name: "Live Leaderboard" })).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(table).toHaveTextContent("Rank");
    expect(table).toHaveTextContent("Team_ID");
    expect(table).toHaveTextContent("Score");
    const body = screen.getAllByRole("row").slice(1);
    expect(body.map((r) => r.textContent)).toEqual(["#1T2700", "#2T10"]);
    expect(screen.queryByLabelText("Your team")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled(); // the server-rendered first paint is used as is
  });

  it("with no rendered rows it fetches at once and then refreshes every interval, keeping the last rows on failure", async () => {
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(board(rows))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockReturnValue(board([{ rank: 1, team_id: "T9", score: 5 }]));
    render(
      <StaffLeaderboard
        initialRows={null}
        intervalMs={1000}
        fetchImpl={fetchMock as unknown as typeof fetch}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("T2")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Showing the last results");
    expect(screen.getByText("T2")).toBeInTheDocument(); // still the last good rows
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000); // after a failure the next wait doubles
    });
    expect(screen.getByText("T9")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/leaderboard");
  });

  it("says so when there are no teams", () => {
    render(<StaffLeaderboard initialRows={[]} />);
    expect(screen.getByText("No teams yet.")).toBeInTheDocument();
  });

  it("ignores a malformed response", async () => {
    const fetchMock = vi.fn().mockReturnValue(board([{ rank: 1, team_id: "T1", score: "lots" }]));
    render(
      <StaffLeaderboard
        initialRows={rows}
        intervalMs={1000}
        fetchImpl={fetchMock as unknown as typeof fetch}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText("T2")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EntryGate } from "@/components/game/entry-gate";
import { HomeHeader } from "@/components/home/home-header";
import { Leaderboard } from "@/components/home/leaderboard";
import { RulesButton } from "@/components/home/rules-dialog";
import { TicketSpiral } from "@/components/home/ticket-spiral";

import { Game, makeClient, makeEconomy, NOW, snapshot } from "./support/game";

const client = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock("@/lib/gameplay/client", () => client);
const economy = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock("@/lib/economy/client", () => economy);
const c = makeClient();
const eco = makeEconomy();
const ME = { rank: 12, teamId: "TEAM123", score: 60 };

beforeEach(() => {
  Object.assign(client, {
    fetchTeamState: c.fetchTeamState,
    sendHeartbeat: c.sendHeartbeat,
    enterCompetition: c.enterCompetition,
    unlockThemeCall: c.unlockThemeCall,
  });
  Object.assign(economy, eco);
  for (const f of [c.fetchTeamState, c.enterCompetition, c.unlockThemeCall, eco.finalSubmitCall])
    f.mockReset();
  // a poll answers with whatever the test's server currently says
  c.fetchTeamState.mockImplementation(async () => c.ok(current));
  vi.stubGlobal(
    "matchMedia",
    (q: string) =>
      ({
        matches: q.includes("reduce"),
        addEventListener() {},
        removeEventListener() {},
        media: q,
      }) as unknown as MediaQueryList,
  );
});
afterEach(() => vi.unstubAllGlobals());

let current = snapshot();
const withGame = (ui: React.ReactNode, initial = snapshot()) => {
  current = initial;
  return render(<Game initial={initial}>{ui}</Game>);
};

describe("Leaderboard", () => {
  // jitter is centred (random = 0.5 -> factor 1) so the fake clock sees exact intervals; the jitter itself is tested in board-poller.test.ts
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("shows the viewing team line and 100 empty ranked rows", async () => {
    render(<Leaderboard me={ME} />);
    expect(screen.getByRole("heading", { name: "Live Leaderboard" })).toBeInTheDocument();
    expect(screen.getByLabelText("Your rank")).toHaveTextContent("#12");
    expect(screen.getByLabelText("Your team ID")).toHaveTextContent("TEAM123");
    expect(screen.getByLabelText("Your score")).toHaveTextContent("60");
    expect(screen.getAllByRole("row")).toHaveLength(101);
    expect(screen.getByText("#100")).toBeInTheDocument();
  });

  const line = (rank: number, teamId: string, score: number) => ({ rank, teamId, score });

  it("fills rows from the source, shows them in the SERVER's order, and refreshes every interval", async () => {
    vi.useFakeTimers();
    const source = vi
      .fn()
      .mockResolvedValueOnce({ rows: [line(1, "AAA", 5)], me: null })
      .mockResolvedValue({
        // the server ranked BBB first; the browser must not re-sort (here BBB has the LOWER score on purpose)
        rows: [line(1, "BBB", 2), line(2, "AAA", 9)],
        me: line(2, "AAA", 9),
      });
    render(<Leaderboard me={ME} source={source} intervalMs={15_000} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(source).toHaveBeenCalledTimes(1);
    expect(screen.getByText("AAA")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(source).toHaveBeenCalledTimes(2);
    const cells = screen.getAllByRole("cell").map((c) => c.textContent);
    expect(cells.indexOf("BBB")).toBeLessThan(cells.indexOf("AAA"));
    expect(cells.slice(0, 6)).toEqual(["#1", "BBB", "2", "#2", "AAA", "9"]);
    vi.useRealTimers();
  });

  it("the own line comes from the same snapshot (rank, Team ID, score - a negative score included) and replaces the fallback", async () => {
    const source = vi.fn().mockResolvedValue({
      rows: [line(1, "T02", 1375), line(2, "TEAM123", -45)],
      me: line(2, "TEAM123", -45),
    });
    render(<Leaderboard me={{ rank: null, teamId: "TEAM123", score: null }} source={source} />);
    await waitFor(() => expect(screen.getByLabelText("Your rank")).toHaveTextContent("#2"));
    expect(screen.getByLabelText("Your team ID")).toHaveTextContent("TEAM123");
    expect(screen.getByLabelText("Your score")).toHaveTextContent("-45");
    // the same team is also highlighted inside the table
    const mine = document.querySelector("tr.lb-mine");
    expect(mine).not.toBeNull();
    expect(mine!.textContent).toBe("#2TEAM123-45");
  });

  it("keeps the last good rows when a refresh fails", async () => {
    vi.useFakeTimers();
    const source = vi
      .fn()
      .mockResolvedValueOnce({ rows: [line(1, "AAA", 5)], me: line(1, "AAA", 5) })
      .mockRejectedValue(new Error("down"));
    render(<Leaderboard me={ME} source={source} intervalMs={1000} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(within(screen.getByRole("table")).getByText("AAA")).toBeInTheDocument();
    expect(screen.getByLabelText("Your score")).toHaveTextContent("5");
    vi.useRealTimers();
  });

  it("a change of the team's own state version refreshes the board at once (throttled), without waiting for the interval", async () => {
    vi.useFakeTimers();
    const source = vi.fn().mockResolvedValue({ rows: [line(1, "AAA", 5)], me: null });
    const { rerender } = render(
      <Leaderboard me={ME} source={source} intervalMs={60_000} refreshKey={1} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(source).toHaveBeenCalledTimes(1);
    rerender(<Leaderboard me={ME} source={source} intervalMs={60_000} refreshKey={2} />);
    rerender(<Leaderboard me={ME} source={source} intervalMs={60_000} refreshKey={3} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(source).toHaveBeenCalledTimes(2); // two quick changes -> ONE extra read
    rerender(<Leaderboard me={ME} source={source} intervalMs={60_000} refreshKey={3} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(source).toHaveBeenCalledTimes(2); // an unchanged key asks for nothing
    vi.useRealTimers();
  });
});

describe("Rules dialog", () => {
  it("opens from the button and closes with Close", async () => {
    render(<RulesButton />);
    const dialog = document.querySelector("dialog")!;
    expect(dialog).not.toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: /rules and regulations/i }));
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByRole("heading", { name: "Rules and Regulations" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
  });
});

describe("Leaderboard own line without a participant snapshot", () => {
  it("shows the real Team ID and a dash for rank and score", () => {
    render(<Leaderboard me={{ rank: null, teamId: "T17", score: null }} />);
    expect(screen.getByLabelText("Your rank")).toHaveTextContent("—");
    expect(screen.getByLabelText("Your team ID")).toHaveTextContent("T17");
    expect(screen.getByLabelText("Your score")).toHaveTextContent("—");
  });
});

describe("HomeHeader", () => {
  it("shows the server's team timer (counting down to the deadline) and the server's coin balance", async () => {
    vi.useFakeTimers({
      now: NOW,
      toFake: ["Date", "setInterval", "setTimeout", "clearInterval", "clearTimeout"],
    });
    try {
      withGame(<HomeHeader />, snapshot({ team: { coins: 446 } }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // ends_at = server_now + 14 340 000 ms → 03:59:00 on the first read
      expect(screen.getByText("03:59:00")).toBeInTheDocument();
      expect(screen.getByText("446")).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.getByText(/^03:58:5[6-8]$/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
  it("a paused competition freezes the timer at the server's value", async () => {
    vi.useFakeTimers({
      now: NOW,
      toFake: ["Date", "setInterval", "setTimeout", "clearInterval", "clearTimeout"],
    });
    try {
      withGame(
        <HomeHeader />,
        snapshot({ competition: "PAUSED", team: { remaining_seconds: 3600 } }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("01:00:00")).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(screen.getByText("01:00:00")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("EntryGate", () => {
  it("is shown for a team that has not entered; the button calls the server once (idempotent key) and the gate closes", async () => {
    const entered = snapshot({ version: 2 });
    withGame(
      <EntryGate />,
      snapshot({
        team: { status: "NOT_STARTED", started_at: null, ends_at: null, remaining_seconds: 14400 },
      }),
    );
    const gate = document.querySelector("dialog.entry-gate")!;
    await waitFor(() => expect(gate).toHaveAttribute("open"));
    expect(screen.getByRole("heading", { name: "Enter the competition" })).toBeInTheDocument();
    // the length of the competition is the server's number, not a constant in the screen
    expect(gate).toHaveTextContent("Your team has 4 hours in total");
    c.enterCompetition.mockResolvedValue(c.ok(entered));
    const button = screen.getByRole("button", { name: "Enter competition" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(document.querySelector("dialog.entry-gate")).toBeNull());
    expect(c.enterCompetition).toHaveBeenCalledTimes(1);
    expect(c.enterCompetition.mock.calls[0]![0]).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("is absent once the team has started", () => {
    withGame(<EntryGate />, snapshot());
    expect(document.querySelector("dialog.entry-gate")).toBeNull();
  });
  it("cannot be used while the competition is paused", async () => {
    withGame(
      <EntryGate />,
      snapshot({
        competition: "PAUSED",
        team: { status: "NOT_STARTED", started_at: null, ends_at: null },
      }),
    );
    expect(await screen.findByText(/competition is paused/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enter competition" })).toBeDisabled();
  });
  it("a lost connection keeps the same key for the retry; a refusal shows fixed wording", async () => {
    withGame(
      <EntryGate />,
      snapshot({ team: { status: "NOT_STARTED", started_at: null, ends_at: null } }),
    );
    c.enterCompetition.mockResolvedValueOnce(c.fail("NETWORK_ERROR", 0));
    fireEvent.click(await screen.findByRole("button", { name: "Enter competition" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Can't reach the server/);
    c.enterCompetition.mockResolvedValueOnce(c.fail("COMPETITION_PAUSED", 423));
    fireEvent.click(screen.getByRole("button", { name: "Enter competition" }));
    await waitFor(() => expect(c.enterCompetition).toHaveBeenCalledTimes(2));
    expect(c.enterCompetition.mock.calls[1]![0]).toBe(c.enterCompetition.mock.calls[0]![0]);
  });
});

describe("TicketSpiral", () => {
  it("renders exactly 10 themes (A-J) and the final ticket last; no K or L", () => {
    withGame(<TicketSpiral />);
    const labels = screen
      .getAllByRole("button", { name: /^(THEME|FINAL)/ })
      .map((b) => b.querySelector(".ticket-label")?.textContent);
    expect(labels).toHaveLength(11);
    expect(labels.filter((l) => l?.startsWith("THEME"))).toHaveLength(10);
    expect(labels).toEqual([..."ABCDEFGHIJ"].map((c) => `THEME ${c}`).concat("FINAL SUBMIT"));
    expect(labels.at(-1)).toBe("FINAL SUBMIT");
    expect(screen.getByRole("button", { name: /THEME J/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /THEME K/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /THEME L/ })).toBeNull();
  });

  it("a ticket glows only for a theme the TEAM has unlocked, per the server snapshot", () => {
    withGame(
      <TicketSpiral />,
      snapshot({ themes: { B: { q: ["AVAILABLE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"] } } }),
    );
    expect(screen.getByRole("button", { name: /THEME B/ })).toHaveClass("is-unlocked");
    expect(screen.getByRole("button", { name: /THEME A/ })).not.toHaveClass("is-unlocked");
  });

  it("theme dialog shows the server's text and price; Unlock asks the server once and then offers Let's solve", async () => {
    withGame(<TicketSpiral />);
    fireEvent.click(screen.getByRole("button", { name: /THEME C/ }));
    const theme = screen.getByRole("dialog", { name: "THEME C" });
    expect(theme).toHaveAttribute("open");
    expect(screen.getByText("Server description of theme C.")).toBeInTheDocument();
    const after = snapshot({
      version: 2,
      team: { coins: 300 },
      themes: { C: { q: ["AVAILABLE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"] } },
    });
    c.unlockThemeCall.mockResolvedValue(c.ok(after));
    const unlock = screen.getByRole("button", { name: "Unlock with 100 coins" });
    fireEvent.click(unlock);
    fireEvent.click(unlock);
    expect(await screen.findByRole("link", { name: "Let's solve" })).toHaveAttribute(
      "href",
      "/participant/theme/C/1",
    );
    expect(c.unlockThemeCall).toHaveBeenCalledTimes(1);
    expect(c.unlockThemeCall.mock.calls[0]![0]).toBe(3);
    expect(c.unlockThemeCall.mock.calls[0]![1]).toMatch(/^[0-9a-f-]{36}$/);
    fireEvent.click(screen.getByRole("button", { name: "Explore other themes" }));
    await waitFor(() => expect(theme).not.toHaveAttribute("open"));
  });

  it("a theme a teammate already unlocked goes straight to the current question", () => {
    withGame(
      <TicketSpiral />,
      snapshot({
        themes: { D: { q: ["APPROVED", "APPROVED", "ACTIVE", "LOCKED", "LOCKED"] } },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /THEME D/ }));
    expect(screen.getByRole("link", { name: "Let's solve" })).toHaveAttribute(
      "href",
      "/participant/theme/D/3",
    );
    expect(screen.queryByRole("button", { name: /^Unlock/ })).toBeNull();
  });

  it("not enough coins: Unlock is disabled and says why; a server refusal shows fixed wording", async () => {
    withGame(<TicketSpiral />, snapshot({ team: { coins: 40 } }));
    fireEvent.click(screen.getByRole("button", { name: /THEME E/ }));
    expect(screen.getByRole("button", { name: "Unlock with 100 coins" })).toBeDisabled();
    expect(screen.getByText(/costs 100 coins and your team has 40/)).toBeInTheDocument();
  });

  it("INSUFFICIENT_COINS from the server (the balance moved) shows a message and no unlock", async () => {
    withGame(<TicketSpiral />);
    fireEvent.click(screen.getByRole("button", { name: /THEME F/ }));
    c.unlockThemeCall.mockResolvedValue(c.fail("INSUFFICIENT_COINS", 409, { have: 20, need: 100 }));
    fireEvent.click(screen.getByRole("button", { name: "Unlock with 100 coins" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have enough coins");
    expect(screen.queryByRole("link", { name: "Let's solve" })).toBeNull();
  });

  it("a teammate-visible entry gate for a 2-hour team reads 2 hours: the text follows the data", async () => {
    withGame(
      <EntryGate />,
      snapshot({
        team: {
          status: "NOT_STARTED",
          started_at: null,
          ends_at: null,
          duration_seconds: 7200,
          remaining_seconds: 7200,
        },
      }),
    );
    expect(await screen.findByText(/Your team has 2 hours in total/)).toBeInTheDocument();
  });

  it("final dialog: Go back closes without calling the server", async () => {
    withGame(<TicketSpiral />);
    fireEvent.click(screen.getByRole("button", { name: /FINAL SUBMIT/ }));
    const finalDialog = screen.getByRole("dialog", { name: "Final Submit" });
    expect(finalDialog).toHaveAttribute("open");
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    await waitFor(() => expect(finalDialog).not.toHaveAttribute("open"));
    expect(eco.finalSubmitCall).not.toHaveBeenCalled();
  });
});

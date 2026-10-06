// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Leaderboard } from "@/components/home/leaderboard";
import { RulesButton } from "@/components/home/rules-dialog";
import { TicketSpiral } from "@/components/home/ticket-spiral";
import { MOCK_TEAM } from "@/lib/home/mock";
import { __resetDemoStoreForTests } from "@/lib/question/store";

beforeEach(() => {
  __resetDemoStoreForTests();
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

describe("Leaderboard", () => {
  it("shows the viewing team line and 100 empty ranked rows", async () => {
    render(<Leaderboard me={MOCK_TEAM} />);
    expect(screen.getByRole("heading", { name: "Live Leaderboard" })).toBeInTheDocument();
    expect(screen.getByLabelText("Your rank")).toHaveTextContent("#12");
    expect(screen.getByLabelText("Your team ID")).toHaveTextContent("TEAM123");
    expect(screen.getByLabelText("Your score")).toHaveTextContent("60");
    expect(screen.getAllByRole("row")).toHaveLength(101);
    expect(screen.getByText("#100")).toBeInTheDocument();
  });

  it("fills rows from the source and refreshes every interval", async () => {
    vi.useFakeTimers();
    const source = vi
      .fn()
      .mockResolvedValueOnce([{ teamId: "AAA", score: 5, minutesTaken: 1 }])
      .mockResolvedValue([
        { teamId: "AAA", score: 5, minutesTaken: 1 },
        { teamId: "BBB", score: 9, minutesTaken: 1 },
      ]);
    render(<Leaderboard me={MOCK_TEAM} source={source} intervalMs={60_000} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(source).toHaveBeenCalledTimes(1);
    expect(screen.getByText("AAA")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(source).toHaveBeenCalledTimes(2);
    const cells = screen.getAllByRole("cell").map((c) => c.textContent);
    expect(cells.indexOf("BBB")).toBeLessThan(cells.indexOf("AAA"));
    vi.useRealTimers();
  });

  it("keeps the last good rows when a refresh fails", async () => {
    vi.useFakeTimers();
    const source = vi
      .fn()
      .mockResolvedValueOnce([{ teamId: "AAA", score: 5, minutesTaken: 1 }])
      .mockRejectedValue(new Error("down"));
    render(<Leaderboard me={MOCK_TEAM} source={source} intervalMs={1000} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByText("AAA")).toBeInTheDocument();
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

describe("TicketSpiral", () => {
  it("renders exactly 10 themes (A-J) and the final ticket last; no K or L", () => {
    render(<TicketSpiral />);
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

  it("theme dialog: unlock flips to Let's solve (visual only), explore closes", async () => {
    render(<TicketSpiral />);
    fireEvent.click(screen.getByRole("button", { name: /THEME C/ }));
    const theme = screen.getByRole("dialog", { name: "THEME C" });
    expect(theme).toHaveAttribute("open");
    expect(screen.getByRole("heading", { name: "THEME C" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unlock with xyz coins" }));
    expect(screen.getByRole("link", { name: "Let's solve" })).toHaveAttribute(
      "href",
      "/participant/theme/C/1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Explore other themes" }));
    await waitFor(() => expect(theme).not.toHaveAttribute("open"));
    // the unlocked state is remembered locally for that theme
    fireEvent.click(screen.getByRole("button", { name: /THEME C/ }));
    expect(screen.getByRole("link", { name: "Let's solve" })).toBeInTheDocument();
  });

  it("final dialog: Yes, submit and Go back both just close", async () => {
    render(<TicketSpiral />);
    fireEvent.click(screen.getByRole("button", { name: /FINAL SUBMIT/ }));
    const finalDialog = screen.getByRole("dialog", { name: "Final Submit" });
    expect(finalDialog).toHaveAttribute("open");
    expect(screen.getByRole("heading", { name: "Final Submit" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    await waitFor(() => expect(finalDialog).not.toHaveAttribute("open"));
    fireEvent.click(screen.getByRole("button", { name: /FINAL SUBMIT/ }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, submit" }));
    await waitFor(() => expect(finalDialog).not.toHaveAttribute("open"));
  });
});

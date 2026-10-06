// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { QuestionPage } from "@/components/question/question-page";
import { approve, disapprove, unlockTheme } from "@/lib/question/engine";
import { __resetDemoStoreForTests, dispatch } from "@/lib/question/store";

// The WebGL background is not what is under test (and jsdom has no WebGL).
vi.mock("@/components/home/home-stage", () => ({
  HomeStage: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

beforeEach(() => {
  __resetDemoStoreForTests();
});

const unlock = (theme: "A" | "B" = "A") => act(() => dispatch((s) => unlockTheme(s, theme)));

async function openQ1() {
  unlock();
  render(<QuestionPage theme="A" n={1} />);
  await screen.findByText("Q1.");
}

describe("question page", () => {
  it("shows the theme heading, the five stats, the question and both hints", async () => {
    await openQ1();
    expect(screen.getByRole("heading", { level: 1, name: "THEME A" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Ultimate timer" })).toHaveTextContent(/03:4\d:\d\d/);
    expect(screen.getByRole("group", { name: "Question timer" })).toHaveTextContent(/0[34]:\d\d/);
    expect(screen.getByRole("button", { name: "buy time" })).toBeEnabled();
    expect(screen.getByRole("group", { name: "Coins left" })).toHaveTextContent("446");
    expect(screen.getByRole("group", { name: /Reward/ })).toHaveTextContent("50 coins++");
    expect(screen.getByText("Q1.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Hint 1/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Hint 2/ })).toBeDisabled();
  });

  it("starts the Q1 timer on entering (no Start button)", async () => {
    await openQ1();
    expect(screen.queryByRole("button", { name: /start/i })).toBeNull();
    expect(screen.getByRole("group", { name: "Question timer" })).not.toHaveTextContent("04:00:00");
  });

  it("previous and next arrows are disabled on an unapproved Q1; home arrow links home", async () => {
    await openQ1();
    expect(screen.getByRole("button", { name: "Previous question" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Next question/ })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute(
      "href",
      "/participant",
    );
  });

  it("clear all empties the answer; submit needs text", async () => {
    await openQ1();
    const box = screen.getByRole("textbox");
    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit).toBeDisabled();
    fireEvent.change(box, { target: { value: "42 because ..." } });
    expect(submit).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(box).toHaveValue("");
    expect(submit).toBeDisabled();
  });

  it("submit → pending (grey, locked) → approve → approved (green) and Next opens with the reward", async () => {
    await openQ1();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    const pending = await screen.findByRole("button", { name: "Pending for approval" });
    expect(pending).toBeDisabled();
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "buy time" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Next question/ })).toBeDisabled();

    act(() => dispatch((s, t) => approve(s, "A", 1, t)));
    expect(await screen.findByRole("button", { name: "Approved" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Next question" })).toHaveAttribute(
      "href",
      "/participant/theme/A/2",
    );
    expect(screen.getByRole("group", { name: "Coins left" })).toHaveTextContent("496");
  });

  it("disapprove returns the red Submit button and keeps the answer text", async () => {
    await openQ1();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await screen.findByRole("button", { name: "Pending for approval" });
    act(() => dispatch((s, t) => disapprove(s, "A", 1, t)));
    expect(await screen.findByRole("button", { name: "Submit" })).toBeEnabled();
    expect(screen.getByRole("textbox")).toHaveValue("wrong");
    expect(screen.getByRole("textbox")).not.toHaveAttribute("readonly");
  });

  it("hint 1: asks, 'No' closes without paying; 'Yes' pays 40 and opens the hint; reopening goes straight to the hint", async () => {
    await openQ1();
    fireEvent.click(screen.getByRole("button", { name: /^Hint 1/ }));
    const ask = screen.getByRole("dialog", { name: "Hint 1" });
    expect(ask).toHaveTextContent("Do you want to purchase this hint for 40 coins?");
    fireEvent.click(within(ask).getByRole("button", { name: "No" }));
    await waitFor(() => expect(ask).not.toHaveAttribute("open"));
    expect(screen.getByRole("group", { name: "Coins left" })).toHaveTextContent("446");

    fireEvent.click(screen.getByRole("button", { name: /^Hint 1/ }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Hint 1" })).getByRole("button", { name: "Yes" }),
    );
    const view = await screen.findByRole("dialog", { name: "Hint 1" });
    expect(view).toHaveTextContent(/Lorem ipsum/);
    expect(screen.getByRole("group", { name: "Coins left" })).toHaveTextContent("406");
    fireEvent.click(within(view).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /^Hint 1/ }));
    expect(screen.getByRole("dialog", { name: "Hint 1" })).toHaveTextContent(/Lorem ipsum/);
    expect(screen.getByRole("group", { name: "Coins left" })).toHaveTextContent("406");
    // Tier 2 is now purchasable for 80.
    expect(screen.getByRole("button", { name: /^Hint 2/ })).toHaveTextContent("buy with 80 coins");
  });

  it("buy time: pick a pack, confirm with Yes → coins deducted; No closes without buying", async () => {
    await openQ1();
    fireEvent.click(screen.getByRole("button", { name: "buy time" }));
    let dlg = screen.getByRole("dialog", { name: "Buy time" });
    expect(within(dlg).getAllByRole("button", { name: /mins/ })).toHaveLength(3);
    fireEvent.click(within(dlg).getByRole("button", { name: /4 mins/ }));
    expect(dlg).toHaveTextContent("Are you sure?");
    fireEvent.click(within(dlg).getByRole("button", { name: "No" }));
    await waitFor(() => expect(dlg).not.toHaveAttribute("open"));
    expect(screen.getByRole("group", { name: "Coins left" })).toHaveTextContent("446");

    fireEvent.click(screen.getByRole("button", { name: "buy time" }));
    dlg = screen.getByRole("dialog", { name: "Buy time" });
    fireEvent.click(within(dlg).getByRole("button", { name: /4 mins/ }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Yes" }));
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Coins left" })).toHaveTextContent("406"),
    );
    expect(screen.getByRole("group", { name: "Question timer" })).toHaveTextContent(/0[89]:\d\d/);
  });

  it("a locked theme or a locked question shows a notice, not the question", () => {
    render(<QuestionPage theme="B" n={1} />);
    expect(screen.getByText(/theme is locked/i)).toBeInTheDocument();
    expect(screen.queryByText(/Lorem ipsum/)).toBeNull();
  });

  it("Q2 is locked until Q1 is approved", async () => {
    unlock();
    render(<QuestionPage theme="A" n={2} />);
    expect(
      await screen.findByText(/locked until the previous one is approved/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

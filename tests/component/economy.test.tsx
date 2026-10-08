// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TicketSpiral } from "@/components/home/ticket-spiral";
import { QuestionPage } from "@/components/question/question-page";

import {
  buyTime,
  Game,
  hint,
  makeClient,
  makeEconomy,
  NOW,
  question,
  snapshot,
  type QState,
} from "./support/game";

// Hints, Buy Time and Final Submit (Patch B15). The numbers in these tests (prices, seconds, caps) are the TEST'S OWN
// data: they deliberately differ from the seed (20/40, 120/240/480 s) to show that the screens render what the server
// sends and contain no price of their own.

vi.mock("@/components/home/home-stage", () => ({
  HomeStage: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
const client = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock("@/lib/gameplay/client", () => client);
const economy = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock("@/lib/economy/client", () => economy);
const c = makeClient();
const eco = makeEconomy();

let current = snapshot();
const states = (team: Parameters<typeof snapshot>[0] = {}, ...q: QState[]) =>
  snapshot({
    ...team,
    themes: { A: { q: q.length ? q : ["ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"] } },
  });

function mount(initial = states(), n = 1) {
  current = initial;
  return render(
    <Game initial={initial}>
      <QuestionPage theme="A" n={n} />
    </Game>,
  );
}

beforeEach(() => {
  Object.assign(client, {
    fetchTeamState: c.fetchTeamState,
    sendHeartbeat: c.sendHeartbeat,
    fetchQuestion: c.fetchQuestion,
    enterQuestionCall: c.enterQuestionCall,
    saveDraftCall: c.saveDraftCall,
    submitAnswerCall: c.submitAnswerCall,
  });
  Object.assign(economy, eco);
  for (const f of [
    c.fetchTeamState,
    c.fetchQuestion,
    c.enterQuestionCall,
    c.saveDraftCall,
    c.submitAnswerCall,
    eco.buyHintCall,
    eco.buyTimeCall,
    eco.finalSubmitCall,
  ])
    f.mockReset();
  c.fetchTeamState.mockImplementation(async () => c.ok(current));
  c.saveDraftCall.mockResolvedValue(c.ok({ version: 1, updated_by_slot: 1, updated_at: NOW }));
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
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const UUID = /^[0-9a-f-]{36}$/;
const PACKS = [
  { id: 7, seconds: 90, cost: 7, max_purchases: null, purchased: 0, remaining_purchases: null },
  { id: 8, seconds: 600, cost: 30, max_purchases: 2, purchased: 0, remaining_purchases: 2 },
];

describe("hints", () => {
  const HINTS = [hint(1, { cost: 25 }), hint(2, { cost: 55, purchasable: false })];

  it("shows each price from the data; Hint 2 is gated until Hint 1 is owned", async () => {
    c.fetchQuestion.mockResolvedValue(c.ok(question({ hints: HINTS })));
    mount();
    await screen.findByText("Find the value of x.");
    expect(screen.getByRole("button", { name: /^Hint 1/ })).toHaveTextContent("25 coins");
    expect(screen.getByRole("button", { name: /^Hint 1/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Hint 2/ })).toHaveTextContent("after Hint 1");
    expect(screen.getByRole("button", { name: /^Hint 2/ })).toBeDisabled();
  });

  it("buying: the dialog states the price, Yes sends ONE request (one key), the text opens and the balance updates", async () => {
    const opened = question({
      hints: [
        hint(1, { cost: 25, owned: true, purchasable: false, body_md: "Try small cases." }),
        hint(2, { cost: 55, purchasable: true }),
      ],
    });
    c.fetchQuestion.mockResolvedValue(c.ok(question({ hints: HINTS })));
    eco.buyHintCall.mockResolvedValue(
      c.ok({
        already_owned: false,
        tier: 1,
        hint: { tier: 1, body_md: "Try small cases." },
        question: opened,
        state: states({ version: 2, team: { coins: 375 } }),
      }),
    );
    mount();
    await screen.findByText("Find the value of x.");
    fireEvent.click(screen.getByRole("button", { name: /^Hint 1/ }));
    expect(screen.getByText(/purchase this hint for 25 coins/)).toBeInTheDocument();
    const yes = screen.getAllByRole("button", { name: "Yes" })[0]!;
    fireEvent.click(yes);
    fireEvent.click(yes);
    expect(await screen.findByText("Try small cases.")).toBeInTheDocument();
    expect(eco.buyHintCall).toHaveBeenCalledTimes(1);
    expect(eco.buyHintCall.mock.calls[0]![0]).toBe(1); // question id
    expect(eco.buyHintCall.mock.calls[0]![1]).toBe(1); // tier
    expect(eco.buyHintCall.mock.calls[0]![2]).toMatch(UUID);
    expect(screen.getByRole("group", { name: "Coins left" })).toHaveTextContent("375");
    // the same hint, once owned, is read without paying again; Hint 2 is now purchasable
    expect(screen.getByRole("button", { name: /^Hint 1/ })).toHaveTextContent("unlocked");
    expect(screen.getByRole("button", { name: /^Hint 2/ })).toBeEnabled();
  });

  it("not enough coins: the dialog says so and Yes is disabled, nothing is sent", async () => {
    c.fetchQuestion.mockResolvedValue(c.ok(question({ hints: HINTS })));
    mount(states({ team: { coins: 10 } }));
    await screen.findByText("Find the value of x.");
    fireEvent.click(screen.getByRole("button", { name: /^Hint 1/ }));
    expect(screen.getByText("Not enough coins.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Yes" })[0]).toBeDisabled();
    expect(eco.buyHintCall).not.toHaveBeenCalled();
  });

  it("a refusal shows fixed wording and ends the intent (the next attempt has a new key); a lost connection keeps the key", async () => {
    c.fetchQuestion.mockResolvedValue(c.ok(question({ hints: HINTS })));
    mount();
    await screen.findByText("Find the value of x.");
    fireEvent.click(screen.getByRole("button", { name: /^Hint 1/ }));
    const yes = () => screen.getAllByRole("button", { name: "Yes" })[0]!;

    eco.buyHintCall.mockResolvedValueOnce(c.fail("NETWORK_ERROR", 0));
    fireEvent.click(yes());
    expect(await screen.findByRole("alert")).toHaveTextContent("Can't reach the server");
    eco.buyHintCall.mockResolvedValueOnce(c.fail("INSUFFICIENT_COINS", 409, { have: 5, need: 25 }));
    fireEvent.click(yes());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("enough coins"));
    eco.buyHintCall.mockResolvedValueOnce(c.fail("INSUFFICIENT_COINS", 409));
    fireEvent.click(yes());
    await waitFor(() => expect(eco.buyHintCall).toHaveBeenCalledTimes(3));

    const keys = eco.buyHintCall.mock.calls.map((k) => k[2]);
    expect(keys[1]).toBe(keys[0]); // network error: same intent, same key
    expect(keys[2]).not.toBe(keys[1]); // definitive refusal: a fresh intent
  });

  it("an owned hint can still be read when the team is frozen, but nothing can be bought", async () => {
    c.fetchQuestion.mockResolvedValue(
      c.ok(
        question({
          hints: [
            hint(1, { cost: 25, owned: true, purchasable: false, body_md: "Owned text." }),
            hint(2, { cost: 55, purchasable: false }),
          ],
        }),
      ),
    );
    mount(
      states({ team: { status: "FINAL_SUBMITTED", frozen: true, final_submitted_at: NOW - 1000 } }),
    );
    await screen.findByText("Find the value of x.");
    expect(screen.getByRole("button", { name: /^Hint 1/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /^Hint 1/ }));
    expect(await screen.findByText("Owned text.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Hint 2/ })).toBeDisabled();
  });
});

describe("Buy Time", () => {
  const withPacks = (over: Partial<ReturnType<typeof buyTime>> = {}) =>
    question({ buy_time: buyTime({ options: PACKS, ...over }) });

  it("lists the packs exactly as the server sent them (seconds and price are the data's)", async () => {
    c.fetchQuestion.mockResolvedValue(c.ok(withPacks()));
    mount();
    await screen.findByText("Find the value of x.");
    fireEvent.click(screen.getByRole("button", { name: "buy time" }));
    const list = screen.getByRole("list", { name: "Time packs" });
    const [first, second] = within(list).getAllByRole("button");
    expect(first).toHaveTextContent("90 secs");
    expect(first).toHaveTextContent("7 coins");
    expect(second).toHaveTextContent("10 mins");
    expect(second).toHaveTextContent("30 coins");
  });

  it("buying: pick, confirm, ONE request with the option id and the purchase count the screen showed", async () => {
    c.fetchQuestion.mockResolvedValue(c.ok(withPacks({ purchase_count: 3 })));
    const after = question({
      buy_time: buyTime({ options: PACKS, purchase_count: 4, extra_seconds: 90 }),
      deadline: NOW + 290_000,
    });
    eco.buyTimeCall.mockResolvedValue(
      c.ok({
        purchase: { seq: 4, option_id: 7, seconds: 90, cost: 7 },
        question: after,
        state: states({ version: 2, team: { coins: 393 } }),
      }),
    );
    mount();
    await screen.findByText("Find the value of x.");
    fireEvent.click(screen.getByRole("button", { name: "buy time" }));
    fireEvent.click(
      within(screen.getByRole("list", { name: "Time packs" })).getAllByRole("button")[0]!,
    );
    expect(
      screen.getByText(/Add 90 secs to this question for 7 coins\? Are you sure\?/),
    ).toBeInTheDocument();
    const yes = screen.getByRole("button", { name: "Yes" });
    fireEvent.click(yes);
    fireEvent.click(yes);
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Coins left" })).toHaveTextContent("393"),
    );
    expect(eco.buyTimeCall).toHaveBeenCalledTimes(1);
    expect(eco.buyTimeCall.mock.calls[0]!.slice(0, 3)).toEqual([1, 7, 3]);
    expect(eco.buyTimeCall.mock.calls[0]![3]).toMatch(UUID);
    // the dialog closed
    await waitFor(() => expect(screen.queryByRole("list", { name: "Time packs" })).toBeNull());
  });

  it("a teammate bought first: the refusal is explained and the member picks again from fresh data", async () => {
    c.fetchQuestion.mockResolvedValue(c.ok(withPacks()));
    eco.buyTimeCall.mockResolvedValue(c.fail("STALE_PURCHASE_COUNT", 409, { count: 1 }));
    mount();
    await screen.findByText("Find the value of x.");
    fireEvent.click(screen.getByRole("button", { name: "buy time" }));
    fireEvent.click(
      within(screen.getByRole("list", { name: "Time packs" })).getAllByRole("button")[0]!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A teammate just bought time");
    // back on the list: nothing was bought on the stale view
    expect(screen.getByRole("list", { name: "Time packs" })).toBeInTheDocument();
    expect(c.fetchQuestion.mock.calls.length).toBeGreaterThan(1); // the question was read again
  });

  it("a pack the team cannot afford, or has used up, is disabled", async () => {
    c.fetchQuestion.mockResolvedValue(
      c.ok(
        withPacks({
          options: [
            { ...PACKS[0]!, cost: 500 },
            { ...PACKS[1]!, purchased: 2, remaining_purchases: 0 },
          ],
        }),
      ),
    );
    mount();
    await screen.findByText("Find the value of x.");
    fireEvent.click(screen.getByRole("button", { name: "buy time" }));
    for (const b of within(screen.getByRole("list", { name: "Time packs" })).getAllByRole(
      "button",
    )) {
      expect(b).toBeDisabled();
    }
    expect(screen.getByText("Not enough coins.")).toBeInTheDocument();
  });

  it("warns when a pack can only be used in part, because the team's own time is running out", async () => {
    vi.useFakeTimers({
      now: NOW,
      toFake: ["Date", "setInterval", "setTimeout", "clearInterval", "clearTimeout"],
    });
    // team has 100 s left, the question 90 s: a 600 s pack can add at most 10 s of usable time
    const base = states({ team: { ends_at: NOW + 100_000, remaining_seconds: 100 } });
    const s = {
      ...base,
      themes: base.themes.map((t) => ({
        ...t,
        questions: t.questions.map((q) =>
          q.state === "ACTIVE" ? { ...q, deadline: NOW + 90_000, remaining_seconds: 90 } : q,
        ),
      })),
    };
    c.fetchQuestion.mockResolvedValue(c.ok(withPacks({ options: [PACKS[1]!] })));
    c.fetchTeamState.mockImplementation(async () => c.ok(s));
    const view = render(
      <Game initial={s}>
        <QuestionPage theme="A" n={1} />
      </Game>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Find the value of x.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "buy time" }));
    fireEvent.click(
      within(screen.getByRole("list", { name: "Time packs" })).getAllByRole("button")[0]!,
    );
    expect(screen.getByText(/only 00:10 of this pack can be used/)).toBeInTheDocument();
    view.unmount();
  });

  it("is unavailable when the question is not ACTIVE or the team is frozen", async () => {
    c.fetchQuestion.mockResolvedValue(
      c.ok(
        question({ state: "PENDING_APPROVAL", buy_time: buyTime({ can_buy: false, options: [] }) }),
      ),
    );
    mount(states({}, "PENDING_APPROVAL", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    await screen.findByText("Find the value of x.");
    expect(screen.getByRole("button", { name: "buy time" })).toBeDisabled();
  });
});

describe("a frozen team (time up, or final submission)", () => {
  it("time up: the question is read-only and says so, even before the database stores ENDED", async () => {
    c.fetchQuestion.mockResolvedValue(c.ok(question()));
    mount(states({ team: { expired: true, frozen: true, remaining_seconds: 0 } }));
    await screen.findByText("Find the value of x.");
    expect(screen.getByRole("status")).toHaveTextContent("Your team's time is up.");
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "buy time" })).toBeDisabled();
    expect(screen.getByRole("group", { name: "Team timer" })).toHaveTextContent("00:00:00");
  });

  it("final submission: the same freeze with its own wording", async () => {
    c.fetchQuestion.mockResolvedValue(c.ok(question()));
    mount(
      states({
        team: {
          status: "FINAL_SUBMITTED",
          frozen: true,
          remaining_seconds: 9000,
          final_submitted_at: NOW - 5000,
        },
      }),
    );
    await screen.findByText("Find the value of x.");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Your team has made its final submission.",
    );
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "buy time" })).toBeDisabled();
    // 9000 s = 02:30:00, constant whatever the clock says
    expect(screen.getByRole("group", { name: "Team timer" })).toHaveTextContent("02:30:00");
  });

  it("the browser reaches ends_at before the next snapshot: the page freezes at once", async () => {
    vi.useFakeTimers({
      now: NOW,
      toFake: ["Date", "setInterval", "setTimeout", "clearInterval", "clearTimeout"],
    });
    c.fetchQuestion.mockResolvedValue(c.ok(question()));
    const s = states({ team: { ends_at: NOW + 3000, remaining_seconds: 3 } });
    // the server's clock advances (its snapshots say it is later) but its stored picture is still "RUNNING, not frozen"
    c.fetchTeamState.mockImplementation(async () =>
      c.ok({ ...s, server_now: Date.now(), state_version: s.state_version + 1 }),
    );
    mount(s);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("button", { name: "buy time" })).toBeEnabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3600);
    });
    expect(screen.getByRole("button", { name: "buy time" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
  });
});

describe("Final Submit", () => {
  const frozenAfter = (over: Partial<Parameters<typeof snapshot>[0]> = {}) =>
    snapshot({
      version: 5,
      team: {
        status: "FINAL_SUBMITTED",
        frozen: true,
        final_submitted_at: NOW,
        ended_at: NOW,
        remaining_seconds: 9000,
      },
      ...over,
    });
  const open = () =>
    fireEvent.click(screen.getByRole("button", { name: /FINAL SUBMIT|SUBMITTED/ }));
  const mountHome = (initial = snapshot()) => {
    current = initial;
    return render(
      <Game initial={initial}>
        <TicketSpiral />
      </Game>,
    );
  };

  it("states that it is irreversible and how many answers are still waiting for review", () => {
    mountHome(
      snapshot({
        themes: {
          A: { q: ["APPROVED", "PENDING_APPROVAL", "LOCKED", "LOCKED", "LOCKED"] },
          B: { q: ["PENDING_APPROVAL", "LOCKED", "LOCKED", "LOCKED", "LOCKED"] },
        },
      }),
    );
    open();
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    expect(screen.getByText(/2 answers are still waiting for review/)).toBeInTheDocument();
  });

  it("Yes sends ONE confirmed request with one key; the frozen snapshot is adopted and the ticket reads SUBMITTED", async () => {
    eco.finalSubmitCall.mockResolvedValue(c.ok(frozenAfter()));
    mountHome();
    open();
    const yes = screen.getByRole("button", { name: "Yes, submit" });
    fireEvent.click(yes);
    fireEvent.click(yes);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /SUBMITTED/ })).toBeInTheDocument(),
    );
    expect(eco.finalSubmitCall).toHaveBeenCalledTimes(1);
    expect(eco.finalSubmitCall.mock.calls[0]![0]).toMatch(UUID);
  });

  it("a team that already submitted sees that, with nothing left to confirm", () => {
    mountHome(frozenAfter());
    open();
    expect(screen.getByText(/already made its final submission/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes, submit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("is not offered while the competition is paused", () => {
    mountHome(snapshot({ competition: "PAUSED" }));
    open();
    expect(screen.getByText(/can't make a final submission right now/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes, submit" })).toBeNull();
  });

  it("a refusal shows fixed wording; a lost connection keeps the key for the retry", async () => {
    mountHome();
    open();
    eco.finalSubmitCall.mockResolvedValueOnce(c.fail("NETWORK_ERROR", 0));
    fireEvent.click(screen.getByRole("button", { name: "Yes, submit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Can't reach the server");
    eco.finalSubmitCall.mockResolvedValueOnce(c.fail("TEAM_ENDED", 409));
    fireEvent.click(screen.getByRole("button", { name: "Yes, submit" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("time has ended"));
    expect(eco.finalSubmitCall.mock.calls[1]![0]).toBe(eco.finalSubmitCall.mock.calls[0]![0]);
  });
});

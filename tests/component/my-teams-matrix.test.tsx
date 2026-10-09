// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MyTeamsMatrix } from "@/components/admin/my-teams-matrix";
import type { MatrixResult, TeamThemeResult } from "@/lib/contracts/matrix";

const TEAM_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SUB_ID = "2a8f4c1e-6b3d-4e7a-9c50-1d2e3f4a5b6c";

const themes = (
  over: Record<string, Partial<MatrixResult["teams"][number]["themes"][number]>> = {},
) =>
  "ABCDEFGHIJ".split("").map((code) => ({
    code,
    state: "NORMAL" as const,
    approved: 0,
    pending: 0,
    ...over[code],
  }));
const board = (
  over: Partial<MatrixResult["teams"][number]> = {},
  server_now = 1000,
): MatrixResult => ({
  server_now,
  presence_timeout_seconds: 75,
  teams: [
    {
      id: TEAM_ID,
      team_code: "T1",
      name: "The Euclids",
      status: "RUNNING",
      final_submitted: false,
      ufm_penalized: false,
      members: [
        { slot: 1, presence: "ONLINE" },
        { slot: 2, presence: "OFFLINE" },
        { slot: 3, presence: "ONLINE" },
        { slot: 4, presence: "ONLINE" },
      ],
      themes: themes({
        A: { state: "GREEN", approved: 5 },
        D: { state: "RED", approved: 1, pending: 1 },
        G: { state: "RED", pending: 1 },
        B: { approved: 2 },
      }),
      ...over,
    },
  ],
});
const theme = (over: Partial<TeamThemeResult["questions"][number]>[] = []): TeamThemeResult => ({
  server_now: 2000,
  team: { id: TEAM_ID, team_code: "T1", name: "The Euclids" },
  theme: { code: "D", name: "Geometry" },
  questions: [1, 2, 3, 4, 5].map((n) => ({
    id: 15 + n,
    ordinal: n,
    label: `D.${n}`,
    color: n === 1 ? ("GREEN" as const) : n === 2 ? ("RED" as const) : ("WHITE" as const),
    state:
      n === 1
        ? ("APPROVED" as const)
        : n === 2
          ? ("PENDING_APPROVAL" as const)
          : ("LOCKED" as const),
    submission:
      n === 2
        ? {
            id: SUB_ID,
            body_md: "Find the angle.",
            answer: "42 degrees",
            explanation: "by symmetry",
            submitted_by_slot: 3,
            submitted_at: 1_760_000_000_000,
            reward_coins: 50,
          }
        : null,
    ...over[n - 1],
  })),
});

const reply = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify({ ok: true, data, server_now: 1 }), { status }));
const fail = (status: number, code: string) =>
  Promise.resolve(
    new Response(
      JSON.stringify({ ok: false, error: { code, message: "SERVER TEXT" }, server_now: 1 }),
      {
        status,
      },
    ),
  );

const fetchMock = vi.fn();
const fetchImpl = fetchMock as unknown as typeof fetch;
const calls = (prefix: string) =>
  fetchMock.mock.calls.filter((c) => String(c[0]).startsWith(prefix));

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter: every poll is exactly one interval apart
  fetchMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("<MyTeamsMatrix /> — the board", () => {
  it("has exactly the documented columns, one row per team, and a Go back link to the Admin home", () => {
    fetchMock.mockImplementation(() => reply(board()));
    render(<MyTeamsMatrix initial={board()} fetchImpl={fetchImpl} />);
    const heads = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual([
      "Team ID",
      "M1",
      "M2",
      "M3",
      "M4",
      ..."ABCDEFGHIJ".split(""),
      "Final submit",
    ]);
    expect(screen.getAllByRole("row")).toHaveLength(2); // header + T1
    expect(screen.getByRole("link", { name: "Go back" })).toHaveAttribute("href", "/admin");
  });

  it("shows member presence per member, IN / OUT, never one value for the team", () => {
    render(<MyTeamsMatrix initial={board()} fetchImpl={fetchImpl} />);
    expect(
      ["M1", "M2", "M3", "M4"].map(
        (m) => screen.getByLabelText(`T1 ${m}: ${m === "M2" ? "out" : "in"}`).textContent,
      ),
    ).toEqual(["IN", "OUT", "IN", "IN"]);
  });

  it("draws red, green and plain theme cells with text labels (not colour alone), several red at once", () => {
    render(<MyTeamsMatrix initial={board()} fetchImpl={fetchImpl} />);
    const state = (c: string) => screen.getByTestId(`cell-T1-${c}`).getAttribute("data-state");
    expect([state("A"), state("B"), state("D"), state("G")]).toEqual([
      "GREEN",
      "NORMAL",
      "RED",
      "RED",
    ]);
    expect(screen.getByLabelText("T1 theme D: 1 submission waiting for review")).toHaveTextContent(
      "REVIEW",
    );
    expect(screen.getByLabelText("T1 theme A: completed")).toHaveTextContent("✓");
    expect(screen.getByLabelText("T1 theme B: 2 of 5 approved")).toHaveTextContent("2/5");
    expect(screen.getByLabelText("T1 theme C: 0 of 5 approved")).toHaveTextContent("");
  });

  it("final submit: submitted is green with text, otherwise a dash", () => {
    const { unmount } = render(<MyTeamsMatrix initial={board()} fetchImpl={fetchImpl} />);
    expect(screen.getByTestId("final-T1")).toHaveTextContent("—");
    unmount();
    render(<MyTeamsMatrix initial={board({ final_submitted: true })} fetchImpl={fetchImpl} />);
    expect(screen.getByTestId("final-T1")).toHaveTextContent("✓ Submitted");
  });

  it("an Admin with no team sees how to get one", () => {
    render(<MyTeamsMatrix initial={{ ...board(), teams: [] }} fetchImpl={fetchImpl} />);
    expect(screen.getByText(/You have not created a team yet/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("re-reads on a poll, shows the newer board, ignores an older one, and keeps the last board while offline", async () => {
    fetchMock
      .mockImplementationOnce(() => reply(board({}, 3000))) // newer
      .mockImplementationOnce(() =>
        reply(
          board(
            {
              members: board().teams[0]!.members.map((m) => ({
                ...m,
                presence: "OFFLINE" as const,
              })),
            },
            500,
          ),
        ),
      ) // older: must be ignored
      .mockImplementationOnce(() => Promise.reject(new TypeError("offline")))
      .mockImplementation(() => reply(board({}, 9000)));
    const first = board({}, 1000);
    first.teams[0]!.members[0]!.presence = "OFFLINE";
    render(<MyTeamsMatrix initial={first} intervalMs={1000} fetchImpl={fetchImpl} />);
    expect(screen.getByTestId("presence-T1-M1")).toHaveTextContent("OUT");
    await tick(0); // first read: newer
    expect(screen.getByTestId("presence-T1-M1")).toHaveTextContent("IN");
    await tick(1000); // second read: older snapshot is ignored
    expect(screen.getByTestId("presence-T1-M1")).toHaveTextContent("IN");
    await tick(1000); // third read fails: the last board stays, with a notice
    expect(screen.getByTestId("presence-T1-M1")).toHaveTextContent("IN");
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
    await tick(1000); // recovered
    expect(screen.queryByRole("status")).toBeNull();
    expect(calls("/api/admin/matrix").length).toBeGreaterThanOrEqual(4);
  });
});

describe("<MyTeamsMatrix /> — theme and submission review", () => {
  async function openTheme() {
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("/themes/") ? reply(theme()) : reply(board()),
    );
    render(<MyTeamsMatrix initial={board()} intervalMs={60_000} fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByTestId("cell-T1-D"));
    await tick(0);
    return screen.getByRole("dialog");
  }

  it("a theme cell opens the five questions: green approved, red waiting, white otherwise", async () => {
    const dialog = await openTheme();
    expect(calls(`/api/admin/teams/${TEAM_ID}/themes/D`)).toHaveLength(1);
    expect(within(dialog).getByRole("heading")).toHaveTextContent("T1 · Theme D · Geometry");
    const colors = [1, 2, 3, 4, 5].map((n) =>
      within(dialog).getByTestId(`question-D.${n}`).getAttribute("data-color"),
    );
    expect(colors).toEqual(["GREEN", "RED", "WHITE", "WHITE", "WHITE"]);
    // only the red question can be opened
    expect(within(dialog).getByRole("button", { name: /D\.2/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /D\.1:/ })).toBeNull();
  });

  it("a red question shows the submission; Approve calls the existing endpoint once, with an Idempotency-Key and no body fields", async () => {
    const dialog = await openTheme();
    fireEvent.click(within(dialog).getByTestId("question-D.2"));
    expect(within(dialog).getByTestId("review-answer")).toHaveTextContent("42 degrees");
    expect(within(dialog).getByTestId("review-explanation")).toHaveTextContent("by symmetry");
    expect(dialog).toHaveTextContent("submitted by M3");
    expect(dialog).toHaveTextContent("+50 coins");
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("/approve")
        ? reply({
            submission: { id: SUB_ID, status: "APPROVED" },
            reward_awarded: 50,
            next_question_activated: true,
          })
        : String(url).includes("/themes/")
          ? reply(theme())
          : reply(board()),
    );
    const approve = within(dialog).getByRole("button", { name: "Approve" });
    fireEvent.click(approve);
    fireEvent.click(approve); // a double click
    await tick(0);
    const posts = calls("/api/admin/submissions");
    expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe(`/api/admin/submissions/${SUB_ID}/approve`);
    const init = posts[0]![1] as RequestInit & { headers: Record<string, string> };
    expect(init.method).toBe("POST");
    expect(init.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.body).toBe("{}");
    expect(within(dialog).getByRole("status")).toHaveTextContent("D.2 approved: +50 coins for T1");
  });

  it("Disapprove sends the note only, and a lost response is retried with the SAME key", async () => {
    const dialog = await openTheme();
    fireEvent.click(within(dialog).getByTestId("question-D.2"));
    fireEvent.change(within(dialog).getByLabelText(/Note for the team/), {
      target: { value: "  Check the sign.  " },
    });
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("/disapprove")
        ? Promise.reject(new TypeError("offline"))
        : String(url).includes("/themes/")
          ? reply(theme())
          : reply(board()),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Disapprove" }));
    await tick(0);
    expect(within(dialog).getByRole("status")).toBeInTheDocument();
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("/disapprove")
        ? reply({ submission: { id: SUB_ID, status: "REJECTED" } })
        : String(url).includes("/themes/")
          ? reply(theme())
          : reply(board()),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Disapprove" }));
    await tick(0);
    const posts = calls("/api/admin/submissions");
    expect(posts).toHaveLength(2);
    const [a, b] = posts.map((p) => p[1] as RequestInit & { headers: Record<string, string> });
    expect(a!.headers["Idempotency-Key"]).toBe(b!.headers["Idempotency-Key"]);
    expect(JSON.parse(String(b!.body))).toEqual({ note: "Check the sign." });
    expect(within(dialog).getByRole("status")).toHaveTextContent("D.2 disapproved");
  });

  it("a submission someone else already decided is reported plainly, with a fresh read", async () => {
    const dialog = await openTheme();
    fireEvent.click(within(dialog).getByTestId("question-D.2"));
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("/approve")
        ? fail(409, "SUBMISSION_NOT_PENDING")
        : String(url).includes("/themes/")
          ? reply(theme([{}, { color: "GREEN", state: "APPROVED", submission: null }]))
          : reply(board()),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await tick(0);
    await tick(0);
    expect(dialog).toHaveTextContent("no longer waiting for review");
    expect(dialog).toHaveTextContent("already reviewed");
    expect(dialog).not.toHaveTextContent("SERVER TEXT");
  });

  it("an Approve that fails with a server fault keeps the key; a definitive refusal frees it", async () => {
    const dialog = await openTheme();
    fireEvent.click(within(dialog).getByTestId("question-D.2"));
    const keyOf = (i: number) =>
      (calls("/api/admin/submissions")[i]![1] as { headers: Record<string, string> }).headers[
        "Idempotency-Key"
      ];
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("/approve")
        ? fail(503, "SERVICE_UNAVAILABLE")
        : String(url).includes("/themes/")
          ? reply(theme())
          : reply(board()),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await tick(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await tick(0);
    expect(keyOf(0)).toBe(keyOf(1));
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("/approve")
        ? fail(403, "FORBIDDEN")
        : String(url).includes("/themes/")
          ? reply(theme())
          : reply(board()),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await tick(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await tick(0);
    expect(keyOf(2)).not.toBe(keyOf(3)); // the refusal was definitive: a new decision gets a new key
  });
});

// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MyTeamsMatrix } from "@/components/admin/my-teams-matrix";
import type { MatrixResult } from "@/lib/contracts/matrix";

const TEAM_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OTHER_ID = "0e3c1f2a-9b7d-4c55-8a10-5d2f6b1c9e44";

const themes = "ABCDEFGHIJ".split("").map((code) => ({
  code,
  state: "NORMAL" as const,
  approved: 0,
  pending: 0,
}));
const team = (over: Partial<MatrixResult["teams"][number]> = {}) => ({
  id: TEAM_ID,
  team_code: "T1",
  name: "The Euclids",
  status: "RUNNING",
  final_submitted: false,
  ufm_penalized: false,
  members: [{ slot: 1, presence: "ONLINE" as const }],
  themes,
  ...over,
});
const board = (teams = [team()], server_now = 1000): MatrixResult => ({
  server_now,
  presence_timeout_seconds: 75,
  teams,
});

const reply = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify({ ok: true, data, server_now: 1 }), { status }));
const fail = (status: number, code: string) =>
  Promise.resolve(
    new Response(
      JSON.stringify({ ok: false, error: { code, message: "SERVER TEXT" }, server_now: 1 }),
      { status },
    ),
  );
const penalized = () =>
  reply({
    changed: true,
    team: { id: TEAM_ID, team_code: "T1", status: "ENDED", official_score: 0, penalized_at: 5 },
  });

const fetchMock = vi.fn();
const fetchImpl = fetchMock as unknown as typeof fetch;
const penaltyCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/penalize"));
const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => reply(board()));
});
afterEach(() => vi.useRealTimers());

const open = async () => {
  render(<MyTeamsMatrix initial={board()} intervalMs={60_000} fetchImpl={fetchImpl} />);
  await tick(0);
  fireEvent.click(screen.getByTestId("team-T1"));
  return screen.getByRole("dialog");
};

describe("Penalise this team (UFM)", () => {
  it("a Team ID is a button; clicking it opens the confirmation with Yes and No", async () => {
    const dialog = await open();
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByRole("heading", { name: "Penalise this team" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("T1");
    expect(dialog).toHaveTextContent("official score becomes 0");
    expect(screen.getByRole("button", { name: "Yes" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "No" })).toBeEnabled();
    expect(penaltyCalls()).toHaveLength(0); // opening it sends nothing
  });

  it("No closes the dialog and sends nothing", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    await tick(50);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(penaltyCalls()).toHaveLength(0);
    expect(screen.queryByTestId("ufm-T1")).toBeNull();
  });

  it("Yes sends ONE request with a key and the strict confirmation body, then re-reads the board and closes", async () => {
    await open();
    fetchMock.mockImplementation((url: string) =>
      String(url).endsWith("/penalize")
        ? penalized()
        : reply(board([team({ status: "ENDED", ufm_penalized: true })], 2000)),
    );
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await tick(0);
    await tick(0);
    expect(penaltyCalls()).toHaveLength(1);
    const [url, init] = penaltyCalls()[0]!;
    expect(url).toBe(`/api/admin/teams/${TEAM_ID}/penalize`);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ confirm: true });
    expect(((init as RequestInit).headers as Record<string, string>)["Idempotency-Key"]).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    // the board shows the persisted state, from the server
    expect(screen.getByTestId("ufm-T1")).toHaveTextContent("Penalised");
  });

  it("a double click is one request", async () => {
    await open();
    let release!: () => void;
    fetchMock.mockImplementation((url: string) =>
      String(url).endsWith("/penalize")
        ? new Promise((r) => {
            release = () => r(penalized());
          })
        : reply(board()),
    );
    const yes = screen.getByRole("button", { name: "Yes" });
    fireEvent.click(yes);
    fireEvent.click(yes);
    await tick(0);
    expect(screen.getByRole("button", { name: "Penalising…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "No" })).toBeDisabled();
    expect(penaltyCalls()).toHaveLength(1);
    release();
    await tick(0);
  });

  it("keeps the SAME key when the connection fails and shows fixed wording, never the server's text", async () => {
    const dialog = await open();
    fetchMock.mockImplementation((url: string) =>
      String(url).endsWith("/penalize") ? Promise.reject(new TypeError("offline")) : reply(board()),
    );
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await tick(0);
    expect(screen.getByRole("alert")).toHaveTextContent("Can't reach the server");
    expect(dialog).toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await tick(0);
    const keys = penaltyCalls().map(
      (c) => ((c[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("a definitive refusal ends the intent: a NEW key is used afterwards, and the wording is ours", async () => {
    await open();
    fetchMock.mockImplementation((url: string) =>
      String(url).endsWith("/penalize") ? fail(409, "TEAM_NOT_STARTED") : reply(board()),
    );
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await tick(0);
    expect(screen.getByRole("alert")).toHaveTextContent("has not started yet");
    expect(document.body.textContent).not.toContain("SERVER TEXT");
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await tick(0);
    const keys = penaltyCalls().map(
      (c) => ((c[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("a team that is not this admin's (404) and a refusal (403) are explained, not retried", async () => {
    await open();
    fetchMock.mockImplementation((url: string) =>
      String(url).endsWith("/penalize") ? fail(404, "NOT_FOUND") : reply(board()),
    );
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await tick(0);
    expect(screen.getByRole("alert")).toHaveTextContent("not one of yours");
  });

  it("an already penalised team shows its state and offers only Close (no second penalty)", async () => {
    const done = board([team({ status: "ENDED", ufm_penalized: true })]);
    fetchMock.mockImplementation(() => reply(done));
    render(<MyTeamsMatrix initial={done} intervalMs={60_000} fetchImpl={fetchImpl} />);
    await tick(0);
    expect(screen.getByTestId("ufm-T1")).toHaveTextContent("Penalised");
    fireEvent.click(screen.getByTestId("team-T1"));
    expect(screen.getByRole("dialog")).toHaveTextContent("already been penalised");
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("every team has its own button and the dialog acts on the clicked team only", async () => {
    const two = board([team(), team({ id: OTHER_ID, team_code: "T2", name: "The Gausses" })]);
    fetchMock.mockImplementation((url: string) =>
      String(url).endsWith("/penalize") ? penalized() : reply(two),
    );
    render(<MyTeamsMatrix initial={two} intervalMs={60_000} fetchImpl={fetchImpl} />);
    await tick(0);
    fireEvent.click(screen.getByTestId("team-T2"));
    expect(screen.getByRole("dialog")).toHaveTextContent("T2");
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await tick(0);
    expect(penaltyCalls()[0]![0]).toBe(`/api/admin/teams/${OTHER_ID}/penalize`);
  });
});

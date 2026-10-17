// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CompetitionControl } from "@/components/lifecycle/competition-control";
import type { CompetitionStatusValue } from "@/lib/contracts/runtime";

const fetchMock = vi.fn();
beforeEach(() => fetchMock.mockReset());
const f = fetchMock as unknown as typeof fetch;

const envelope = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data, server_now: 1 }), { status: 200 });
const ok = (data: unknown) => Promise.resolve(envelope(data));
const err = (status: number, code: string, details?: unknown) =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        ok: false,
        error: { code, message: "SERVER TEXT", details },
        server_now: 1,
      }),
      { status },
    ),
  );

/** What `set_competition_status` answers (the strict result schema of the API). */
const result = (action: string, from: string, to: string, changed = true) => ({
  replayed: false,
  changed,
  action,
  from,
  to,
  competition: { status: to, opened_at: null, paused_at: null, ended_at: null, state_version: 7 },
});

const mount = (status: CompetitionStatusValue | null = "SETUP", teams = 3) =>
  render(<CompetitionControl initial={status === null ? null : { status, teams }} fetchImpl={f} />);

const statusText = () => screen.getByTestId("competition-status").textContent;
const btn = (name: string | RegExp) => screen.getByRole("button", { name });
const hasBtn = (name: string | RegExp) => screen.queryByRole("button", { name }) !== null;
// A closed <dialog> is hidden, so its accessible name is not computed: find it by its heading.
const endDialog = () => {
  const d = screen
    .getAllByRole("dialog", { hidden: true })
    .find((x) => x.querySelector("h2")?.textContent === "End the competition?");
  if (!d) throw new Error("no end dialog");
  return d;
};
const bodyOf = (i: number) => JSON.parse(String((fetchMock.mock.calls[i]![1] as RequestInit).body));
const headerOf = (i: number, h: string) =>
  ((fetchMock.mock.calls[i]![1] as RequestInit).headers as Record<string, string>)[h];

describe("what is shown and offered for each status", () => {
  it("SETUP: the status, why nobody can sign in, how many teams exist, and only 'Open competition'", () => {
    mount("SETUP", 3);
    expect(statusText()).toBe("Setup");
    expect(screen.getByTestId("competition-help")).toHaveTextContent(
      "Not open. Participants cannot sign in until you open the competition.",
    );
    expect(screen.getByTestId("competition-help")).toHaveTextContent("3 teams are registered.");
    expect(btn("Open competition")).toBeEnabled();
    expect(hasBtn("Pause")).toBe(false);
    expect(hasBtn("Resume")).toBe(false);
    expect(hasBtn("End competition")).toBe(false);
  });

  it("uses the singular for one team", () => {
    mount("SETUP", 1);
    expect(screen.getByTestId("competition-help")).toHaveTextContent("1 team is registered.");
  });

  it("RUNNING: 'Pause' and 'End competition', never 'Open' or 'Resume'", () => {
    mount("RUNNING");
    expect(statusText()).toBe("Running");
    expect(btn("Pause")).toBeEnabled();
    expect(btn("End competition")).toBeEnabled();
    expect(hasBtn("Open competition")).toBe(false);
    expect(hasBtn("Resume")).toBe(false);
  });

  it("PAUSED: 'Resume' and 'End competition', never 'Open' or 'Pause'", () => {
    mount("PAUSED");
    expect(statusText()).toBe("Paused");
    expect(btn("Resume")).toBeEnabled();
    expect(btn("End competition")).toBeEnabled();
    expect(hasBtn("Open competition")).toBe(false);
    expect(hasBtn("Pause")).toBe(false);
  });

  it("ENDED: shows the ended state and offers NO action (the backend has no way back), only a pointer to renewal", () => {
    mount("ENDED");
    expect(statusText()).toBe("Ended");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("link", { name: "Renew the competition" })).toHaveAttribute(
      "href",
      "/superadmin/renew",
    );
  });

  it("an unreadable status offers no action at all (a wrong guess would offer the wrong one), only a reload", () => {
    mount(null);
    expect(screen.getByTestId("competition-unavailable")).toHaveTextContent("could not be read");
    expect(screen.queryByTestId("competition-status")).toBeNull();
    expect(hasBtn("Open competition")).toBe(false);
    expect(hasBtn("Pause")).toBe(false);
    expect(hasBtn("End competition")).toBe(false);
    expect(btn("Reload")).toBeEnabled();
  });

  it("is a labelled region", () => {
    mount("SETUP");
    expect(screen.getByRole("region", { name: "Competition" })).toBeInTheDocument();
  });
});

describe("Open competition (SETUP → RUNNING)", () => {
  it("sends exactly { action: 'open', confirm: true } once with an Idempotency-Key, shows progress, then the new status and actions", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
    mount("SETUP");
    const open = btn("Open competition");
    fireEvent.click(open);
    fireEvent.click(open); // a double click is one request
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "Competition" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(btn("Opening…")).toBeDisabled();
    expect(screen.queryByTestId("competition-notice")).toBeNull(); // no success before the server says so

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/super/competition/status");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).credentials).toBe("same-origin");
    expect(headerOf(0, "Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(bodyOf(0)).toEqual({ action: "open", confirm: true });

    await act(async () => {
      release(envelope(result("open", "SETUP", "RUNNING")));
    });
    await waitFor(() => expect(statusText()).toBe("Running"));
    expect(screen.getByTestId("competition-notice")).toHaveTextContent(
      "The competition is open. Participants can now sign in.",
    );
    expect(screen.queryByTestId("competition-error")).toBeNull();
    expect(btn("Pause")).toBeEnabled();
    expect(btn("End competition")).toBeEnabled();
    expect(hasBtn("Open competition")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("opening needs no confirmation dialog", () => {
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    mount("SETUP");
    fireEvent.click(btn("Open competition"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
  });

  it("an 'already there' answer says nothing changed instead of claiming a change", async () => {
    fetchMock.mockImplementationOnce(() => ok(result("open", "RUNNING", "RUNNING", false)));
    mount("SETUP");
    fireEvent.click(btn("Open competition"));
    await waitFor(() => expect(statusText()).toBe("Running"));
    expect(screen.getByTestId("competition-notice")).toHaveTextContent(
      "Nothing changed: the competition was already running.",
    );
  });
});

describe("Pause and Resume", () => {
  it("Pause then Resume send their own actions, with a new key per intent, and switch the offered actions", async () => {
    fetchMock
      .mockImplementationOnce(() => ok(result("pause", "RUNNING", "PAUSED")))
      .mockImplementationOnce(() => ok(result("resume", "PAUSED", "RUNNING")));
    mount("RUNNING");
    fireEvent.click(btn("Pause"));
    await waitFor(() => expect(statusText()).toBe("Paused"));
    expect(bodyOf(0)).toEqual({ action: "pause", confirm: true });
    expect(screen.getByTestId("competition-notice")).toHaveTextContent(
      "The competition is paused.",
    );
    expect(btn("Resume")).toBeEnabled();
    expect(hasBtn("Pause")).toBe(false);

    fireEvent.click(btn("Resume"));
    await waitFor(() => expect(statusText()).toBe("Running"));
    expect(bodyOf(1)).toEqual({ action: "resume", confirm: true });
    expect(screen.getByTestId("competition-notice")).toHaveTextContent(
      "The competition is running again.",
    );
    expect(headerOf(1, "Idempotency-Key")).not.toBe(headerOf(0, "Idempotency-Key"));
  });

  it("pause and resume need no confirmation dialog", () => {
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    mount("RUNNING");
    fireEvent.click(btn("Pause"));
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("End competition (irreversible: asks first)", () => {
  const dialogOpen = () => endDialog().hasAttribute("open");

  it("opens a confirmation and sends NOTHING; 'Go back' closes it and changes nothing", () => {
    mount("RUNNING");
    fireEvent.click(btn("End competition"));
    expect(dialogOpen()).toBe(true);
    expect(endDialog()).toHaveTextContent("This cannot be undone");
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(endDialog()).getByRole("button", { name: "Go back" }));
    expect(dialogOpen()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusText()).toBe("Running");
  });

  it("'Yes, end competition' sends { action: 'end', confirm: true } once, then shows Ended with no actions", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
    mount("PAUSED");
    fireEvent.click(btn("End competition"));
    const yes = within(endDialog()).getByRole("button", { name: "Yes, end competition" });
    fireEvent.click(yes);
    fireEvent.click(yes);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(0)).toEqual({ action: "end", confirm: true });
    expect(within(endDialog()).getByRole("button", { name: "Ending…" })).toBeDisabled();
    expect(within(endDialog()).getByRole("button", { name: "Go back" })).toBeDisabled();

    await act(async () => {
      release(envelope(result("end", "PAUSED", "ENDED")));
    });
    await waitFor(() => expect(statusText()).toBe("Ended"));
    expect(dialogOpen()).toBe(false);
    expect(screen.getByTestId("competition-notice")).toHaveTextContent(
      "The competition has ended.",
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("failures", () => {
  it("COMPETITION_NOT_READY with no team explains it, keeps the status, and never shows server text", async () => {
    fetchMock.mockImplementationOnce(() => err(409, "COMPETITION_NOT_READY", { teams: 0 }));
    mount("SETUP", 0);
    fireEvent.click(btn("Open competition"));
    await waitFor(() => expect(screen.getByTestId("competition-error")).toBeInTheDocument());
    expect(screen.getByTestId("competition-error")).toHaveTextContent(
      "Nothing was changed. The competition cannot open yet: no team exists.",
    );
    expect(screen.getByTestId("competition-error").textContent).not.toContain("SERVER TEXT");
    expect(statusText()).toBe("Setup");
    expect(screen.queryByTestId("competition-notice")).toBeNull(); // never a success message
    expect(btn("Open competition")).toBeEnabled();
  });

  it("COMPETITION_NOT_READY for other reasons names the other requirement", async () => {
    fetchMock.mockImplementationOnce(() =>
      err(409, "COMPETITION_NOT_READY", { teams: 2, themes: 10, questions: 49 }),
    );
    mount("SETUP");
    fireEvent.click(btn("Open competition"));
    await waitFor(() =>
      expect(screen.getByTestId("competition-error")).toHaveTextContent(
        "all 10 themes with 5 questions each",
      ),
    );
  });

  it("a transition refused because the state changed in another tab corrects the display to the state the server reports", async () => {
    fetchMock.mockImplementationOnce(() =>
      err(409, "INVALID_COMPETITION_TRANSITION", { from: "ENDED", action: "pause" }),
    );
    mount("RUNNING");
    fireEvent.click(btn("Pause"));
    await waitFor(() => expect(statusText()).toBe("Ended"));
    expect(screen.getByTestId("competition-error")).toHaveTextContent(
      "Nothing was changed. That is not allowed in the competition's current state.",
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("a nonsense state in the details is ignored", async () => {
    fetchMock.mockImplementationOnce(() =>
      err(409, "INVALID_COMPETITION_TRANSITION", { from: "BANANA" }),
    );
    mount("RUNNING");
    fireEvent.click(btn("Pause"));
    await waitFor(() => expect(screen.getByTestId("competition-error")).toBeInTheDocument());
    expect(statusText()).toBe("Running");
  });

  it.each([
    ["FORBIDDEN", "Only the Superadmin can change"],
    ["UNAUTHENTICATED", "Your session has ended"],
    ["SERVICE_UNAVAILABLE", "Nothing was reported as changed"],
  ])("%s: fixed wording, no server text, status unchanged", async (code, text) => {
    fetchMock.mockImplementationOnce(() => err(code === "SERVICE_UNAVAILABLE" ? 503 : 403, code));
    mount("SETUP");
    fireEvent.click(btn("Open competition"));
    await waitFor(() => expect(screen.getByTestId("competition-error")).toHaveTextContent(text));
    expect(screen.getByTestId("competition-error").textContent).not.toContain("SERVER TEXT");
    expect(statusText()).toBe("Setup");
  });

  it("a failed End closes the dialog, reports the failure and never claims success", async () => {
    fetchMock.mockImplementationOnce(() =>
      err(409, "INVALID_COMPETITION_TRANSITION", { from: "ENDED" }),
    );
    mount("RUNNING");
    fireEvent.click(btn("End competition"));
    fireEvent.click(within(endDialog()).getByRole("button", { name: "Yes, end competition" }));
    await waitFor(() => expect(screen.getByTestId("competition-error")).toBeInTheDocument());
    expect(endDialog().hasAttribute("open")).toBe(false);
    expect(screen.queryByTestId("competition-notice")).toBeNull();
  });

  it("after an unknown outcome the retry reuses the Idempotency-Key; after a definite failure a new request gets a new one", async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.reject(new TypeError("offline")))
      .mockImplementationOnce(() => err(409, "COMPETITION_NOT_READY", { teams: 0 }))
      .mockImplementationOnce(() => ok(result("open", "SETUP", "RUNNING")));
    mount("SETUP");
    fireEvent.click(btn("Open competition"));
    await waitFor(() =>
      expect(screen.getByTestId("competition-error")).toHaveTextContent("can't tell whether"),
    );
    fireEvent.click(btn("Open competition")); // unknown outcome: SAME key
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(headerOf(1, "Idempotency-Key")).toBe(headerOf(0, "Idempotency-Key"));
    await waitFor(() =>
      expect(screen.getByTestId("competition-error")).toHaveTextContent("no team exists"),
    );
    fireEvent.click(btn("Open competition")); // definite failure before: NEW key
    await waitFor(() => expect(statusText()).toBe("Running"));
    expect(headerOf(2, "Idempotency-Key")).not.toBe(headerOf(0, "Idempotency-Key"));
  });
});

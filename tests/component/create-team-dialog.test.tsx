// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateTeamNav } from "@/components/provisioning/create-team-dialog";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
});

const ok = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ ok: true, data, server_now: 1 }), { status: 200 }));
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

const VALUES = {
  "Team ID": " t1 ",
  "Team Name": "The Euclids",
  "Login ID": "euclids",
  Password: "team-password-1",
  "Confirm Password": "team-password-1",
  "M1 Admission No.": "23JE0001",
  "M2 Admission No.": "23JE0002",
  "M3 Admission No.": "23JE0003",
  "M4 Admission No.": "23JE0004",
};
function open() {
  render(<CreateTeamNav fetchImpl={fetchMock as unknown as typeof fetch} />);
  fireEvent.click(screen.getByRole("button", { name: "Create a team" }));
}
function fill(overrides: Partial<Record<keyof typeof VALUES, string>> = {}) {
  for (const [label, value] of Object.entries({ ...VALUES, ...overrides })) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
}
const create = () => fireEvent.click(screen.getByRole("button", { name: "Create Team" }));
const createdTeam = { team: { team_code: "T1", name: "The Euclids" } };

describe("<CreateTeamNav />", () => {
  it("opens 'Create a New Team' with exactly the nine specified fields and the two buttons, and no owner/coin field", () => {
    open();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Create a New Team" })).toBeInTheDocument();
    for (const label of Object.keys(VALUES))
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(dialog.querySelectorAll("input")).toHaveLength(9);
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Confirm Password")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Create Team" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go Back" })).toBeInTheDocument();
    expect(dialog.querySelector('[name*="admin" i]:not([name^="admission"])')).toBeNull();
    expect(dialog.querySelector('[name*="coin" i]')).toBeNull();
  });

  it("Go Back closes the dialog without creating anything", () => {
    open();
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Go Back" }));
    expect(screen.getByRole("dialog", { hidden: true })).not.toHaveAttribute("open");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires every field, matching passwords, and four DIFFERENT admission numbers, before any request", () => {
    open();
    create();
    expect(screen.getByLabelText("Team ID")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter M1's admission number.")).toBeInTheDocument();
    expect(screen.getByText("Enter M4's admission number.")).toBeInTheDocument();
    fill({ "Confirm Password": "something-else-1", "M4 Admission No.": "23je0002" });
    create();
    expect(screen.getByText("The passwords don't match.")).toBeInTheDocument();
    expect(
      screen.getByText("M4's admission number repeats an earlier member's."),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the nine values (and nothing else) with an Idempotency-Key, then shows success and refreshes My teams", async () => {
    fetchMock.mockReturnValue(ok(createdTeam));
    open();
    fill();
    create();
    await screen.findByRole("heading", { name: "Team created" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/teams");
    expect(JSON.parse(init.body as string)).toEqual({
      teamCode: "t1",
      name: "The Euclids",
      loginId: "euclids",
      password: "team-password-1",
      confirmPassword: "team-password-1",
      admissionNos: ["23JE0001", "23JE0002", "23JE0003", "23JE0004"],
    });
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("T1 — The Euclids");
    expect(screen.getByRole("status").textContent).not.toContain("team-password-1");
  });

  it("a double click creates ONE team: one request while in flight, fields disabled", async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    open();
    fill();
    const button = screen.getByRole("button", { name: "Create Team" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Team ID")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    resolve(
      new Response(JSON.stringify({ ok: true, data: createdTeam, server_now: 1 }), { status: 200 }),
    );
    await screen.findByRole("heading", { name: "Team created" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["TEAM_CODE_TAKEN", undefined, "Team ID", "That Team ID is already in use."],
    ["LOGIN_ID_TAKEN", undefined, "Login ID", "That Login ID is already in use."],
    [
      "ADMISSION_NO_TAKEN",
      { slot: 3 },
      "M3 Admission No.",
      "M3's admission number is already registered to a team.",
    ],
  ])("shows %s on the right field and keeps what was typed", async (code, details, label, text) => {
    fetchMock.mockReturnValue(err(409, code, details));
    open();
    fill();
    create();
    await screen.findByText(text);
    expect(screen.getByLabelText(label)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Login ID")).toHaveValue("euclids");
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByText("SERVER TEXT")).toBeNull();
  });

  it("reports server-named invalid fields (including a member slot) without echoing server text", async () => {
    fetchMock.mockReturnValue(
      err(400, "VALIDATION_FAILED", { fields: ["name", "admissionNos.2"] }),
    );
    open();
    fill();
    create();
    await screen.findByText("Enter a team name of up to 100 characters.");
    expect(screen.getByLabelText("M2 Admission No.")).toHaveAttribute("aria-invalid", "true");
    expect(document.body.textContent).not.toContain("SERVER TEXT");
  });

  it("a lost response is retried with the SAME key (the server replays it), so a double create is impossible", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline")).mockReturnValueOnce(ok(createdTeam));
    open();
    fill();
    create();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/Couldn't reach the server/),
    );
    create();
    await screen.findByRole("heading", { name: "Team created" });
    const key = (i: number) =>
      ((fetchMock.mock.calls[i] as [string, RequestInit])[1].headers as Record<string, string>)[
        "Idempotency-Key"
      ];
    expect(key(1)).toBe(key(0));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

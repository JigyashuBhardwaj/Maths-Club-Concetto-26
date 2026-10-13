// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeletionScreen } from "@/components/deletion/deletion-screen";
import type { DeletableAdmin, DeletableTeam } from "@/lib/contracts/deletion";

const fetchMock = vi.fn();
beforeEach(() => fetchMock.mockReset());
const f = fetchMock as unknown as typeof fetch;

const ok = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ ok: true, data, server_now: 1 }), { status: 200 }));
const err = (status: number, code: string) =>
  Promise.resolve(
    new Response(
      JSON.stringify({ ok: false, error: { code, message: "SERVER TEXT" }, server_now: 1 }),
      { status },
    ),
  );

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const admin = (n: number, teams = 1): DeletableAdmin => ({
  id: id(n),
  username: `admin_${n}`,
  is_active: true,
  team_count: teams,
  created_at: 1,
});
const team = (n: number): DeletableTeam => ({
  id: id(100 + n),
  team_code: `T${n}`,
  name: `Team ${n}`,
  login_id: `login_${n}`,
  status: "NOT_STARTED",
  admin_username: "admin_1",
  member_count: 4,
  created_at: 1,
});

const bodyOf = (call: number) =>
  JSON.parse(String((fetchMock.mock.calls[call]![1] as RequestInit).body));
const trash = () => screen.getByRole("button", { name: /^Delete selected/ });
const pick = (name: string) => fireEvent.click(screen.getByRole("checkbox", { name }));
const dialog = () => screen.getByRole("dialog", { hidden: true });
const dialogOpen = () => dialog().hasAttribute("open");

describe("<DeletionScreen kind='admins' />", () => {
  const admins = [admin(1, 2), admin(2, 0), admin(3, 1)];
  const mount = () => render(<DeletionScreen kind="admins" initialAdmins={admins} fetchImpl={f} />);

  it("shows a go-back link, a title, one checkbox row per admin with identifying info, and a disabled trash button", () => {
    mount();
    expect(screen.getByRole("link", { name: /Go back/ })).toHaveAttribute("href", "/superadmin");
    expect(screen.getByRole("heading", { name: "Delete Admins" })).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox", { name: /^Select admin_/ })).toHaveLength(3);
    expect(screen.getByText("2 teams")).toBeInTheDocument();
    expect(screen.getByText("0 teams")).toBeInTheDocument();
    expect(screen.getByText("1 team")).toBeInTheDocument();
    expect(screen.getByTestId("selected-count")).toHaveTextContent("0 selected");
    expect(trash()).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supports single and multiple selection and shows the count", () => {
    mount();
    pick("Select admin_1");
    expect(screen.getByTestId("selected-count")).toHaveTextContent("1 selected");
    expect(trash()).toBeEnabled();
    expect(trash()).toHaveAccessibleName("Delete selected admin (1)");
    pick("Select admin_3");
    expect(screen.getByTestId("selected-count")).toHaveTextContent("2 selected");
    expect(trash()).toHaveAccessibleName("Delete selected admins (2)");
    pick("Select admin_1");
    pick("Select admin_3");
    expect(trash()).toBeDisabled();
  });

  it("select all selects every row and a second click clears it", () => {
    mount();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(screen.getByTestId("selected-count")).toHaveTextContent("3 selected");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(screen.getByTestId("selected-count")).toHaveTextContent("0 selected");
  });

  it("the trash button opens the confirmation with the exact wording (singular and plural) and sends nothing", () => {
    mount();
    pick("Select admin_1");
    fireEvent.click(trash());
    expect(dialogOpen()).toBe(true);
    expect(
      within(dialog()).getByText("Do you want to permanently delete the selected admin?"),
    ).toBeInTheDocument();
    expect(within(dialog()).getByText(/2 teams and all their members/)).toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "Yes" })).toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "No" })).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole("button", { name: "No" }));
    pick("Select admin_2");
    fireEvent.click(trash());
    expect(
      within(dialog()).getByText("Do you want to permanently delete the selected admins?"),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("No changes nothing: no request, the selection stays, the dialog closes", () => {
    mount();
    pick("Select admin_1");
    fireEvent.click(trash());
    fireEvent.click(within(dialog()).getByRole("button", { name: "No" }));
    expect(dialogOpen()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("selected-count")).toHaveTextContent("1 selected");
    expect(screen.getAllByRole("checkbox", { name: /^Select admin_/ })).toHaveLength(3);
  });

  it("Yes sends exactly the selected ids once with an Idempotency-Key, then refreshes the list and clears the selection", async () => {
    fetchMock
      .mockImplementationOnce(() =>
        ok({ deleted: { admins: 2, teams: 3 }, admin_ids: [id(1), id(3)] }),
      )
      .mockImplementationOnce(() => ok({ admins: [admin(2, 0)] }));
    mount();
    pick("Select admin_1");
    pick("Select admin_3");
    fireEvent.click(trash());
    fireEvent.click(within(dialog()).getByRole("button", { name: "Yes" }));
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Select admin_1" })).not.toBeInTheDocument(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("/api/super/admins/delete");
    expect(init.method).toBe("POST");
    expect(bodyOf(0)).toEqual({ adminIds: [id(1), id(3)] });
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/super/admins");

    expect(screen.getByRole("checkbox", { name: "Select admin_2" })).toBeInTheDocument();
    expect(screen.getByTestId("selected-count")).toHaveTextContent("0 selected");
    expect(screen.getByRole("status")).toHaveTextContent("Deleted 2 admins and 3 teams.");
    expect(dialogOpen()).toBe(false);
  });

  it("a double click on Yes sends one request and the buttons are disabled meanwhile", async () => {
    let release!: (r: Response) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((res) => (release = res)))
      .mockImplementationOnce(() => ok({ admins: [] }));
    mount();
    pick("Select admin_2");
    fireEvent.click(trash());
    const yes = within(dialog()).getByRole("button", { name: "Yes" });
    fireEvent.click(yes);
    fireEvent.click(yes);
    fireEvent.click(yes);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(within(dialog()).getByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(within(dialog()).getByRole("button", { name: "No" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Select admin_1" })).toBeDisabled();
    await act(async () => {
      release(
        new Response(
          JSON.stringify({
            ok: true,
            data: { deleted: { admins: 1, teams: 0 }, admin_ids: [id(2)] },
            server_now: 1,
          }),
          {
            status: 200,
          },
        ),
      );
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Deleted 1 admin and 0 teams."),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2); // the delete and the refresh, nothing else
  });

  it("never reports success when the server refuses; the dialog stays open with a fixed message and the selection is kept", async () => {
    fetchMock.mockImplementationOnce(() => err(409, "DELETE_BLOCKED"));
    mount();
    pick("Select admin_1");
    fireEvent.click(trash());
    fireEvent.click(within(dialog()).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(within(dialog()).getByRole("alert")).toBeInTheDocument());
    expect(within(dialog()).getByRole("alert")).toHaveTextContent(/Nothing was deleted/);
    expect(screen.queryByText("SERVER TEXT")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(dialogOpen()).toBe(true);
    expect(screen.getByTestId("selected-count")).toHaveTextContent("1 selected");
    expect(within(dialog()).getByRole("button", { name: "Yes" })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no refresh after a failure
  });

  it("a network failure keeps the same Idempotency-Key for the retry", async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.reject(new TypeError("offline")))
      .mockImplementationOnce(() => ok({ deleted: { admins: 1, teams: 1 }, admin_ids: [id(1)] }))
      .mockImplementationOnce(() => ok({ admins: [admin(2, 0), admin(3, 1)] }));
    mount();
    pick("Select admin_1");
    fireEvent.click(trash());
    fireEvent.click(within(dialog()).getByRole("button", { name: "Yes" }));
    await waitFor(() =>
      expect(within(dialog()).getByRole("alert")).toHaveTextContent(/can't tell whether/),
    );
    fireEvent.click(within(dialog()).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Deleted 1 admin/));
    const key = (n: number) =>
      ((fetchMock.mock.calls[n]![1] as RequestInit).headers as Record<string, string>)[
        "Idempotency-Key"
      ];
    expect(key(0)).toBe(key(1));
  });

  it("NOT_FOUND (already deleted elsewhere) closes the dialog, says nothing was deleted and refreshes the list", async () => {
    fetchMock
      .mockImplementationOnce(() => err(404, "NOT_FOUND"))
      .mockImplementationOnce(() => ok({ admins: [admin(2, 0), admin(3, 1)] }));
    mount();
    pick("Select admin_1");
    fireEvent.click(trash());
    fireEvent.click(within(dialog()).getByRole("button", { name: "Yes" }));
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Select admin_1" })).not.toBeInTheDocument(),
    );
    expect(dialogOpen()).toBe(false);
    expect(screen.getByRole("alert")).toHaveTextContent(/no longer exist, so nothing was deleted/);
    expect(screen.getByTestId("selected-count")).toHaveTextContent("0 selected");
    expect(screen.getByText("admin_2")).toBeInTheDocument();
  });
});

describe("<DeletionScreen kind='teams' />", () => {
  const teams = [team(1), team(2)];

  it("lists teams with code, name, login ID and owner, and uses the team wording and endpoint", async () => {
    fetchMock
      .mockImplementationOnce(() => ok({ deleted: { teams: 1 }, team_ids: [id(101)] }))
      .mockImplementationOnce(() => ok({ teams: [team(2)] }));
    render(<DeletionScreen kind="teams" initialTeams={teams} fetchImpl={f} />);
    expect(screen.getByRole("heading", { name: "Delete Teams" })).toBeInTheDocument();
    expect(screen.getByText("T1 · Team 1")).toBeInTheDocument();
    expect(screen.getByText(/Login ID login_1 · Admin admin_1/)).toBeInTheDocument();
    pick("Select T1 · Team 1");
    fireEvent.click(trash());
    expect(
      within(dialog()).getByText("Do you want to permanently delete the selected team?"),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Deleted 1 team."));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/super/teams/delete");
    expect(bodyOf(0)).toEqual({ teamIds: [id(101)] });
    expect(screen.queryByText("T1 · Team 1")).not.toBeInTheDocument();
  });

  it("DELETE_BLOCKED on teams: fixed message, no server text or database names shown, nothing removed, selection kept, retry possible", async () => {
    const hostile = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: "DELETE_BLOCKED",
              message: "SERVER TEXT",
              // a misbehaving server must still not get these onto the screen
              details: { constraint: "submissions_reviewed_by_fkey", table: "submissions" },
            },
            server_now: 1,
          }),
          { status: 409 },
        ),
      );
    fetchMock.mockImplementationOnce(hostile).mockImplementationOnce(hostile);
    render(<DeletionScreen kind="teams" initialTeams={teams} fetchImpl={f} />);
    pick("Select T1 · Team 1");
    fireEvent.click(trash());
    fireEvent.click(within(dialog()).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(within(dialog()).getByRole("alert")).toBeInTheDocument());
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/super/teams/delete");
    expect(within(dialog()).getByRole("alert")).toHaveTextContent(
      "Nothing was deleted: some of these teams are still referenced by other records.",
    );
    for (const secret of ["SERVER TEXT", "submissions_reviewed_by_fkey", "reviewed_by"]) {
      expect(document.body.textContent).not.toContain(secret);
    }
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(dialogOpen()).toBe(true);
    expect(screen.getByTestId("selected-count")).toHaveTextContent("1 selected");
    // both teams are still listed and no refresh was requested
    expect(screen.getByText("T1 · Team 1")).toBeInTheDocument();
    expect(screen.getByText("T2 · Team 2")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // the dialog is not stuck: Yes can be pressed again and asks the server again
    fireEvent.click(within(dialog()).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodyOf(1)).toEqual({ teamIds: [id(101)] });
    await waitFor(() =>
      expect(within(dialog()).getByRole("alert")).toHaveTextContent(/Nothing was deleted/),
    );
  });

  it("plural wording for several teams", () => {
    render(<DeletionScreen kind="teams" initialTeams={teams} fetchImpl={f} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    fireEvent.click(trash());
    expect(
      within(dialog()).getByText("Do you want to permanently delete the selected teams?"),
    ).toBeInTheDocument();
  });
});

describe("empty, error and loading states", () => {
  it("shows an empty state (and no trash enabled) when there is nothing to delete", () => {
    render(<DeletionScreen kind="teams" initialTeams={[]} fetchImpl={f} />);
    expect(screen.getByTestId("deletion-empty")).toHaveTextContent("There are no teams to delete.");
    expect(screen.queryByRole("button", { name: /^Delete selected/ })).not.toBeInTheDocument();
  });

  it("shows an error state, not an empty list, when the list could not be read, and recovers on Try again", async () => {
    fetchMock.mockImplementationOnce(() => ok({ admins: [admin(1)] }));
    render(<DeletionScreen kind="admins" initialAdmins={null} fetchImpl={f} />);
    expect(screen.getByTestId("deletion-error")).toBeInTheDocument();
    expect(screen.queryByTestId("deletion-empty")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Select admin_1" })).toBeInTheDocument(),
    );
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/super/admins");
  });

  it("stays in the error state when the retry fails too", async () => {
    fetchMock.mockImplementationOnce(() => err(503, "SERVICE_UNAVAILABLE"));
    render(<DeletionScreen kind="admins" initialAdmins={null} fetchImpl={f} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());
    expect(screen.getByTestId("deletion-error")).toBeInTheDocument();
  });
});

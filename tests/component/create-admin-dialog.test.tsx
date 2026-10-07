// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateAdminNav } from "@/components/provisioning/create-admin-dialog";

const fetchMock = vi.fn();
beforeEach(() => fetchMock.mockReset());

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

function open() {
  render(<CreateAdminNav fetchImpl={fetchMock as unknown as typeof fetch} />);
  fireEvent.click(screen.getByRole("button", { name: "Create admin" }));
}
function fill(v = { u: " alice ", p: "alice-password-1", c: "alice-password-1" }) {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: v.u } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: v.p } });
  fireEvent.change(screen.getByLabelText("Retype Password"), { target: { value: v.c } });
}
const create = () => fireEvent.click(screen.getByRole("button", { name: "Create" }));

describe("<CreateAdminNav />", () => {
  it("opens a dialog titled 'Create a New Admin' with exactly Username, Password, Retype Password and the two buttons", () => {
    open();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Create a New Admin" })).toBeInTheDocument();
    expect(within(dialog).getAllByRole("textbox")).toHaveLength(1); // the username; the two passwords are masked
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Retype Password")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go Back" })).toBeInTheDocument();
    // nothing the browser could use to choose a role or an account state
    expect(dialog.querySelectorAll("input")).toHaveLength(3);
  });

  it("Go Back only closes the dialog: no request is made", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Go Back" }));
    expect(screen.getByRole("dialog", { hidden: true })).not.toHaveAttribute("open");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates before sending: empty form, short password, mismatch", () => {
    open();
    create();
    expect(screen.getByText(/Use 3–64 letters/)).toBeInTheDocument();
    fill({ u: "alice", p: "short", c: "short" });
    create();
    expect(screen.getByText("Use 10–72 characters.")).toBeInTheDocument();
    fill({ u: "alice", p: "alice-password-1", c: "alice-password-2" });
    create();
    expect(screen.getByText("The passwords don't match.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the trimmed username with an Idempotency-Key and shows success only after the server confirmed", async () => {
    fetchMock.mockReturnValue(ok({ admin: { username: "alice" } }));
    open();
    fill();
    create();
    await screen.findByRole("heading", { name: "Admin created" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/super/admins");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      username: "alice",
      password: "alice-password-1",
      confirmPassword: "alice-password-1",
    });
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(screen.getByRole("status")).toHaveTextContent("alice");
    expect(screen.getByRole("status").textContent).not.toContain("alice-password-1");
  });

  it("a double click sends ONE request, and the form is disabled while it is in flight", async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    open();
    fill();
    const button = screen.getByRole("button", { name: "Create" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.submit(screen.getByLabelText("Username").closest("form")!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Username")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Go Back" })).toBeDisabled();
    resolve(
      new Response(JSON.stringify({ ok: true, data: { admin: {} }, server_now: 1 }), {
        status: 200,
      }),
    );
    await screen.findByRole("heading", { name: "Admin created" });
  });

  it("shows a username-taken error on the field, never the server's text, and allows another try with a NEW key", async () => {
    fetchMock
      .mockReturnValueOnce(err(409, "USERNAME_TAKEN"))
      .mockReturnValueOnce(ok({ admin: {} }));
    open();
    fill();
    create();
    await screen.findByText("That username is already taken.");
    expect(screen.queryByText("SERVER TEXT")).toBeNull();
    expect(screen.getByLabelText("Username")).toHaveAttribute("aria-invalid", "true");
    const firstKey = (
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>
    )["Idempotency-Key"];
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alice2" } });
    create();
    await screen.findByRole("heading", { name: "Admin created" });
    const secondKey = (
      (fetchMock.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>
    )["Idempotency-Key"];
    expect(secondKey).not.toBe(firstKey);
  });

  it("an unknown outcome (network error) is retried with the SAME key; a definitive refusal is not", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockReturnValueOnce(ok({ admin: {} }));
    open();
    fill();
    create();
    await screen.findByText(/Couldn't reach the server/);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    create();
    await screen.findByRole("heading", { name: "Admin created" });
    const key = (i: number) =>
      ((fetchMock.mock.calls[i] as [string, RequestInit])[1].headers as Record<string, string>)[
        "Idempotency-Key"
      ];
    expect(key(1)).toBe(key(0));
  });

  it.each([
    [403, "FORBIDDEN", "You are not allowed to do that."],
    [401, "UNAUTHENTICATED", "Your session has ended. Sign in again to continue."],
    [503, "SERVICE_UNAVAILABLE", "Something went wrong on our side. Please try again."],
    [500, "SOMETHING_NEW", "Something went wrong on our side. Please try again."],
  ])("maps %i %s to fixed wording", async (status, code, text) => {
    fetchMock.mockReturnValue(err(status, code));
    open();
    fill();
    create();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(text));
    expect(document.body.textContent).not.toContain("SERVER TEXT");
  });

  it("clears the password fields after success (the form is rebuilt) and when reopened", async () => {
    fetchMock.mockReturnValue(ok({ admin: {} }));
    open();
    fill();
    create();
    await screen.findByRole("heading", { name: "Admin created" });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Create admin" }));
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Retype Password")).toHaveValue("");
    expect(screen.getByLabelText("Username")).toHaveValue("");
  });
});

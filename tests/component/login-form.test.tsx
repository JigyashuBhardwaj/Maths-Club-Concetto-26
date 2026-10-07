// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LoginForm } from "@/components/auth/login-form";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ok = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ ok: true, data, server_now: 1 }), { status: 200 }));
const err = (status: number, code: string, details?: unknown) =>
  Promise.resolve(
    new Response(
      JSON.stringify({ ok: false, error: { code, message: "m", details }, server_now: 1 }),
      {
        status,
      },
    ),
  );

function typeParticipant(values = { id: " team_a ", pw: "pw-secret", adm: " 23je0001 " }) {
  fireEvent.change(screen.getByLabelText("Team Login ID"), { target: { value: values.id } });
  fireEvent.change(screen.getByLabelText("Team Password"), { target: { value: values.pw } });
  fireEvent.change(screen.getByLabelText("Admission Number"), { target: { value: values.adm } });
}
const submit = () => fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

describe("<LoginForm role='participant' />", () => {
  it("asks for team login ID, team password and admission number (the password is masked)", () => {
    render(<LoginForm role="participant" />);
    expect(screen.getByLabelText("Team Login ID")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Team Password")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Admission Number")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).toBeNull();
  });

  it("posts the three values to the participant endpoint and goes to /participant on success", async () => {
    const navigate = vi.fn();
    fetchMock.mockReturnValue(ok({ role: "PARTICIPANT" }));
    render(<LoginForm role="participant" navigate={navigate} />);
    typeParticipant();
    submit();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/participant"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/participant/login");
    expect(JSON.parse(init.body as string)).toEqual({
      teamLoginId: "team_a", // trimmed by the shared schema
      password: "pw-secret", // never trimmed
      admissionNo: "23je0001",
    });
  });

  it("shows the generic message for wrong credentials, never echoes input, and re-enables the form", async () => {
    const navigate = vi.fn();
    fetchMock.mockReturnValue(err(401, "UNAUTHENTICATED"));
    render(<LoginForm role="participant" navigate={navigate} />);
    typeParticipant();
    submit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Those details don't match an account");
    expect(alert.textContent).not.toContain("pw-secret");
    expect(alert.textContent).not.toContain("23je0001");
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
    expect(screen.getByLabelText("Team Login ID")).toBeEnabled();
  });

  it.each([
    [423, "COMPETITION_NOT_RUNNING", /isn't open for sign-in/],
    [429, "RATE_LIMITED", /Too many attempts/],
    [400, "VALIDATION_FAILED", /check the details/],
    [403, "FORBIDDEN", /blocked/],
    [503, "SERVICE_UNAVAILABLE", /temporarily unavailable/],
  ])("maps %s %s to a safe message", async (status, code, expected) => {
    fetchMock.mockReturnValue(err(status, code, { retry_after_seconds: 30 }));
    render(<LoginForm role="participant" navigate={vi.fn()} />);
    typeParticipant();
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
  });

  it("reports a network failure and a non-JSON server error without leaking anything", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<LoginForm role="participant" navigate={vi.fn()} />);
    typeParticipant();
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/reach the server/);

    fetchMock.mockReturnValueOnce(
      Promise.resolve(new Response("<html>stack trace</html>", { status: 500 })),
    );
    submit();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/temporarily unavailable/),
    );
    expect(screen.getByRole("alert").textContent).not.toContain("stack");
  });

  it("validates in the form first: nothing is sent while a field is empty or too long", () => {
    render(<LoginForm role="participant" navigate={vi.fn()} />);
    submit();
    expect(screen.getByText("Enter your Team Login ID.")).toBeInTheDocument();
    expect(screen.getByText("Enter your password.")).toBeInTheDocument();
    expect(screen.getByText("Enter your admission number.")).toBeInTheDocument();
    expect(screen.getByLabelText("Team Login ID")).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(screen.getByLabelText("Team Password"), { target: { value: "x".repeat(73) } });
    submit();
    expect(screen.getByText("That password is too long.")).toBeInTheDocument();
    // whitespace-only is empty after trimming
    fireEvent.change(screen.getByLabelText("Team Login ID"), { target: { value: "   " } });
    submit();
    expect(screen.getByText("Enter your Team Login ID.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends one request per attempt even if the form is submitted repeatedly, and disables itself meanwhile", async () => {
    const navigate = vi.fn();
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    render(<LoginForm role="participant" navigate={navigate} />);
    typeParticipant();
    submit();
    fireEvent.submit(screen.getByRole("button", { name: /signing in/i }).closest("form")!);
    fireEvent.submit(screen.getByRole("button", { name: /signing in/i }).closest("form")!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    expect(screen.getByLabelText("Team Login ID")).toBeDisabled();
    resolve(
      new Response(JSON.stringify({ ok: true, data: { role: "PARTICIPANT" }, server_now: 1 })),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
  });

  it("does not navigate when a 'success' names a role the app does not know", async () => {
    const navigate = vi.fn();
    fetchMock.mockReturnValue(ok({ role: "ROOT" }));
    render(<LoginForm role="participant" navigate={navigate} />);
    typeParticipant();
    submit();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps credentials out of web storage", async () => {
    fetchMock.mockReturnValue(ok({ role: "PARTICIPANT" }));
    render(<LoginForm role="participant" navigate={vi.fn()} />);
    typeParticipant();
    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).toBe("{}");
  });
});

describe.each(["admin", "superadmin"] as const)("<LoginForm role=%s />", (role) => {
  it("asks for username and password and posts to the staff endpoint", async () => {
    const navigate = vi.fn();
    fetchMock.mockReturnValue(ok({ role: "ADMIN" }));
    render(<LoginForm role={role} navigate={navigate} />);
    expect(screen.queryByLabelText("Admission Number")).toBeNull();
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "asha" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
    submit();
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/staff/login");
    // no role is ever sent: the server decides
    expect(JSON.parse(init.body as string)).toEqual({ username: "asha", password: "pw" });
  });

  it.each([
    ["ADMIN", "/admin"],
    ["SUPER_ADMIN", "/superadmin"],
  ])(
    "goes where the SERVER's role %s belongs (%s), whichever page the form is on",
    async (serverRole, home) => {
      const navigate = vi.fn();
      fetchMock.mockReturnValue(ok({ role: serverRole }));
      render(<LoginForm role={role} navigate={navigate} />);
      fireEvent.change(screen.getByLabelText("Username"), { target: { value: "u" } });
      fireEvent.change(screen.getByLabelText("Password"), { target: { value: "p" } });
      submit();
      await waitFor(() => expect(navigate).toHaveBeenCalledWith(home));
    },
  );

  it("validates before sending", () => {
    render(<LoginForm role={role} navigate={vi.fn()} />);
    submit();
    expect(screen.getByText("Enter your username.")).toBeInTheDocument();
    expect(screen.getByText("Enter your password.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

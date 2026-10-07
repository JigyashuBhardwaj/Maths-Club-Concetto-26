// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SignOutButton } from "@/components/auth/sign-out-button";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("<SignOutButton />", () => {
  it("revokes the session through POST /api/auth/logout, then goes to the sign-in page", async () => {
    const navigate = vi.fn();
    fetchMock.mockReturnValue(
      Promise.resolve(new Response(JSON.stringify({ ok: true, data: {}, server_now: 1 }))),
    );
    render(<SignOutButton redirectTo="/login/admin" navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login/admin"));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/logout");
    expect(init.method).toBe("POST");
  });

  it("stays on the page and says so when the server could not revoke the session", async () => {
    const navigate = vi.fn();
    fetchMock.mockReturnValue(
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "SERVICE_UNAVAILABLE", message: "m" },
            server_now: 1,
          }),
          { status: 503 },
        ),
      ),
    );
    render(<SignOutButton redirectTo="/login/participant" navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't sign out. Please try again.",
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled(); // can be retried
  });

  it("also treats a network failure as 'not signed out'", async () => {
    const navigate = vi.fn();
    fetchMock.mockRejectedValue(new TypeError("offline"));
    render(<SignOutButton redirectTo="/login/participant" navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("sends one request however often it is clicked while in flight", async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    render(<SignOutButton redirectTo="/login/admin" navigate={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Sign out" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Signing out…" })).toBeDisabled();
    resolve(new Response(JSON.stringify({ ok: true, data: {}, server_now: 1 })));
  });
});

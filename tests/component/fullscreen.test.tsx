// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LoginNotice } from "@/components/auth/login-notice";
import { EntryGate } from "@/components/game/entry-gate";
import { useFullscreen } from "@/components/game/fullscreen-provider";
import { QuestionPage } from "@/components/question/question-page";
import { buildClearedSessionCookie, SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import { createLogoutHandler, type AuthDeps } from "@/lib/auth/handlers";
import { generateSessionToken } from "@/lib/auth/session";
import { DbError, type Db } from "@/lib/db/adapter";
import { resetFullscreenEnded } from "@/lib/fullscreen/session-end";

import { makeFullscreenDriver } from "./support/fullscreen";
import { Game, makeClient, NOW, question, snapshot } from "./support/game";

// The WebGL background is not what is under test (and jsdom has no WebGL).
vi.mock("@/components/home/home-stage", () => ({
  HomeStage: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
const client = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock("@/lib/gameplay/client", () => client);
const c = makeClient();

/**
 * B19. The browser's Fullscreen API is a MOCK here (jsdom has none): these tests prove the application's rules: when a
 * request is made, when the competition may start, when leaving fullscreen ends the session, and that it ends it once.
 * The real browser is covered by tests/e2e/fullscreen.spec.ts.
 */
const NOT_STARTED = {
  team: { status: "NOT_STARTED", started_at: null, ends_at: null, remaining_seconds: 14400 },
} as const;
let current = snapshot();

beforeEach(() => {
  Object.assign(client, {
    fetchTeamState: c.fetchTeamState,
    sendHeartbeat: c.sendHeartbeat,
    enterCompetition: c.enterCompetition,
    fetchQuestion: c.fetchQuestion,
    enterQuestionCall: c.enterQuestionCall,
    saveDraftCall: c.saveDraftCall,
  });
  for (const f of [
    c.fetchTeamState,
    c.enterCompetition,
    c.fetchQuestion,
    c.enterQuestionCall,
    c.saveDraftCall,
  ])
    f.mockReset();
  c.fetchTeamState.mockImplementation(async () => c.ok(current));
  c.saveDraftCall.mockResolvedValue(c.ok({ version: 1, updated_by_slot: 1, updated_at: NOW }));
  resetFullscreenEnded();
  window.sessionStorage.clear(); // the reload hint is per tab; every test starts on a fresh tab
});
afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

const logoutOk = () =>
  vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, data: {}, server_now: 1 }), { status: 200 }),
  );
const gate = () => document.querySelector("dialog.entry-gate:not(.fullscreen-exit)");
const exitNotice = () => document.querySelector("dialog.fullscreen-exit");

function Probe() {
  const f = useFullscreen();
  return <p data-testid="probe">{`${f.required}|${f.established}|${f.ready}|${f.ending}`}</p>;
}

function mount(
  initial: ReturnType<typeof snapshot>,
  h = makeFullscreenDriver(),
  extra: { fetchImpl?: typeof fetch; navigate?: (u: string) => void; children?: ReactNode } = {},
) {
  current = initial;
  const navigate = extra.navigate ?? vi.fn();
  const fetchImpl = extra.fetchImpl ?? logoutOk();
  const ui = (
    <Game
      initial={initial}
      passedGate={false}
      fullscreen={h.driver}
      navigate={navigate}
      fetchImpl={fetchImpl as unknown as typeof fetch}
    >
      <EntryGate />
      <Probe />
      {extra.children}
    </Game>
  );
  return { h, navigate, fetchImpl, ...render(ui) };
}
const press = async (name: string) => {
  fireEvent.click(await screen.findByRole("button", { name }));
};
const probe = () => screen.getByTestId("probe").textContent;

describe("entering fullscreen is part of the entry action", () => {
  it("a not-started team: the click requests fullscreen FIRST and starts the team only after it succeeded", async () => {
    const order: string[] = [];
    const h = makeFullscreenDriver();
    const real = h.request.getMockImplementation()!;
    h.request.mockImplementationOnce(async () => {
      order.push("fullscreen");
      return real();
    });
    c.enterCompetition.mockImplementation(async () => {
      order.push("start");
      return c.ok(snapshot({ version: 2 }));
    });
    mount(snapshot(NOT_STARTED), h);
    await press("Enter competition");
    await waitFor(() => expect(c.enterCompetition).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["fullscreen", "start"]);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("the entry screen explains the fullscreen requirement before anything is pressed, and requests nothing on load", async () => {
    const { h } = mount(snapshot(NOT_STARTED));
    const text = (await screen.findByRole("heading", { name: "Enter the competition" })).closest(
      "dialog",
    )!.textContent!;
    expect(text).toMatch(/must enter fullscreen before you start/);
    expect(text).toMatch(/timer starts only after fullscreen succeeds/);
    expect(text).toMatch(/exit\s+fullscreen while the competition is running, your session ends/);
    expect(h.request).not.toHaveBeenCalled();
    expect(c.enterCompetition).not.toHaveBeenCalled();
    expect(c.enterQuestionCall).not.toHaveBeenCalled();
  });

  it("a rejected request does not start the team, shows a useful error, and the button can be pressed again", async () => {
    const h = makeFullscreenDriver({ mode: "reject" });
    mount(snapshot(NOT_STARTED), h);
    await press("Enter competition");
    expect(await screen.findByRole("alert")).toHaveTextContent(/didn't allow fullscreen/);
    expect(c.enterCompetition).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Enter competition" })).toBeEnabled();
    expect(probe()).toBe("false|false|false|false");
    // the retry works once the browser allows it
    h.set({ mode: "ok" });
    c.enterCompetition.mockResolvedValue(c.ok(snapshot({ version: 2 })));
    await press("Enter competition");
    await waitFor(() => expect(c.enterCompetition).toHaveBeenCalledTimes(1));
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it("a browser without fullscreen support cannot start the team, and says why", async () => {
    mount(snapshot(NOT_STARTED), makeFullscreenDriver({ supported: false }));
    await press("Enter competition");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /can't show the competition in fullscreen/,
    );
    expect(c.enterCompetition).not.toHaveBeenCalled();
  });

  it("a request that resolves without really entering fullscreen is a failure too", async () => {
    mount(snapshot(NOT_STARTED), makeFullscreenDriver({ mode: "noop" }));
    await press("Enter competition");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Fullscreen didn't start/);
    expect(c.enterCompetition).not.toHaveBeenCalled();
  });

  it("repeated clicks make ONE fullscreen request and ONE start call", async () => {
    const h = makeFullscreenDriver();
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const real = h.request.getMockImplementation()!;
    h.request.mockImplementation(async () => {
      await slow;
      return real();
    });
    c.enterCompetition.mockResolvedValue(c.ok(snapshot({ version: 2 })));
    mount(snapshot(NOT_STARTED), h);
    const button = await screen.findByRole("button", { name: "Enter competition" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    release();
    await waitFor(() => expect(c.enterCompetition).toHaveBeenCalledTimes(1));
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("a team that is already running (a teammate who signs in later, or a reload): the same gate, fullscreen only, nothing is started", async () => {
    const { h } = mount(snapshot());
    expect(
      await screen.findByRole("heading", { name: "Enter fullscreen to continue" }),
    ).toBeInTheDocument();
    await press("Enter fullscreen");
    await waitFor(() => expect(gate()).toBeNull());
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(c.enterCompetition).not.toHaveBeenCalled();
    expect(probe()).toBe("true|true|true|false");
  });

  it("a team that has finished (final submission, ended, time up) is not asked for fullscreen at all", async () => {
    for (const status of ["FINAL_SUBMITTED", "ENDED", "DISQUALIFIED"] as const) {
      const { unmount } = mount(snapshot({ team: { status } }));
      await waitFor(() => expect(probe()).toBe("false|false|true|false"));
      expect(gate()).toBeNull();
      unmount();
    }
  });
});

describe("a question is not activated, or read, before fullscreen is established", () => {
  const available = () =>
    snapshot({ themes: { A: { q: ["AVAILABLE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"] } } });

  it("Q1 stays unactivated behind the gate and is entered exactly once after the participant passes it", async () => {
    c.enterQuestionCall.mockResolvedValue(c.ok(question({ state: "ACTIVE" })));
    const { h } = mount(available(), makeFullscreenDriver(), {
      children: <QuestionPage theme="A" n={1} />,
    });
    await screen.findByRole("heading", { name: "Enter fullscreen to continue" });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.enterQuestionCall).not.toHaveBeenCalled();
    expect(c.fetchQuestion).not.toHaveBeenCalled();
    await press("Enter fullscreen");
    expect(await screen.findByText("Find the value of x.")).toBeInTheDocument();
    expect(c.enterQuestionCall).toHaveBeenCalledTimes(1);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("the deadline on screen is the server's: the page adopts what the enter call returned", async () => {
    c.enterQuestionCall.mockResolvedValue(
      c.ok(question({ state: "ACTIVE", deadline: NOW + 200_000, remaining_seconds: 200 })),
    );
    mount(available(), makeFullscreenDriver(), { children: <QuestionPage theme="A" n={1} /> });
    await press("Enter fullscreen");
    await screen.findByText("Find the value of x.");
    expect(c.enterQuestionCall.mock.calls[0]![0]).toBe(1); // the question id; no time, no deadline, no clock is sent
    expect(c.enterQuestionCall.mock.calls[0]).toHaveLength(2); // (id, idempotency key)
  });

  it("an ACTIVE question's text is not even fetched until fullscreen is established", async () => {
    c.fetchQuestion.mockResolvedValue(c.ok(question({ state: "ACTIVE" })));
    mount(
      snapshot({ themes: { A: { q: ["ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"] } } }),
      makeFullscreenDriver(),
      { children: <QuestionPage theme="A" n={1} /> },
    );
    await screen.findByRole("heading", { name: "Enter fullscreen to continue" });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.fetchQuestion).not.toHaveBeenCalled();
    await press("Enter fullscreen");
    await waitFor(() => expect(c.fetchQuestion).toHaveBeenCalledTimes(1));
  });
});

describe("leaving fullscreen while the competition runs ends the session", () => {
  async function started(extra: Parameters<typeof mount>[2] = {}) {
    const m = mount(snapshot(), makeFullscreenDriver(), extra);
    await press("Enter fullscreen");
    await waitFor(() => expect(probe()).toBe("true|true|true|false"));
    return m;
  }

  it("calls the existing logout endpoint ONCE (POST, no body, no identity), blocks the page, then goes to the sign-in page with the reason", async () => {
    const { h, fetchImpl, navigate } = await started();
    expect(fetchImpl).not.toHaveBeenCalled(); // entering fullscreen did not sign anyone out
    act(() => h.exit());
    expect(exitNotice()).toHaveAttribute("open");
    expect(exitNotice()!.textContent).toMatch(/session is ending because fullscreen was exited/);
    expect(gate()).toBeNull(); // the exit notice replaces the gate
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/auth/logout");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined(); // nothing about who the participant is: the server uses the cookie
    expect(init.credentials).toBe("same-origin");
    expect(navigate).toHaveBeenCalledWith("/login/participant?notice=fullscreen");
    expect(probe()).toBe("true|false|false|true");
  });

  it("Escape, a browser control or anything else that leaves fullscreen is the same event", async () => {
    // the browser reports every way out as `fullscreenchange` with the document no longer fullscreen
    const { h, fetchImpl } = await started();
    act(() => h.exit());
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
  });

  it("duplicate fullscreenchange events and later renders produce no second logout", async () => {
    const { h, fetchImpl, navigate } = await started();
    act(() => {
      h.exit();
      h.duplicateEvent();
      h.duplicateEvent();
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    act(() => {
      h.duplicateEvent();
      h.exit();
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("a page that loads outside fullscreen is NOT an exit: nothing is logged out until the participant has entered and left", async () => {
    const { h, fetchImpl } = mount(snapshot());
    await screen.findByRole("heading", { name: "Enter fullscreen to continue" });
    act(() => h.duplicateEvent()); // an event while never established
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(probe()).toBe("true|false|false|false");
  });

  it("before the competition has started, leaving fullscreen does not log anyone out; entering again works", async () => {
    c.enterCompetition.mockResolvedValue(c.fail("COMPETITION_PAUSED", 423));
    const { h, fetchImpl } = mount(snapshot(NOT_STARTED));
    await press("Enter competition"); // fullscreen succeeds, the start is refused
    await screen.findByRole("alert");
    expect(h.isActive()).toBe(true);
    act(() => h.exit());
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(exitNotice()).toBeNull();
    expect(gate()).not.toBeNull();
    expect(probe()).toBe("false|false|false|false");
  });

  it("a teammate starting the team while this participant waits outside fullscreen does not log them out; they are asked to enter fullscreen", async () => {
    c.enterCompetition.mockResolvedValue(c.fail("COMPETITION_PAUSED", 423));
    const { h, fetchImpl } = mount(snapshot(NOT_STARTED));
    await press("Enter competition"); // fullscreen succeeds, the start is refused
    await screen.findByRole("alert");
    act(() => h.exit()); // left before the team started: not enforced, so just un-established
    current = snapshot({ version: 3 }); // a teammate started the team; this page's next refresh brings it
    await act(async () => {
      fireEvent.focus(window);
      await new Promise((r) => setTimeout(r, 30));
    });
    await screen.findByRole("heading", { name: "Enter fullscreen to continue" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(exitNotice()).toBeNull();
    expect(probe()).toBe("true|false|false|false");
  });

  it("after a legitimate finish (final submission, or the team's time up) leaving fullscreen is harmless", async () => {
    const { h, fetchImpl } = await started();
    // the server's snapshot says the team is frozen (final submission), then the participant leaves fullscreen
    const done = snapshot({ team: { status: "FINAL_SUBMITTED" }, version: 9 });
    current = done;
    await act(async () => {
      fireEvent.focus(window); // the provider re-reads the server's snapshot on focus
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => expect(probe()).toMatch(/^false\|/));
    act(() => h.exit());
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(exitNotice()).toBeNull();
  });

  it("when the team's time has run out locally (the snapshot is not yet updated), leaving fullscreen is harmless", async () => {
    const m = mount(
      snapshot({ team: { ends_at: NOW + 20_000, remaining_seconds: 20, expired: false } }),
    );
    await press("Enter fullscreen");
    await waitFor(() => expect(probe()).toBe("true|true|true|false"));
    // the server-aligned clock passes ends_at: the page is frozen even though the snapshot still says RUNNING
    const real = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => real() + 60_000);
    act(() => m.h.exit());
    await new Promise((r) => setTimeout(r, 30));
    expect(m.fetchImpl).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("listeners: exactly one, still one after rerenders and React StrictMode double effects, none after unmount", async () => {
    const h = makeFullscreenDriver();
    function Wrapper() {
      const [n, setN] = useState(0);
      return (
        <Game
          initial={snapshot()}
          passedGate={false}
          fullscreen={h.driver}
          navigate={vi.fn()}
          fetchImpl={logoutOk() as unknown as typeof fetch}
        >
          <button onClick={() => setN(n + 1)}>rerender {n}</button>
        </Game>
      );
    }
    const { unmount } = render(
      <StrictMode>
        <Wrapper />
      </StrictMode>,
    );
    expect(h.listenerCount()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /rerender/ }));
    fireEvent.click(screen.getByRole("button", { name: /rerender/ }));
    expect(h.listenerCount()).toBe(1);
    unmount();
    expect(h.listenerCount()).toBe(0);
  });

  it("a failed logout never claims success: the page stays blocked, nothing loops, and the retry is the participant's", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, data: {}, server_now: 1 }), { status: 200 }),
      );
    const { h, navigate } = await started({ fetchImpl: fetchImpl as unknown as typeof fetch });
    act(() => h.exit());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn't confirm that your session ended/);
    expect(alert).not.toHaveTextContent(/signed out|has ended/i);
    expect(navigate).not.toHaveBeenCalled();
    expect(exitNotice()).toHaveAttribute("open"); // still blocked
    // more fullscreen noise and time passing: no automatic retry
    act(() => h.duplicateEvent());
    await new Promise((r) => setTimeout(r, 60));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // the participant retries
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a logout the server refuses (HTTP 5xx or 403) is also a failure, not a success", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: { code: "FORBIDDEN" } }), { status: 403 }),
    );
    const { h, navigate } = await started({ fetchImpl: fetchImpl as unknown as typeof fetch });
    act(() => h.exit());
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("once the session is ending, fullscreen can't be re-established and no question is entered or read", async () => {
    c.fetchQuestion.mockResolvedValue(c.ok(question({ state: "ACTIVE" })));
    const { h } = await started({ children: <QuestionPage theme="A" n={1} /> });
    act(() => h.exit());
    expect(probe()).toBe("true|false|false|true");
    expect(c.enterQuestionCall).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Enter fullscreen" })).toBeNull();
  });
});

describe("the sign-in page says why", () => {
  it("shows the fixed sentence for ?notice=fullscreen and nothing for anything else (the value is never rendered)", () => {
    window.history.replaceState(null, "", "/login/participant?notice=fullscreen");
    const first = render(<LoginNotice />);
    expect(screen.getByTestId("login-notice")).toHaveTextContent(
      "Your session ended because you exited fullscreen. Sign in again to continue.",
    );
    first.unmount();
    for (const hostile of [
      "<img src=x onerror=alert(1)>",
      "toString",
      "__proto__",
      "FULLSCREEN",
      "",
    ]) {
      window.history.replaceState(
        null,
        "",
        `/login/participant?notice=${encodeURIComponent(hostile)}`,
      );
      const r = render(<LoginNotice />);
      expect(screen.queryByTestId("login-notice")).toBeNull();
      expect(r.container.innerHTML).toBe("");
      r.unmount();
    }
  });
});

/** Shared by the B19-r2 blocks below: a participant who is in fullscreen with a running team. */
async function startedRunning(extra: Parameters<typeof mount>[2] = {}, initial = snapshot()) {
  const m = mount(initial, makeFullscreenDriver(), extra);
  await press("Enter fullscreen");
  await waitFor(() => expect(probe()).toBe("true|true|true|false"));
  return m;
}
const HINT = "mc26.fullscreen.member";
const MEMBER = snapshot().me.member_id;
const calls = (f: unknown) => (f as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];

describe("B19-r2: the logout is only ever confirmed by the server (real logout handler, injected database failure)", () => {
  const ORIGIN = "https://concetto.example";
  /** The REAL POST /api/auth/logout handler over a database that fails, or answers garbage, until told otherwise. */
  function realLogout() {
    const token = generateSessionToken();
    const state = { db: "fail" as "fail" | "garbage" | "ok", rpcCalls: 0 };
    const db: Db = {
      async rpc(fn) {
        state.rpcCalls += 1;
        if (state.db === "fail") throw new DbError(fn, "57014");
        if (state.db === "garbage") return { unexpected: true };
        return { ok: true, revoked: true };
      },
    };
    const deps: AuthDeps = {
      db: () => db,
      env: () => ({
        APP_ORIGIN: ORIGIN,
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
        SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40),
        SESSION_TOKEN_PEPPER: "pepper-for-tests-0123456789abcdef0123",
      }),
      now: () => NOW,
    };
    const handler = createLogoutHandler(deps);
    const responses: Response[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const res = await handler(
        new Request(new URL(url, ORIGIN), {
          method: init?.method,
          headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE_NAME}=${token}` },
        }),
      );
      responses.push(res.clone());
      return res;
    });
    return {
      state,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      responses,
      fetchSpy: fetchImpl,
    };
  }

  it("when the database cannot revoke the session the page does NOT redirect or claim a sign-out; a retry after recovery does", async () => {
    const real = realLogout();
    const { h, navigate } = await startedRunning({ fetchImpl: real.fetchImpl });
    act(() => h.exit());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn't confirm that your session ended/);
    expect(alert).not.toHaveTextContent(/signed out|has ended|signed in again/i);
    expect(navigate).not.toHaveBeenCalled();
    expect(exitNotice()).toHaveAttribute("open"); // still blocked
    // what the server really said: a generic 503, and it did not clear the cookie it had not revoked
    expect(real.responses).toHaveLength(1);
    expect(real.responses[0]!.status).toBe(503);
    expect(real.responses[0]!.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify(await real.responses[0]!.json())).not.toMatch(/57014|revoke_session/);
    // the hint that ends the session on the next load is kept: the session is not known to be dead
    expect(window.sessionStorage.getItem(HINT)).toBe(MEMBER);
    // no automatic retry
    await new Promise((r) => setTimeout(r, 60));
    expect(real.fetchSpy).toHaveBeenCalledTimes(1);

    real.state.db = "ok"; // the database recovered; the participant presses the button
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith("/login/participant?notice=fullscreen");
    expect(real.responses[1]!.status).toBe(200);
    expect(real.responses[1]!.headers.get("set-cookie")).toBe(buildClearedSessionCookie());
    expect(window.sessionStorage.getItem(HINT)).toBeNull(); // only the confirmed logout drops it
  });

  it("a database answer that is not a confirmation is also a failure for the page (the handler refuses to call it success)", async () => {
    const real = realLogout();
    real.state.db = "garbage";
    const { h, navigate } = await startedRunning({ fetchImpl: real.fetchImpl });
    act(() => h.exit());
    await screen.findByRole("alert");
    expect(real.responses[0]!.status).toBe(503);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a 200 whose body is not the API's success envelope is not a confirmation either", async () => {
    for (const body of ["", "{}", "not json", JSON.stringify({ ok: false })]) {
      window.sessionStorage.clear(); // each round is a fresh tab
      const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
      const { h, navigate, unmount } = await startedRunning({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      act(() => h.exit());
      await screen.findByRole("alert");
      expect(navigate).not.toHaveBeenCalled();
      unmount();
    }
  });
});

describe("B19-r2: a reload, a typed address or a closed tab also leaves fullscreen", () => {
  const hide = () => window.dispatchEvent(new Event("pagehide"));

  it("while fullscreen is enforced, the unloading page asks the server to end the session: one keepalive POST, no body, no identity", async () => {
    const { fetchImpl, navigate } = await startedRunning();
    act(() => hide());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = calls(fetchImpl)[0]!;
    expect(url).toBe("/api/auth/logout");
    expect(init).toEqual({ method: "POST", credentials: "same-origin", keepalive: true });
    expect(navigate).not.toHaveBeenCalled(); // the page is going away anyway; it never claims an outcome
    // the hint stays: the outcome is unknown, so the next load must still end the session if it is still alive
    expect(window.sessionStorage.getItem(HINT)).toBe(MEMBER);
  });

  it("a request that throws or is rejected while unloading is swallowed (the page is dying; nothing can be done)", async () => {
    const throwing = vi.fn(() => {
      throw new Error("blocked");
    });
    const m1 = await startedRunning({ fetchImpl: throwing as unknown as typeof fetch });
    expect(() => act(() => hide())).not.toThrow();
    m1.unmount();
    window.sessionStorage.clear();
    const rejecting = vi.fn(async () => Promise.reject(new TypeError("network")));
    await startedRunning({ fetchImpl: rejecting as unknown as typeof fetch });
    expect(() => act(() => hide())).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
  });

  it("nothing is sent by a page that never entered fullscreen, before the team started, after a legitimate finish, or once already ending", async () => {
    // never entered
    const a = mount(snapshot());
    await screen.findByRole("heading", { name: "Enter fullscreen to continue" });
    act(() => hide());
    expect(a.fetchImpl).not.toHaveBeenCalled();
    a.unmount();
    window.sessionStorage.clear();
    // team not started (fullscreen established for the start, the start refused)
    c.enterCompetition.mockResolvedValue(c.fail("COMPETITION_PAUSED", 423));
    const b = mount(snapshot(NOT_STARTED));
    await press("Enter competition");
    await screen.findByRole("alert");
    act(() => hide());
    expect(b.fetchImpl).not.toHaveBeenCalled();
    b.unmount();
    window.sessionStorage.clear();
    // the team's time ran out locally
    const d = mount(
      snapshot({ team: { ends_at: NOW + 20_000, remaining_seconds: 20, expired: false } }),
    );
    await press("Enter fullscreen");
    await waitFor(() => expect(probe()).toBe("true|true|true|false"));
    const real = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => real() + 60_000);
    act(() => hide());
    expect(d.fetchImpl).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    d.unmount();
    window.sessionStorage.clear();
    // already ending: the exit logout is the only request
    const e = await startedRunning();
    act(() => e.h.exit());
    await waitFor(() => expect(e.navigate).toHaveBeenCalledTimes(1));
    act(() => hide());
    expect(e.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("after a final submission nothing is sent when the page goes away", async () => {
    const { fetchImpl } = await startedRunning();
    current = snapshot({ team: { status: "FINAL_SUBMITTED" }, version: 9 });
    await act(async () => {
      fireEvent.focus(window);
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => expect(probe()).toMatch(/^false\|/));
    act(() => hide());
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(HINT)).toBeNull(); // the hint is dropped once nothing is enforced
  });

  it("fullscreen entered on this tab leaves a hint that names the member and nothing else", async () => {
    await startedRunning();
    expect(window.sessionStorage.length).toBe(1);
    expect(window.sessionStorage.getItem(HINT)).toBe(MEMBER);
  });

  it("the NEXT page load ends the session if the hint names this member and the team is still enforced (the unload request may have been lost)", async () => {
    window.sessionStorage.setItem(HINT, MEMBER);
    const { fetchImpl, navigate } = mount(snapshot()); // a fresh page: not in fullscreen
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith("/login/participant?notice=fullscreen");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = calls(fetchImpl)[0]!;
    expect([url, init.method, init.body]).toEqual(["/api/auth/logout", "POST", undefined]);
    expect(window.sessionStorage.getItem(HINT)).toBeNull(); // dropped only after the server confirmed
  });

  it("... and says so while it works, and blocks the page, exactly like an in-page exit", async () => {
    window.sessionStorage.setItem(HINT, MEMBER);
    let release!: () => void;
    const slow = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              new Response(JSON.stringify({ ok: true, data: {}, server_now: 1 }), { status: 200 }),
            );
        }),
    );
    const { navigate } = mount(snapshot(), makeFullscreenDriver(), {
      fetchImpl: slow as unknown as typeof fetch,
    });
    await waitFor(() => expect(exitNotice()).toHaveAttribute("open"));
    expect(gate()).toBeNull();
    expect(navigate).not.toHaveBeenCalled(); // not before the server has answered
    release();
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
  });

  it("a failed logout on that load is shown and can be retried, never looped", async () => {
    window.sessionStorage.setItem(HINT, MEMBER);
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, data: {}, server_now: 1 }), { status: 200 }),
      );
    const { navigate } = mount(snapshot(), makeFullscreenDriver(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 60));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(HINT)).toBe(MEMBER);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
  });

  it("a hint that names ANOTHER member (a leftover on a shared tab) ends nothing: the participant just meets the gate", async () => {
    window.sessionStorage.setItem(HINT, "00000000-0000-4000-8000-000000000000");
    const { fetchImpl } = mount(snapshot());
    await screen.findByRole("heading", { name: "Enter fullscreen to continue" });
    await new Promise((r) => setTimeout(r, 40));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(exitNotice()).toBeNull();
  });

  it("a stale hint is dropped, and ends nothing, when the team is finished or has not started", async () => {
    for (const snap of [
      snapshot({ team: { status: "FINAL_SUBMITTED" } }),
      snapshot({ team: { status: "ENDED" } }),
      snapshot(NOT_STARTED),
    ]) {
      window.sessionStorage.setItem(HINT, MEMBER);
      const { fetchImpl, unmount } = mount(snap);
      await waitFor(() => expect(window.sessionStorage.getItem(HINT)).toBeNull());
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(exitNotice()).toBeNull();
      unmount();
    }
  });

  it("with no hint (storage empty or blocked) a reload only meets the gate: the limit is real and the unload request is then the only line", async () => {
    const { fetchImpl } = mount(snapshot());
    await screen.findByRole("heading", { name: "Enter fullscreen to continue" });
    await new Promise((r) => setTimeout(r, 40));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocked or throwing storage never breaks entering fullscreen or leaving it", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { h, navigate, fetchImpl } = await startedRunning();
    act(() => h.exit());
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("leaving fullscreen while nothing is enforced drops the hint", async () => {
    c.enterCompetition.mockResolvedValue(c.fail("COMPETITION_PAUSED", 423));
    const { h } = mount(snapshot(NOT_STARTED));
    await press("Enter competition");
    await screen.findByRole("alert");
    expect(window.sessionStorage.getItem(HINT)).toBe(MEMBER);
    act(() => h.exit());
    expect(window.sessionStorage.getItem(HINT)).toBeNull();
  });

  it("the sign-in page drops a leftover hint, so the next person on this tab is not signed out by it", () => {
    window.sessionStorage.setItem(HINT, MEMBER);
    render(<LoginNotice />);
    expect(window.sessionStorage.getItem(HINT)).toBeNull();
  });

  it("a page restored from the back/forward cache that is no longer in fullscreen ends the session; an ordinary pageshow does nothing", async () => {
    const { h, fetchImpl, navigate } = await startedRunning();
    h.silentExit(); // no fullscreenchange was delivered to a frozen page
    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a same-document route change (client-side navigation, history, hash) is not an exit: nothing is sent and fullscreen stays established", async () => {
    const { fetchImpl, navigate } = await startedRunning();
    act(() => {
      window.history.pushState({}, "", "/participant/theme/A/1");
      window.dispatchEvent(new PopStateEvent("popstate"));
      window.history.pushState({}, "", "/participant#top");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(probe()).toBe("true|true|true|false");
  });

  it("the pagehide and pageshow listeners are removed on unmount", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = await startedRunning();
    unmount();
    for (const type of ["pagehide", "pageshow"]) {
      const added = add.mock.calls.filter(([t]) => t === type).length;
      const removed = remove.mock.calls.filter(([t]) => t === type).length;
      expect(added).toBeGreaterThan(0);
      expect(removed).toBe(added);
    }
    vi.restoreAllMocks();
  });
});

describe("B19-r2: direct navigation to a question never activates or reads it behind the gate", () => {
  const withQ1 = (
    team: NonNullable<Parameters<typeof snapshot>[0]>["team"],
    q: "AVAILABLE" | "ACTIVE" | "APPROVED",
  ) => snapshot({ team, themes: { A: { q: [q, "LOCKED", "LOCKED", "LOCKED", "LOCKED"] } } });
  const page = <QuestionPage theme="A" n={1} />;

  it("NOT_STARTED (an impossible-but-adversarial snapshot with Q1 AVAILABLE): nothing is entered or read, even long after the page opened", async () => {
    c.enterQuestionCall.mockResolvedValue(c.ok(question({ state: "ACTIVE" })));
    c.fetchQuestion.mockResolvedValue(c.ok(question({ state: "ACTIVE" })));
    for (const q of ["AVAILABLE", "ACTIVE"] as const) {
      const { unmount } = mount(withQ1(NOT_STARTED.team, q), makeFullscreenDriver(), {
        children: page,
      });
      await screen.findByRole("heading", { name: "Enter the competition" });
      await new Promise((r) => setTimeout(r, 60));
      expect(c.enterQuestionCall).not.toHaveBeenCalled();
      expect(c.fetchQuestion).not.toHaveBeenCalled();
      expect(probe()).toBe("false|false|false|false");
      unmount();
    }
  });

  it("NOT_STARTED: pressing the gate starts the team first; the question is entered only after both succeeded, once", async () => {
    c.enterQuestionCall.mockResolvedValue(c.ok(question({ state: "ACTIVE" })));
    const started = withQ1({ status: "RUNNING" }, "AVAILABLE");
    c.enterCompetition.mockImplementation(async () => {
      current = started;
      return c.ok(started);
    });
    mount(withQ1(NOT_STARTED.team, "AVAILABLE"), makeFullscreenDriver(), { children: page });
    await press("Enter competition");
    await screen.findByText("Find the value of x.");
    expect(c.enterCompetition).toHaveBeenCalledTimes(1);
    expect(c.enterQuestionCall).toHaveBeenCalledTimes(1);
  });

  it("NOT_STARTED and the browser refuses fullscreen: still nothing is entered or read", async () => {
    mount(withQ1(NOT_STARTED.team, "AVAILABLE"), makeFullscreenDriver({ mode: "reject" }), {
      children: page,
    });
    await press("Enter competition");
    await screen.findByRole("alert");
    await new Promise((r) => setTimeout(r, 40));
    expect(c.enterCompetition).not.toHaveBeenCalled();
    expect(c.enterQuestionCall).not.toHaveBeenCalled();
    expect(c.fetchQuestion).not.toHaveBeenCalled();
  });

  it("RUNNING outside fullscreen: nothing is entered or read until the gate is passed", async () => {
    c.enterQuestionCall.mockResolvedValue(c.ok(question({ state: "ACTIVE" })));
    mount(withQ1({}, "AVAILABLE"), makeFullscreenDriver(), { children: page });
    await screen.findByRole("heading", { name: "Enter fullscreen to continue" });
    await new Promise((r) => setTimeout(r, 60));
    expect(c.enterQuestionCall).not.toHaveBeenCalled();
    expect(c.fetchQuestion).not.toHaveBeenCalled();
    await press("Enter fullscreen");
    await screen.findByText("Find the value of x.");
    expect(c.enterQuestionCall).toHaveBeenCalledTimes(1);
  });

  it("RUNNING, then fullscreen is left: the page is blocked and no further question call is made", async () => {
    c.fetchQuestion.mockResolvedValue(c.ok(question({ state: "ACTIVE" })));
    const { h } = mount(withQ1({}, "ACTIVE"), makeFullscreenDriver(), { children: page });
    await press("Enter fullscreen");
    await waitFor(() => expect(c.fetchQuestion).toHaveBeenCalledTimes(1));
    act(() => h.exit());
    await new Promise((r) => setTimeout(r, 60));
    expect(c.fetchQuestion).toHaveBeenCalledTimes(1);
    expect(c.enterQuestionCall).not.toHaveBeenCalled();
  });

  it("the snapshot has not arrived yet: nothing is called (fail closed)", async () => {
    c.fetchTeamState.mockImplementation(() => new Promise(() => undefined));
    render(
      <Game initial={null} passedGate={false} fullscreen={makeFullscreenDriver().driver}>
        <Probe />
        {page}
      </Game>,
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(probe()).toBe("false|false|false|false");
    expect(c.enterQuestionCall).not.toHaveBeenCalled();
    expect(c.fetchQuestion).not.toHaveBeenCalled();
  });

  it("after a legitimate finish (final submission, ended, disqualified) the question is still READ without fullscreen and there is no gate", async () => {
    c.fetchQuestion.mockResolvedValue(c.ok(question({ state: "APPROVED" })));
    for (const status of ["FINAL_SUBMITTED", "ENDED", "DISQUALIFIED"] as const) {
      c.fetchQuestion.mockClear();
      const { unmount } = mount(withQ1({ status }, "APPROVED"), makeFullscreenDriver(), {
        children: page,
      });
      await screen.findByText("Find the value of x.");
      expect(c.fetchQuestion).toHaveBeenCalledTimes(1);
      expect(gate()).toBeNull();
      expect(probe()).toBe("false|false|true|false");
      unmount();
    }
  });

  it("time up (the server says expired/frozen while the status is still RUNNING) also keeps reading allowed", async () => {
    c.fetchQuestion.mockResolvedValue(c.ok(question({ state: "APPROVED" })));
    mount(
      withQ1({ expired: true, remaining_seconds: 0, ends_at: NOW - 1000 }, "APPROVED"),
      makeFullscreenDriver(),
      {
        children: page,
      },
    );
    await screen.findByText("Find the value of x.");
    expect(gate()).toBeNull();
  });
});

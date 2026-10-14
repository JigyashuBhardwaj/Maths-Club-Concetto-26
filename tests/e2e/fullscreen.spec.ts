import { expect, request, test, type Page } from "@playwright/test";

import { api, createPlayerTeam, inspect, player, signInMember, beginTheme } from "./support/game";
import type { E2ETeam } from "./support/identities";
import { officialTheme } from "./support/official";
import { control, loginForCookies, participantCredentials } from "./support/session";

/**
 * B19 in REAL desktop Chromium: nothing here is mocked unless the test says so in its title. `requestFullscreen()` is
 * the browser's own, called from a real click; `document.fullscreenElement` is read back from the page; leaving
 * fullscreen is `document.exitFullscreen()`, which makes the browser fire the same `fullscreenchange` as any other way
 * out. LIMIT: headless Chromium does not turn a real Escape key press into a fullscreen exit (the key never reaches the
 * browser UI), so Escape itself is NOT exercised here; it is covered only at component level through the shared event
 * (tests/component/fullscreen.test.tsx). Fullscreen in a headed browser was not run in this environment.
 *
 * Reloads: a reload leaves fullscreen (the browser drops it with the document). Two stubs here are labelled in their
 * titles; the others use the browser's own `reload()`, `goBack()` and `fetch(..., { keepalive })`.
 *
 * Every test builds its own team and never signs in through the mocked fullscreen of the other specs.
 */
test.describe.configure({ timeout: 120_000 });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "B19 browser coverage is desktop-only by design");
});

const isFullscreen = (page: Page) => page.evaluate(() => document.fullscreenElement !== null);
const liveSessions = async (team: E2ETeam, slot: number) =>
  (
    (await control("liveSessions", {
      admissionNo: team.members.find((m) => m.slot === slot)!.admissionNo,
    })) as { live: number }
  ).live;

async function startedTeam() {
  const team = await createPlayerTeam();
  await beginTheme(team, { enterQ1: false }); // team started, theme A unlocked, Q1 AVAILABLE and NOT entered
  return team;
}

test.describe("entering fullscreen (real browser)", () => {
  test("the first member: nothing starts on load; the Enter competition click enters fullscreen, THEN the team timer starts", async ({
    page,
  }) => {
    const team = await createPlayerTeam();
    await signInMember(page.context(), team, 1, { mockFullscreen: false });
    await page.goto("/participant");
    const gate = page.getByRole("dialog", { name: "Enter the competition" });
    await expect(gate).toBeVisible();
    await expect(gate).toContainText("You must enter fullscreen before you start");
    await expect(gate).toContainText("the timer starts only after fullscreen succeeds");
    await expect(gate).toContainText("your session ends and you are signed out");
    // nothing was requested without a click, and nothing started
    await page.waitForTimeout(1500);
    expect(await isFullscreen(page)).toBe(false);
    const before = await inspect(team);
    expect(before.status).toBe("NOT_STARTED");
    expect(before.startedAt).toBeNull();

    await gate.getByRole("button", { name: "Enter competition" }).click();
    await expect(gate).toBeHidden();
    expect(await isFullscreen(page)).toBe(true);
    const after = await inspect(team);
    expect(after.status).toBe("RUNNING");
    expect(after.endsAt! - after.startedAt!).toBe(14_400_000); // the server's duration, unchanged
    expect(await liveSessions(team, 1)).toBe(1);
  });

  test("Q1 is not activated by opening its page outside fullscreen; it activates once, with the server's deadline, after the fullscreen click", async ({
    page,
  }) => {
    const team = await startedTeam();
    expect((await inspect(team)).questions["1"]!.state).toBe("AVAILABLE");
    await signInMember(page.context(), team, 1, { mockFullscreen: false });
    const questionCalls: string[] = [];
    page.on("request", (r) => {
      if (/\/api\/p\/questions\/1(\/|$)/.test(new URL(r.url()).pathname))
        questionCalls.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await page.goto("/participant/theme/A/1");
    const gate = page.getByRole("dialog", { name: "Enter fullscreen to continue" });
    await expect(gate).toBeVisible();
    await page.waitForTimeout(2500); // long enough for any background activation to have happened
    let q = (await inspect(team)).questions["1"]!;
    expect(q.state).toBe("AVAILABLE");
    expect(q.deadline ?? null).toBeNull();
    // the page asked the server nothing about this question: it did not enter it and did not read its text
    expect(questionCalls).toEqual([]);
    await expect(page.getByText("Loading the question…")).toBeVisible();

    await gate.getByRole("button", { name: "Enter fullscreen" }).click();
    await expect(page.getByText("Loading the question…")).toBeHidden({ timeout: 60_000 });
    await expect(page.locator(".q-question")).toBeVisible();
    expect(await isFullscreen(page)).toBe(true);
    expect(questionCalls.filter((c) => c.endsWith("/enter"))).toEqual([
      "POST /api/p/questions/1/enter",
    ]);
    q = (await inspect(team)).questions["1"]!;
    expect(q.state).toBe("ACTIVE");
    // the deadline on screen is the database's: the page's countdown agrees with it
    const left = q.deadline! - Date.now();
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(240_000);
  });

  test("a teammate who signs in later is stopped by the same gate, and pressing it starts nothing and extends no timer", async ({
    page,
  }) => {
    const team = await startedTeam();
    const first = await inspect(team);
    await signInMember(page.context(), team, 2, { mockFullscreen: false });
    await page.goto("/participant");
    const gate = page.getByRole("dialog", { name: "Enter fullscreen to continue" });
    await expect(gate).toBeVisible();
    await gate.getByRole("button", { name: "Enter fullscreen" }).click();
    await expect(gate).toBeHidden();
    expect(await isFullscreen(page)).toBe(true);
    const after = await inspect(team);
    expect(after.startedAt).toBe(first.startedAt);
    expect(after.endsAt).toBe(first.endsAt);
    expect(after.version).toBe(first.version);
  });

  test("fullscreen refused by the browser (a labelled stub: the API rejects) starts nothing; the retry works for real", async ({
    page,
  }) => {
    const team = await createPlayerTeam();
    await page.addInitScript(() => {
      const real = Element.prototype.requestFullscreen;
      (window as unknown as { __allow: boolean }).__allow = false;
      Element.prototype.requestFullscreen = function (this: Element, o?: FullscreenOptions) {
        return (window as unknown as { __allow: boolean }).__allow
          ? real.call(this, o)
          : Promise.reject(new TypeError("Permissions check failed"));
      };
    });
    await signInMember(page.context(), team, 1, { mockFullscreen: false });
    await page.goto("/participant");
    const gate = page.getByRole("dialog", { name: "Enter the competition" });
    await gate.getByRole("button", { name: "Enter competition" }).click();
    await expect(gate.getByRole("alert")).toContainText("didn't allow fullscreen");
    expect(await isFullscreen(page)).toBe(false);
    expect((await inspect(team)).status).toBe("NOT_STARTED");
    expect((await inspect(team)).startedAt).toBeNull();

    await page.evaluate(() => ((window as unknown as { __allow: boolean }).__allow = true));
    await gate.getByRole("button", { name: "Enter competition" }).click();
    await expect(gate).toBeHidden();
    expect(await isFullscreen(page)).toBe(true);
    expect((await inspect(team)).status).toBe("RUNNING");
  });

  test("a browser with no fullscreen support (a labelled stub: the API is removed) cannot start the team and says why", async ({
    page,
  }) => {
    const team = await createPlayerTeam();
    await page.addInitScript(() => {
      Object.defineProperty(document, "fullscreenEnabled", {
        configurable: true,
        get: () => false,
      });
      // @ts-expect-error -- removing the API on purpose to emulate a browser without it
      delete Element.prototype.requestFullscreen;
    });
    await signInMember(page.context(), team, 1, { mockFullscreen: false });
    await page.goto("/participant");
    const gate = page.getByRole("dialog", { name: "Enter the competition" });
    await gate.getByRole("button", { name: "Enter competition" }).click();
    await expect(gate.getByRole("alert")).toContainText("can't show the competition in fullscreen");
    expect((await inspect(team)).status).toBe("NOT_STARTED");
    await expect(gate).toBeVisible();
  });
});

test.describe("leaving fullscreen while the competition runs (real browser)", () => {
  test("exiting fullscreen revokes the session on the server, clears the cookie, lands on the sign-in page with the reason, and touches nothing else", async ({
    page,
  }) => {
    const team = await startedTeam();
    const cookies = await signInMember(page.context(), team, 1, { mockFullscreen: false });
    const teammate = await api(
      await loginForCookies("/api/auth/participant/login", participantCredentials(team, 2)),
    );
    const logouts: string[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/auth/logout")) logouts.push(r.method());
    });
    await page.goto("/participant");
    await page
      .getByRole("dialog", { name: "Enter fullscreen to continue" })
      .getByRole("button", { name: "Enter fullscreen" })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await isFullscreen(page)).toBe(true);
    const running = await inspect(team);
    expect(await liveSessions(team, 1)).toBe(1);
    await page.evaluate(() => document.exitFullscreen());

    await expect(page).toHaveURL(/\/login\/participant\?notice=fullscreen$/);
    await expect(page.getByTestId("login-notice")).toHaveText(
      "Your session ended because you exited fullscreen. Sign in again to continue.",
    );
    expect(logouts).toEqual(["POST"]); // exactly one logout request

    // the server really ended it: the old cookie is dead on a protected API
    const old = await api(cookies);
    expect((await player(old).state()).status).toBe(401);
    await old.dispose();
    // the browser's cookie jar no longer holds a session cookie
    expect(
      (await page.context().cookies()).find((c) => c.name === "__Host-session"),
    ).toBeUndefined();
    // only this participant was affected: the team clock and the teammate are untouched
    const after = await inspect(team);
    expect(after.status).toBe("RUNNING");
    expect(after.startedAt).toBe(running.startedAt);
    expect(after.endsAt).toBe(running.endsAt);
    expect((await player(teammate).state()).status).toBe(200);
    await teammate.dispose();
  });

  test("a reload leaves fullscreen too: while the competition runs it ends the session (the unloading page asks the server; the next page finishes the job if that request was lost)", async ({
    page,
  }) => {
    const team = await startedTeam();
    const cookies = await signInMember(page.context(), team, 1, { mockFullscreen: false });
    const teammate = await api(
      await loginForCookies("/api/auth/participant/login", participantCredentials(team, 2)),
    );
    const logouts: string[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/auth/logout")) logouts.push(r.method());
    });
    await page.goto("/participant");
    await page.getByRole("button", { name: "Enter fullscreen" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await liveSessions(team, 1)).toBe(1);
    const running = await inspect(team);

    await page.reload();

    // whichever mechanism got there first, the participant is signed out and the old cookie is dead
    await expect(page).toHaveURL(/\/login\/participant(\?notice=fullscreen)?$/);
    await expect.poll(() => liveSessions(team, 1)).toBe(0);
    expect(logouts.length).toBeGreaterThanOrEqual(1);
    const old = await api(cookies);
    expect((await player(old).state()).status).toBe(401);
    await old.dispose();
    // only this participant: the team clock and the teammate are untouched
    const after = await inspect(team);
    expect([after.status, after.startedAt, after.endsAt]).toEqual([
      "RUNNING",
      running.startedAt,
      running.endsAt,
    ]);
    expect((await player(teammate).state()).status).toBe(200);
    await teammate.dispose();
  });

  test("a reload whose unload-time logout request is LOST (a labelled stub: keepalive logouts are dropped) is still ended by the next page, with the reason", async ({
    page,
  }) => {
    const team = await startedTeam();
    await signInMember(page.context(), team, 1, { mockFullscreen: false });
    await page.addInitScript(() => {
      const realFetch = window.fetch.bind(window);
      window.fetch = (input, init) =>
        init?.keepalive && String(input).endsWith("/api/auth/logout")
          ? Promise.reject(new TypeError("dropped while unloading"))
          : realFetch(input, init);
    });
    const logouts: string[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/auth/logout")) logouts.push(r.method());
    });
    await page.goto("/participant");
    await page.getByRole("button", { name: "Enter fullscreen" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await liveSessions(team, 1)).toBe(1);
    expect(logouts).toEqual([]);

    await page.reload();

    await expect(page).toHaveURL(/\/login\/participant\?notice=fullscreen$/);
    await expect(page.getByTestId("login-notice")).toContainText("exited fullscreen");
    expect(logouts).toEqual(["POST"]); // exactly one request reached the server: the new page's
    expect(await liveSessions(team, 1)).toBe(0);
    expect(
      (await page.context().cookies()).find((c) => c.name === "__Host-session"),
    ).toBeUndefined();
    // and the next person to sign in on this tab is not signed out by a leftover
    expect(await page.evaluate(() => window.sessionStorage.length)).toBe(0);
  });

  test("the unloading page's own request is what ends it when the next page has no hint (a labelled stub: the hint is erased at the start of every document)", async ({
    page,
  }) => {
    const team = await startedTeam();
    await signInMember(page.context(), team, 1, { mockFullscreen: false });
    await page.addInitScript(() => window.sessionStorage.removeItem("mc26.fullscreen.member"));
    await page.goto("/participant");
    await page.getByRole("button", { name: "Enter fullscreen" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await liveSessions(team, 1)).toBe(1);

    await page.reload();

    // only the keepalive request from the page that was unloading can have ended it
    await expect.poll(() => liveSessions(team, 1), { timeout: 15_000 }).toBe(0);
    await expect(page).toHaveURL(/\/login\/participant$/); // the server's guard, not the app's notice
  });

  test("moving between participant pages inside fullscreen is not an exit: client-side navigation keeps the session, the fullscreen and the question loads", async ({
    page,
  }) => {
    const team = await startedTeam();
    await signInMember(page.context(), team, 1, { mockFullscreen: false });
    const logouts: string[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/auth/logout")) logouts.push(r.method());
    });
    await page.goto("/participant");
    await page.getByRole("button", { name: "Enter fullscreen" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: officialTheme("A").name, exact: true }).focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: officialTheme("A").name });
    await dialog.getByRole("link", { name: "Let's solve" }).click();
    await expect(page).toHaveURL(/\/participant\/theme\/A\/1$/);
    await expect(page.locator(".q-question")).toBeVisible({ timeout: 60_000 });
    await page.goBack();
    await expect(page).toHaveURL(/\/participant$/);
    await page.waitForTimeout(1500);

    expect(await isFullscreen(page)).toBe(true); // the document never changed
    expect(await liveSessions(team, 1)).toBe(1);
    expect(logouts).toEqual([]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("direct navigation to a question before the team has started: the gate stands, nothing starts and no question is entered or read", async ({
    page,
  }) => {
    const team = await createPlayerTeam();
    await signInMember(page.context(), team, 1, { mockFullscreen: false });
    const questionCalls: string[] = [];
    page.on("request", (r) => {
      if (/\/api\/p\/(questions|themes)\//.test(new URL(r.url()).pathname))
        questionCalls.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await page.goto("/participant/theme/A/1");
    await expect(page.getByRole("dialog", { name: "Enter the competition" })).toBeVisible();
    await page.waitForTimeout(2500);
    expect(questionCalls).toEqual([]);
    expect(await isFullscreen(page)).toBe(false);
    const before = await inspect(team);
    expect(before.status).toBe("NOT_STARTED");
    expect(Object.values(before.questions).filter((q) => q.state !== "LOCKED")).toHaveLength(0);
  });

  test("after a legitimate finish a question can still be opened and read without fullscreen, and nothing asks for it", async ({
    page,
  }) => {
    const team = await createPlayerTeam();
    await beginTheme(team); // started, theme A unlocked, Q1 entered (ACTIVE)
    const cookies = await signInMember(page.context(), team, 1, { mockFullscreen: false });
    const mine = await api(cookies);
    expect((await player(mine).finalSubmit()).status).toBe(200);
    await mine.dispose();
    const reads: string[] = [];
    page.on("request", (r) => {
      if (/\/api\/p\/questions\/1$/.test(new URL(r.url()).pathname)) reads.push(r.method());
    });
    await page.goto("/participant/theme/A/1");
    await expect(page.locator(".q-question")).toBeVisible({ timeout: 60_000 });
    expect(reads).toContain("GET");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await isFullscreen(page)).toBe(false);
    expect(await liveSessions(team, 1)).toBe(1); // reading a finished competition is not a violation
  });

  test("after a legitimate final submission, leaving fullscreen does not sign the participant out", async ({
    page,
  }) => {
    const team = await startedTeam();
    const cookies = await signInMember(page.context(), team, 1, { mockFullscreen: false });
    await page.goto("/participant");
    await page.getByRole("button", { name: "Enter fullscreen" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await isFullscreen(page)).toBe(true);

    // the team's final submission is made through the real API (the same call the Final Submit dialog makes)
    const mine = await api(cookies);
    expect((await player(mine).finalSubmit()).status).toBe(200);
    // the page learns it from the server's next snapshot, not from the browser
    await expect(page.getByText("Your team has made its final submission.")).toBeVisible({
      timeout: 30_000,
    });
    const live = await liveSessions(team, 1);
    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => isFullscreen(page)).toBe(false);
    await page.waitForTimeout(2000);
    await expect(page).toHaveURL(/\/participant$/);
    expect(await liveSessions(team, 1)).toBe(live);
    expect((await player(mine).state()).status).toBe(200);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await mine.dispose();
  });

  test("leaving fullscreen BEFORE the team has started (the start call was lost) does not sign anyone out, and entering again works", async ({
    page,
  }) => {
    const team = await createPlayerTeam();
    await signInMember(page.context(), team, 1, { mockFullscreen: false });
    // the connection drops exactly when "Enter competition" calls the server: fullscreen succeeds, the start does not
    await page.route("**/api/p/start", (route) => route.abort());
    await page.goto("/participant");
    const gate = page.getByRole("dialog", { name: "Enter the competition" });
    await gate.getByRole("button", { name: "Enter competition" }).click();
    await expect(gate.getByRole("alert")).toContainText("Can't reach the server");
    expect(await isFullscreen(page)).toBe(true);
    expect((await inspect(team)).status).toBe("NOT_STARTED");

    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => isFullscreen(page)).toBe(false);
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(/\/participant$/);
    expect(await liveSessions(team, 1)).toBe(1);

    await page.unroute("**/api/p/start");
    await gate.getByRole("button", { name: "Enter competition" }).click();
    await expect(gate).toBeHidden();
    expect(await isFullscreen(page)).toBe(true);
    expect((await inspect(team)).status).toBe("RUNNING");
  });
});

test("protected APIs still refuse a request without the session (the server never trusts the page)", async () => {
  const ctx = await request.newContext({
    baseURL: `http://localhost:${process.env.PORT ?? 3100}`,
  });
  for (const path of ["/api/p/state", "/api/p/questions/1"]) {
    expect((await ctx.get(path)).status()).toBe(401);
  }
  await ctx.dispose();
});

import { expect, request, test, type Page } from "@playwright/test";

import {
  control,
  participantCredentials,
  signInSharedParticipant,
  staffCredentials,
  teamFor,
} from "./support/session";

const origin = `http://localhost:${process.env.PORT ?? 3100}`;
const SESSION_COOKIE = "__Host-session";

/** Exactly this path. (A bare /admin$/ pattern would also match /login/admin, and "**\/admin" would too.) */
const at = (path: string) => new RegExp(`^${origin}${path}$`);
const reached = (path: string) => (url: URL) => url.pathname === path;

// Real browser, real login endpoints, real cookies, real route guards. The database behind the API is the in-memory
// stand-in from tests/e2e/support/fake-postgrest.mjs (random identities per run). Desktop and mobile use different
// teams, so the two projects never invalidate each other's sessions.
test.describe.configure({ timeout: 90_000 });

async function fillParticipant(
  page: Page,
  c: { teamLoginId: string; password: string; admissionNo: string },
) {
  await page.getByLabel("Team Login ID").fill(c.teamLoginId);
  await page.getByLabel("Team Password").fill(c.password);
  await page.getByLabel("Admission Number").fill(c.admissionNo);
}

async function fillStaff(page: Page, c: { username: string; password: string }) {
  await page.getByLabel("Username").fill(c.username);
  await page.getByLabel("Password", { exact: true }).fill(c.password);
}

async function sessionCookie(page: Page) {
  return (await page.context().cookies()).find((c) => c.name === SESSION_COOKIE);
}

/** GET /api/auth/me with the page's cookies, as JSON text (so a leak of any kind is a plain string search). */
async function me(page: Page) {
  const res = await page.request.get("/api/auth/me");
  return { status: res.status(), text: await res.text() };
}

test.describe("participant sign-in (browser)", () => {
  test.describe.configure({ mode: "serial" });

  test("signs in, lands on /participant, keeps the session across refresh and navigation, exposes no secrets", async ({
    page,
  }, info) => {
    const team = teamFor(info);
    const creds = participantCredentials(team, 2);
    await page.goto("/login/participant");
    await fillParticipant(page, creds);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(reached("/participant"));
    await expect(
      page.getByRole("heading", { level: 1, name: "WELCOME TO THE ESCAPE ROOM ISMites" }),
    ).toBeVisible();

    // the cookie is the session; the page's scripts cannot read it
    const cookie = await sessionCookie(page);
    expect(cookie).toBeDefined();
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
    expect(await page.evaluate(() => document.cookie)).not.toContain(SESSION_COOKIE);
    const stored = await page.evaluate(() =>
      JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
    );
    expect(stored).not.toContain(cookie!.value);

    // session restoration
    const before = await me(page);
    expect(before.status).toBe(200);
    const principal = JSON.parse(before.text) as { data: { role: string; team: { code: string } } };
    expect(principal.data.role).toBe("PARTICIPANT");
    expect(principal.data.team.code).toBe(team.code);
    for (const secret of [
      creds.password,
      creds.admissionNo,
      cookie!.value,
      "hash",
      "token",
      "password",
    ]) {
      expect(before.text.toLowerCase()).not.toContain(secret.toLowerCase());
    }

    // refresh and navigation keep it
    await page.reload();
    await expect(page).toHaveURL(at("/participant"));
    await page.goto("/participant/theme/A/1");
    expect(page.url()).toContain("/participant/theme/A/1");
    await page.goto("/participant");
    await expect(page).toHaveURL(at("/participant"));
    expect((await me(page)).status).toBe(200);
  });

  test("the sign-in page is public and makes no API call when it loads", async ({ page }, info) => {
    const calls: string[] = [];
    page.on("request", (r) => r.url().includes("/api/") && calls.push(r.url()));
    await signInSharedParticipant(page, info); // even with a session, the page is just the form
    const res = await page.goto("/login/participant");
    expect(res?.status()).toBe(200);
    await expect(page.getByLabel("Team Login ID")).toBeVisible();
    expect(calls).toEqual([]);
  });

  test("wrong credentials: one generic message, no session, the form stays usable", async ({
    page,
  }, info) => {
    const creds = participantCredentials(teamFor(info), 2);
    await page.goto("/login/participant");
    await fillParticipant(page, { ...creds, password: "definitely-wrong-password" });
    await page.getByRole("button", { name: "Sign in" }).click();
    const alert = page.locator("form").getByRole("alert");
    await expect(alert).toHaveText(
      "Those details don't match an account. Check them and try again.",
    );
    await expect(page).toHaveURL(/\/login\/participant$/);
    expect(await sessionCookie(page)).toBeUndefined();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
    // nothing the person typed is echoed back by the page's error text
    await expect(alert).not.toContainText("definitely-wrong-password");
    // a wrong admission number looks exactly the same
    await fillParticipant(page, { ...creds, admissionNo: "NOPE0000" });
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alert).toHaveText(
      "Those details don't match an account. Check them and try again.",
    );
  });

  test("empty and over-long fields are rejected in the form without calling the server", async ({
    page,
  }) => {
    const calls: string[] = [];
    page.on("request", (r) => r.url().includes("/api/auth/") && calls.push(r.url()));
    await page.goto("/login/participant");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Enter your Team Login ID.")).toBeVisible();
    await expect(page.getByText("Enter your password.")).toBeVisible();
    await expect(page.getByText("Enter your admission number.")).toBeVisible();
    await page.getByLabel("Team Password").fill("x".repeat(73));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("That password is too long.")).toBeVisible();
    expect(calls).toEqual([]);
  });

  test("a double click sends exactly one sign-in request", async ({ page }, info) => {
    const creds = participantCredentials(teamFor(info), 2);
    let calls = 0;
    await page.route("**/api/auth/participant/login", async (route) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 400));
      await route.continue();
    });
    await page.goto("/login/participant");
    await fillParticipant(page, creds);
    await page.getByRole("button", { name: "Sign in" }).dblclick();
    await page.waitForURL(reached("/participant"));
    expect(calls).toBe(1);
  });

  test("while the competition is not open the participant is told so and gets no session", async ({
    page,
  }, info) => {
    const team = teamFor(info);
    await control("competition", { loginId: team.loginId, status: "SETUP" });
    try {
      await page.goto("/login/participant");
      await fillParticipant(page, participantCredentials(team, 2));
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.locator("form").getByRole("alert")).toContainText(
        "isn't open for sign-in right now",
      );
      expect(await sessionCookie(page)).toBeUndefined();
      await expect(page).toHaveURL(/\/login\/participant$/);
    } finally {
      await control("competition", { loginId: team.loginId, status: "RUNNING" });
    }
  });

  test("repeated failures show the rate-limit message with the wait", async ({ page }, info) => {
    const api = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
    const loginId = `e2e_nobody_${info.project.name}`;
    for (let i = 0; i < 8; i += 1) {
      await api.post("/api/auth/participant/login", {
        data: { teamLoginId: loginId, password: "nope", admissionNo: "NOPE" },
      });
    }
    await api.dispose();
    await page.goto("/login/participant");
    await fillParticipant(page, { teamLoginId: loginId, password: "nope", admissionNo: "NOPE" });
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("form").getByRole("alert")).toContainText(
      /Too many attempts\. Please wait \d+ seconds/,
    );
  });

  test("sign out revokes the session on the server and ends access", async ({
    page,
    browser,
  }, info) => {
    const team = teamFor(info);
    const creds = participantCredentials(team, 3);
    await page.goto("/login/participant");
    await fillParticipant(page, creds);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(reached("/participant"));
    const token = (await sessionCookie(page))!.value;
    expect((await control("liveSessions", { admissionNo: creds.admissionNo })).live).toBe(1);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL("**/login/participant");
    expect(await sessionCookie(page)).toBeUndefined(); // the cookie is cleared
    expect((await control("liveSessions", { admissionNo: creds.admissionNo })).live).toBe(0); // and revoked server-side

    // typing the protected URL no longer works ...
    await page.goto("/participant");
    await expect(page).toHaveURL(/\/login\/participant$/);
    // ... and neither does replaying the old cookie from a fresh browser
    const stolen = await browser.newContext({ baseURL: origin });
    await stolen.addCookies([
      {
        name: SESSION_COOKIE,
        value: token,
        domain: "localhost",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    expect((await stolen.request.get("/api/auth/me")).status()).toBe(401);
    const res = await stolen.request.get("/participant", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers().location).toContain("/login/participant");
    await stolen.close();
  });

  test("an expired session is not authenticated: pages redirect, /api/auth/me is 401", async ({
    page,
  }, info) => {
    const creds = participantCredentials(teamFor(info), 4);
    await page.goto("/login/participant");
    await fillParticipant(page, creds);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(reached("/participant"));
    expect((await me(page)).status).toBe(200);

    await control("expire", { admissionNo: creds.admissionNo });
    expect((await me(page)).status).toBe(401);
    await page.goto("/participant");
    await expect(page).toHaveURL(/\/login\/participant$/);
    // the sign-in page does not treat the dead cookie as a session either: the form is shown
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("signing in again elsewhere supersedes the first session", async ({
    page,
    browser,
  }, info) => {
    const creds = participantCredentials(teamFor(info), 4);
    await page.goto("/login/participant");
    await fillParticipant(page, creds);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(reached("/participant"));

    const other = await browser.newContext({ baseURL: origin });
    const second = await other.newPage();
    await second.goto("/login/participant");
    await fillParticipant(second, creds);
    await second.getByRole("button", { name: "Sign in" }).click();
    await second.waitForURL(reached("/participant"));
    await other.close();

    expect((await me(page)).status).toBe(401);
    await page.goto("/participant");
    await expect(page).toHaveURL(/\/login\/participant$/);
  });
});

test.describe("staff sign-in (browser)", () => {
  test("an Admin signs in at /login/admin, lands on /admin and cannot enter other areas", async ({
    page,
  }) => {
    await page.goto("/login/admin");
    await fillStaff(page, staffCredentials("e2e_admin"));
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(reached("/admin"));
    // B12: the Admin shell shows the Admin's user ID (their username), as the Admin dashboard UI specifies.
    await expect(page.getByText("Signed in as")).toContainText("e2e_admin");
    const cookie = await sessionCookie(page);
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax" });
    const principal = JSON.parse((await me(page)).text) as { data: { role: string } };
    expect(principal.data.role).toBe("ADMIN");

    for (const [path, lands] of [
      ["/superadmin", at("/admin")],
      ["/participant", at("/admin")],
      ["/participant/theme/A/1", at("/admin")],
    ] as const) {
      await page.goto(path);
      await expect(page).toHaveURL(lands);
    }
    await page.reload();
    await expect(page).toHaveURL(at("/admin"));
  });

  test("a Super Admin signs in at /login/superadmin, lands on /superadmin and stays out of /admin", async ({
    page,
  }) => {
    await page.goto("/login/superadmin");
    await fillStaff(page, staffCredentials("e2e_super"));
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(reached("/superadmin"));
    await expect(page.getByText("Signed in as")).toContainText("E2E Super Admin");
    const principal = JSON.parse((await me(page)).text) as { data: { role: string } };
    expect(principal.data.role).toBe("SUPER_ADMIN");
    for (const path of ["/admin", "/participant"]) {
      await page.goto(path);
      await expect(page).toHaveURL(at("/superadmin"));
    }
  });

  test("the role is decided by the server, not by the page the form is on", async ({ page }) => {
    // Admin credentials typed into the Super Admin page still produce an ADMIN session and the /admin home.
    await page.goto("/login/superadmin");
    await fillStaff(page, staffCredentials("e2e_admin"));
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(reached("/admin"));
    await page.goto("/superadmin");
    await expect(page).toHaveURL(at("/admin"));
  });

  test("a disabled account and a wrong password get the same generic message", async ({ page }) => {
    await page.goto("/login/admin");
    await fillStaff(page, staffCredentials("e2e_admin_off"));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText(
      "Those details don't match an account. Check them and try again.",
    );
    await fillStaff(page, { ...staffCredentials("e2e_admin"), password: "wrong-password-here" });
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText(
      "Those details don't match an account. Check them and try again.",
    );
    expect(await sessionCookie(page)).toBeUndefined();
  });

  test("staff sign out ends the session", async ({ page }) => {
    await page.goto("/login/admin");
    await fillStaff(page, staffCredentials("e2e_admin"));
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(reached("/admin"));
    const token = (await sessionCookie(page))!.value;
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL("**/login/admin");
    expect(await sessionCookie(page)).toBeUndefined();
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login\/admin$/);
    const api = await request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect((await api.get("/api/auth/me")).status()).toBe(401);
    await api.dispose();
  });
});

test.describe("route protection (no browser session)", () => {
  const protectedPaths: [string, string][] = [
    ["/participant", "/login/participant"],
    ["/participant/theme/A/1", "/login/participant"],
    ["/admin", "/login/admin"],
    ["/admin/anything", "/login/admin"],
    ["/superadmin", "/login/superadmin"],
    ["/superadmin/anything", "/login/superadmin"],
  ];

  for (const [path, login] of protectedPaths) {
    test(`${path} redirects to ${login} before rendering anything`, async ({ browser }) => {
      const context = await browser.newContext({ baseURL: origin });
      const res = await context.request.get(path, { maxRedirects: 0 });
      expect(res.status()).toBe(307);
      expect(res.headers().location).toContain(login);
      expect(res.headers()["cache-control"]).toContain("no-store");
      expect(await res.text()).not.toContain("Placeholder");
      await context.close();
    });
  }

  test("typing a protected URL in a browser ends on the matching sign-in page", async ({
    page,
  }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login\/admin$/);
    await expect(page.getByLabel("Username")).toBeVisible();
  });

  test("a forged but well-formed cookie passes the proxy and is refused by the server-side check", async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: origin });
    const forged = "A".repeat(43);
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: forged,
        domain: "localhost",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    for (const [path, login] of [
      ["/participant", "/login/participant"],
      ["/admin", "/login/admin"],
      ["/superadmin", "/login/superadmin"],
    ] as const) {
      const res = await context.request.get(path, { maxRedirects: 0 });
      expect(res.status()).toBe(307);
      expect(res.headers().location).toContain(login);
    }
    expect((await context.request.get("/api/auth/me")).status()).toBe(401);
    await context.close();
  });

  test("a participant session cannot open the admin or superadmin areas", async ({
    page,
  }, info) => {
    await signInSharedParticipant(page, info);
    for (const path of ["/admin", "/superadmin"]) {
      const res = await page.request.get(path, { maxRedirects: 0 });
      expect(res.status()).toBe(307);
      expect(res.headers().location).toContain("/participant");
    }
  });

  test("public routes stay public", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: origin });
    for (const path of [
      "/",
      "/login/participant",
      "/login/admin",
      "/login/superadmin",
      "/api/health",
    ]) {
      expect((await context.request.get(path)).status(), path).toBe(200);
    }
    await context.close();
  });
});

import AxeBuilder from "@axe-core/playwright";
import { randomBytes } from "node:crypto";

import { expect, request, test, type Page } from "@playwright/test";

import { control, loginForCookies, signInStaff, staffCredentials } from "./support/session";

const origin = `http://localhost:${process.env.PORT ?? 3100}`;
const reached = (path: string) => (url: URL) => url.pathname === path;

// Admin and team provisioning (B12) in a real browser against the real routes, with the in-memory stand-in behind the
// API. Desktop and mobile share one stand-in, so every identity below is random per test run AND per project.
test.describe.configure({ timeout: 120_000 });

const hex = (n: number) => randomBytes(n).toString("hex");
const secret = () => `Pw-${randomBytes(12).toString("base64url")}`;

interface NewTeam {
  teamCode: string;
  name: string;
  loginId: string;
  password: string;
  admission: [string, string, string, string];
}
function newTeam(tag: string): NewTeam {
  const id = hex(3).toUpperCase();
  return {
    teamCode: `${tag}${id}`,
    name: `Team ${tag} ${id}`,
    loginId: `team_${tag.toLowerCase()}_${id.toLowerCase()}`,
    password: secret(),
    admission: [1, 2, 3, 4].map((n) => `ADM${tag}${id}${n}`) as NewTeam["admission"],
  };
}

async function fillTeam(page: Page, t: NewTeam, confirm = t.password) {
  await page.getByLabel("Team ID").fill(t.teamCode);
  await page.getByLabel("Team Name").fill(t.name);
  await page.getByLabel("Login ID").fill(t.loginId);
  await page.getByLabel("Password", { exact: true }).fill(t.password);
  await page.getByLabel("Confirm Password").fill(confirm);
  for (const [i, a] of t.admission.entries()) {
    await page.getByLabel(`M${i + 1} Admission No.`).fill(a);
  }
}

/** Creates an Admin through the Super Admin's dialog and returns the credentials. */
async function createAdminViaUi(page: Page, tag: string) {
  const username = `adm_${tag}_${hex(3)}`;
  const password = secret();
  await signInStaff(page, "e2e_super");
  await page.goto("/superadmin");
  await page.getByRole("button", { name: "Create admin" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Create a New Admin" })).toBeVisible();
  await dialog.getByLabel("Username").fill(username);
  await dialog.getByLabel("Password", { exact: true }).fill(password);
  await dialog.getByLabel("Retype Password").fill(password);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Admin created" })).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  return { username, password };
}

async function signInAs(page: Page, c: { username: string; password: string }) {
  await page.context().clearCookies();
  await page.goto("/login/admin");
  await page.getByLabel("Username").fill(c.username);
  await page.getByLabel("Password", { exact: true }).fill(c.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(reached("/admin"));
}

async function createTeamViaUi(page: Page, t: NewTeam) {
  await page.getByRole("button", { name: "Create a team" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Create a New Team" })).toBeVisible();
  await fillTeam(page, t);
  await dialog.getByRole("button", { name: "Create Team" }).click();
  await expect(dialog.getByRole("heading", { name: "Team created" })).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
}

test.describe("the central slice: Super Admin → Admin → Team → participant", () => {
  test("an Admin created by the Super Admin creates a team that only that Admin sees, and the team can sign in", async ({
    page,
    browser,
  }, info) => {
    const tag = info.project.name === "mobile" ? "M" : "D";
    const adminA = await createAdminViaUi(page, `a${tag.toLowerCase()}`);

    // The new Admin signs in with the password the Super Admin chose and sees their own user ID.
    await signInAs(page, adminA);
    await expect(page.getByText("Signed in as")).toContainText(adminA.username);
    await page.goto("/admin/teams");
    await expect(page.getByText("You have not created a team yet.")).toBeVisible();

    // Creates T1 from the Admin home; My teams (a new page) lists it.
    await page.goto("/admin");
    const t1 = newTeam(tag);
    await createTeamViaUi(page, t1);
    await page.getByRole("link", { name: "My teams" }).click();
    await page.waitForURL(reached("/admin/teams"));
    const row = page.getByRole("row", { name: new RegExp(t1.teamCode) });
    await expect(row).toContainText(t1.name);
    await expect(row).toContainText(t1.loginId);
    await expect(row).toContainText("4");
    await expect(page.getByRole("row")).toHaveCount(2); // header + T1
    await page.getByRole("link", { name: "Go back" }).click();
    await page.waitForURL(reached("/admin"));

    // The list survives a reload and a fresh sign-in (it is read from the database, not from the browser).
    await signInAs(page, adminA);
    await page.goto("/admin/teams");
    await expect(page.getByRole("row", { name: new RegExp(t1.teamCode) })).toBeVisible();

    // The leaderboard of the Admin home lists every team, with a rank and a score.
    await page.goto("/admin");
    const board = page.getByRole("table");
    await expect(
      board.getByRole("row", { name: new RegExp(`#\\d+\\s*${t1.teamCode}\\s*0`) }),
    ).toBeVisible();

    // A participant signs in with T1's credentials and M1's admission number.
    const participant = await browser.newContext({ baseURL: origin });
    await control("competition", { loginId: t1.loginId, status: "RUNNING" });
    const pp = await participant.newPage();
    await pp.goto("/login/participant");
    await pp.getByLabel("Team Login ID").fill(t1.loginId);
    await pp.getByLabel("Team Password").fill(t1.password);
    await pp.getByLabel("Admission Number").fill(t1.admission[0].toLowerCase()); // case-insensitive, like production
    await pp.getByRole("button", { name: "Sign in" }).click();
    await pp.waitForURL(reached("/participant"));
    await participant.close();

    // Another Admin cannot see or reach T1.
    const other = await browser.newContext({ baseURL: origin });
    await other.addCookies(
      await loginForCookies("/api/auth/staff/login", staffCredentials("e2e_admin")),
    );
    const api = other.request;
    const listed = await api.get("/api/admin/teams");
    expect(listed.status()).toBe(200);
    expect(JSON.stringify(await listed.json())).not.toContain(t1.teamCode);
    const otherPage = await other.newPage();
    await otherPage.goto("/admin/teams");
    await expect(otherPage.getByText(t1.teamCode)).toHaveCount(0);
    await expect(otherPage.getByText(t1.loginId)).toHaveCount(0);
    await other.close();
  });
});

test.describe("Create a New Admin dialog", () => {
  test("validates, rejects a duplicate username without leaking, and Go Back closes without creating", async ({
    page,
  }) => {
    await signInStaff(page, "e2e_super");
    await page.goto("/superadmin");
    const before = (await control("counts", {})) as { staff: number };
    await page.getByRole("button", { name: "Create admin" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Create a New Admin" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeVisible();

    // mismatched passwords → field message, nothing sent
    await dialog.getByLabel("Username").fill(`mm_${hex(3)}`);
    await dialog.getByLabel("Password", { exact: true }).fill(secret());
    await dialog.getByLabel("Retype Password").fill("not the same password");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog.getByText("The passwords don't match.")).toBeVisible();

    // an existing username
    await dialog.getByLabel("Username").fill("e2e_admin");
    const pw = secret();
    await dialog.getByLabel("Password", { exact: true }).fill(pw);
    await dialog.getByLabel("Retype Password").fill(pw);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog.getByText("That username is already taken.")).toBeVisible();
    await expect(dialog.getByLabel("Username")).toHaveValue("e2e_admin");

    // Go Back only closes
    await dialog.getByRole("button", { name: "Go Back" }).click();
    await expect(dialog).toBeHidden();
    const after = (await control("counts", {})) as { staff: number };
    expect(after.staff).toBe(before.staff);
  });
});

test.describe("Create a New Team dialog", () => {
  test("a double click creates ONE team; a duplicate Team ID is a field error and keeps the typing; Go Back creates nothing", async ({
    page,
  }, info) => {
    const tag = info.project.name === "mobile" ? "M" : "D";
    const admin = await createAdminViaUi(page, `b${tag.toLowerCase()}`);
    await signInAs(page, admin);

    await page.getByRole("button", { name: "Create a team" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Create a New Team" })).toBeVisible();
    const t = newTeam(tag);
    await fillTeam(page, t);
    await dialog.getByRole("button", { name: "Create Team" }).dblclick();
    await expect(dialog.getByRole("heading", { name: "Team created" })).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();
    await page.goto("/admin/teams");
    await expect(page.getByRole("row", { name: new RegExp(t.teamCode) })).toHaveCount(1);
    await page.goto("/admin");

    // same Team ID again, everything else new
    await page.getByRole("button", { name: "Create a team" }).click();
    const again = { ...newTeam(tag), teamCode: t.teamCode };
    await fillTeam(page, again);
    await dialog.getByRole("button", { name: "Create Team" }).click();
    await expect(dialog.getByText("That Team ID is already in use.")).toBeVisible();
    await expect(dialog.getByLabel("Login ID")).toHaveValue(again.loginId);

    // a member's admission number that already belongs to a team → that member's field
    await dialog.getByLabel("Team ID").fill(`${tag}${hex(3).toUpperCase()}`);
    await dialog.getByLabel("M3 Admission No.").fill(t.admission[2]);
    await dialog.getByRole("button", { name: "Create Team" }).click();
    await expect(
      dialog.getByText("M3's admission number is already registered to a team."),
    ).toBeVisible();

    // mismatched confirmation is caught in the browser
    await dialog.getByLabel("Confirm Password").fill("nope nope nope");
    await dialog.getByRole("button", { name: "Create Team" }).click();
    await expect(dialog.getByText("The passwords don't match.")).toBeVisible();

    const before = (await control("counts", {})) as { teams: number };
    await dialog.getByRole("button", { name: "Go Back" }).click();
    await expect(dialog).toBeHidden();
    expect(((await control("counts", {})) as { teams: number }).teams).toBe(before.teams);
  });
});

test.describe("authorization over HTTP", () => {
  const sameOrigin = { Origin: origin };

  test("signed-out callers get 401; roles are enforced on every provisioning route", async ({
    playwright,
  }) => {
    const anon = await request.newContext({ baseURL: origin });
    for (const [method, url] of [
      ["post", "/api/super/admins"],
      ["post", "/api/admin/teams"],
      ["get", "/api/admin/teams"],
      ["get", "/api/leaderboard"],
    ] as const) {
      const res = await anon[method](url, { headers: sameOrigin });
      expect(res.status(), `${method} ${url}`).toBe(401);
    }
    await anon.dispose();

    const adminCookies = await loginForCookies(
      "/api/auth/staff/login",
      staffCredentials("e2e_admin"),
    );
    const superCookies = await loginForCookies(
      "/api/auth/staff/login",
      staffCredentials("e2e_super"),
    );
    const as = async (cookies: typeof adminCookies) => {
      const ctx = await playwright.request.newContext({ baseURL: origin });
      await ctx.storageState(); // fresh jar
      return { ctx, cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
    };
    const admin = await as(adminCookies);
    const sup = await as(superCookies);
    const body = { data: {} };
    const headers = (cookie: string) => ({
      ...sameOrigin,
      cookie,
      "Idempotency-Key": crypto.randomUUID(),
    });

    // an Admin cannot create Admins; a Super Admin cannot create teams or list "my teams"
    expect(
      (
        await admin.ctx.post("/api/super/admins", { ...body, headers: headers(admin.cookie) })
      ).status(),
    ).toBe(403);
    expect(
      (await sup.ctx.post("/api/admin/teams", { ...body, headers: headers(sup.cookie) })).status(),
    ).toBe(403);
    expect(
      (await sup.ctx.get("/api/admin/teams", { headers: { cookie: sup.cookie } })).status(),
    ).toBe(403);
    // both may read the leaderboard, which carries only rank, team code and score
    for (const who of [admin, sup]) {
      const res = await who.ctx.get("/api/leaderboard", { headers: { cookie: who.cookie } });
      expect(res.status()).toBe(200);
      const rows = (await res.json()).data.rows as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(Object.keys(r).sort()).toEqual(["rank", "score", "team_id"]);
    }
    await admin.ctx.dispose();
    await sup.ctx.dispose();
  });

  test("a body cannot name an owner; a cross-site request is refused", async ({ playwright }) => {
    const cookies = await loginForCookies("/api/auth/staff/login", staffCredentials("e2e_admin"));
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const ctx = await playwright.request.newContext({ baseURL: origin });
    const t = newTeam("X");
    const data = {
      teamCode: t.teamCode,
      name: t.name,
      loginId: t.loginId,
      password: t.password,
      confirmPassword: t.password,
      admissionNos: t.admission,
    };
    const before = (await control("counts", {})) as { teams: number };
    const withOwner = await ctx.post("/api/admin/teams", {
      data: { ...data, adminId: "00000000-0000-4000-8000-000000000000" },
      headers: { ...sameOrigin, cookie, "Idempotency-Key": crypto.randomUUID() },
    });
    expect(withOwner.status()).toBe(400);
    const crossSite = await ctx.post("/api/admin/teams", {
      data,
      headers: {
        Origin: "https://evil.example",
        cookie,
        "Idempotency-Key": crypto.randomUUID(),
      },
    });
    expect(crossSite.status()).toBe(403);
    const noKey = await ctx.post("/api/admin/teams", { data, headers: { ...sameOrigin, cookie } });
    expect(noKey.status()).toBe(400);
    expect(((await control("counts", {})) as { teams: number }).teams).toBe(before.teams);
    await ctx.dispose();
  });

  test("the same Idempotency-Key replays instead of creating a second team", async ({
    playwright,
  }) => {
    const sup = await loginForCookies("/api/auth/staff/login", staffCredentials("e2e_super"));
    const cookie = sup.map((c) => `${c.name}=${c.value}`).join("; ");
    const ctx = await playwright.request.newContext({ baseURL: origin });
    const key = crypto.randomUUID();
    const data = {
      username: `idem_${hex(4)}`,
      password: secret(),
    };
    const post = () =>
      ctx.post("/api/super/admins", {
        data: { ...data, confirmPassword: data.password },
        headers: { ...sameOrigin, cookie, "Idempotency-Key": key },
      });
    const first = await post();
    expect(first.status()).toBe(200);
    const before = (await control("counts", {})) as { staff: number };
    const second = await post();
    expect(second.status()).toBe(200);
    expect(second.headers()["idempotent-replay"]).toBe("true");
    expect(((await control("counts", {})) as { staff: number }).staff).toBe(before.staff);
    const text = JSON.stringify(await first.json()) + JSON.stringify(await second.json());
    expect(text).not.toContain(data.password);
    expect(text.toLowerCase()).not.toContain("hash");
    await ctx.dispose();
  });
});

test.describe("route guards for the new pages", () => {
  test("/admin/teams is for Admins only", async ({ page, browser }) => {
    const anon = await browser.newContext({ baseURL: origin });
    const res = await anon.request.get("/admin/teams", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers().location).toContain("/login/admin");
    await anon.close();

    await signInStaff(page, "e2e_super");
    await page.goto("/admin/teams");
    await expect(page).toHaveURL(`${origin}/superadmin`);
  });
});

test.describe("accessibility of the staff pages and dialogs", () => {
  test("no axe violations on /admin, /admin/teams, /superadmin and both dialogs", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const scan = async (what: string) => {
      await page.waitForTimeout(800);
      const results = await new AxeBuilder({ page }).analyze();
      expect(
        results.violations.map((v) => `${v.id}: ${v.help}`),
        what,
      ).toEqual([]);
    };

    await signInStaff(page, "e2e_admin");
    await page.goto("/admin");
    await scan("/admin");
    await page.getByRole("button", { name: "Create a team" }).click();
    await expect(page.getByRole("dialog", { name: "Create a New Team" })).toBeVisible();
    await scan("create team dialog");
    await page.getByRole("button", { name: "Go Back" }).click();
    await page.goto("/admin/teams");
    await scan("/admin/teams");

    await page.context().clearCookies();
    await signInStaff(page, "e2e_super");
    await page.goto("/superadmin");
    await scan("/superadmin");
    await page.getByRole("button", { name: "Create admin" }).click();
    await expect(page.getByRole("dialog", { name: "Create a New Admin" })).toBeVisible();
    await scan("create admin dialog");
  });
});

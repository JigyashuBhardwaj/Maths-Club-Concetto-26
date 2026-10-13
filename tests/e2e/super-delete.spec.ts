import AxeBuilder from "@axe-core/playwright";
import { randomBytes } from "node:crypto";

import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";

import { control, loginForCookies, signInStaff, staffCredentials } from "./support/session";

const origin = `http://localhost:${process.env.PORT ?? 3100}`;
const sameOrigin = { Origin: origin };
const hex = (n: number) => randomBytes(n).toString("hex");
const secret = () => `Pw-${randomBytes(12).toString("base64url")}`;

// Permanent deletion of Admins and Teams (B18) in a real browser against the real routes, with the in-memory stand-in
// behind the API. The stand-in is shared by every test and both projects, so each test creates its own throwaway admin
// and teams (random names) and only ever selects those rows: it never touches e2e_admin or the shared teams.
test.describe.configure({ timeout: 120_000 });

const cookieHeader = (cs: { name: string; value: string }[]) =>
  cs.map((c) => `${c.name}=${c.value}`).join("; ");

async function api(cookie?: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { ...sameOrigin, ...(cookie ? { cookie } : {}) },
  });
}

async function makeAdmin(superCookie: string, tag: string) {
  const ctx = await api(superCookie);
  const username = `del_${tag}_${hex(3)}`;
  const password = secret();
  const res = await ctx.post("/api/super/admins", {
    data: { username, password, confirmPassword: password },
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
  expect(res.status()).toBe(200);
  const id = (await res.json()).data.admin.id as string;
  await ctx.dispose();
  return { username, password, id };
}

async function makeTeam(adminCookie: string, tag: string) {
  const ctx = await api(adminCookie);
  const n = hex(3).toUpperCase();
  const t = {
    teamCode: `${tag}${n}`,
    name: `Del ${tag} ${n}`,
    loginId: `del_${tag.toLowerCase()}_${n.toLowerCase()}`,
    password: secret(),
    admission: [1, 2, 3, 4].map((i) => `DEL${tag}${n}${i}`),
  };
  const res = await ctx.post("/api/admin/teams", {
    data: {
      teamCode: t.teamCode,
      name: t.name,
      loginId: t.loginId,
      password: t.password,
      confirmPassword: t.password,
      admissionNos: t.admission,
    },
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
  expect(res.status()).toBe(200);
  await ctx.dispose();
  return t;
}

async function staffCookie(username: string, password: string) {
  return cookieHeader(await loginForCookies("/api/auth/staff/login", { username, password }));
}
async function teamCookie(t: Awaited<ReturnType<typeof makeTeam>>) {
  return cookieHeader(
    await loginForCookies("/api/auth/participant/login", {
      teamLoginId: t.loginId,
      password: t.password,
      admissionNo: t.admission[0]!,
    }),
  );
}
async function whoami(cookie: string) {
  const ctx = await api(cookie);
  const res = await ctx.get("/api/super/teams"); // 401 signed-out, 403 signed-in but not the Super Admin
  const s = res.status();
  await ctx.dispose();
  return s;
}

async function confirmDeletion(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Yes" }).click();
  await expect(dialog).toBeHidden();
}

test.describe("Delete Teams", () => {
  test("the Super Admin selects a team of any admin, cancels, then confirms; its sign-in dies and its login ID is free", async ({
    page,
  }, info) => {
    const sup = cookieHeader(
      await loginForCookies("/api/auth/staff/login", staffCredentials("e2e_super")),
    );
    const owner = await makeAdmin(sup, info.project.name === "mobile" ? "tm" : "td");
    const ownerCookie = await staffCookie(owner.username, owner.password);
    const doomed = await makeTeam(ownerCookie, "X");
    const kept = await makeTeam(ownerCookie, "K");
    const doomedCookie = await teamCookie(doomed);
    const keptCookie = await teamCookie(kept);

    await signInStaff(page, "e2e_super");
    await page.goto("/superadmin");
    await page.getByRole("link", { name: "Delete teams" }).click();
    await page.waitForURL((u) => u.pathname === "/superadmin/delete-teams");
    await expect(page.getByRole("heading", { name: "Delete Teams" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Go back/ })).toHaveAttribute(
      "href",
      "/superadmin",
    );

    const trash = page.getByRole("button", { name: /^Delete selected/ });
    await expect(trash).toBeDisabled();
    await page.getByRole("checkbox", { name: new RegExp(`Select ${doomed.teamCode}`) }).check();
    await expect(page.getByTestId("selected-count")).toHaveText("1 selected");
    await trash.click();

    // No: nothing changes
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText("Do you want to permanently delete the selected team?"),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "No" }).click();
    await expect(dialog).toBeHidden();
    expect(await whoami(doomedCookie)).toBe(403); // alive: signed in as a team, just not staff
    await expect(page.getByTestId("selected-count")).toHaveText("1 selected");

    // Yes: only that team goes
    await trash.click();
    await confirmDeletion(page);
    await expect(page.getByRole("status")).toContainText("Deleted 1 team.");
    await expect(
      page.getByRole("checkbox", { name: new RegExp(`Select ${doomed.teamCode}`) }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("checkbox", { name: new RegExp(`Select ${kept.teamCode}`) }),
    ).toBeVisible();
    await expect(page.getByTestId("selected-count")).toHaveText("0 selected");

    // the deleted team's old cookie and credentials are dead; the other team and the admin are fine
    expect(await whoami(doomedCookie)).toBe(401);
    expect(await whoami(keptCookie)).toBe(403);
    expect(await whoami(ownerCookie)).toBe(403);
    const ctx = await request.newContext({ baseURL: origin, extraHTTPHeaders: sameOrigin });
    const login = await ctx.post("/api/auth/participant/login", {
      data: {
        teamLoginId: doomed.loginId,
        password: doomed.password,
        admissionNo: doomed.admission[0],
      },
    });
    expect(login.status()).toBe(401);
    await ctx.dispose();

    // the code, login ID and admission numbers are reusable by the normal creation flow
    const reborn = await api(ownerCookie);
    const again = await reborn.post("/api/admin/teams", {
      data: {
        teamCode: doomed.teamCode,
        name: "Reborn",
        loginId: doomed.loginId,
        password: doomed.password,
        confirmPassword: doomed.password,
        admissionNos: doomed.admission,
      },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    expect(again.status()).toBe(200);
    await reborn.dispose();

    // clean up what the test created (also exercises multi-select through the API)
    const del = await api(sup);
    const teams = (await (await del.get("/api/super/teams")).json()).data.teams as {
      id: string;
      admin_username: string;
    }[];
    const mine = teams.filter((t) => t.admin_username === owner.username).map((t) => t.id);
    expect(mine.length).toBe(2);
    const res = await del.post("/api/super/teams/delete", {
      data: { teamIds: mine },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    expect(res.status()).toBe(200);
    await del.dispose();
  });
});

test.describe("Delete Admins", () => {
  test("deleting an admin removes its teams and its sign-in, and the username can be created again", async ({
    page,
  }, info) => {
    const sup = cookieHeader(
      await loginForCookies("/api/auth/staff/login", staffCredentials("e2e_super")),
    );
    const victim = await makeAdmin(sup, info.project.name === "mobile" ? "am" : "ad");
    const bystander = await makeAdmin(sup, info.project.name === "mobile" ? "bm" : "bd");
    const victimCookie = await staffCookie(victim.username, victim.password);
    const bystanderCookie = await staffCookie(bystander.username, bystander.password);
    const team = await makeTeam(victimCookie, "V");
    const teamCookieValue = await teamCookie(team);
    const before = (await control("counts", {})) as { teams: number; staff: number };

    await signInStaff(page, "e2e_super");
    await page.goto("/superadmin/delete-admins");
    await expect(page.getByRole("heading", { name: "Delete Admins" })).toBeVisible();
    // the Super Admin is never offered
    await expect(page.getByRole("checkbox", { name: "Select e2e_super" })).toHaveCount(0);

    await page.getByRole("checkbox", { name: `Select ${victim.username}` }).check();
    await page.getByRole("button", { name: /^Delete selected/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText("Do you want to permanently delete the selected admin?"),
    ).toBeVisible();
    await expect(dialog.getByText(/1 team and all its members/)).toBeVisible();
    await confirmDeletion(page);
    await expect(page.getByRole("status")).toContainText("Deleted 1 admin and 1 team.");
    await expect(page.getByRole("checkbox", { name: `Select ${victim.username}` })).toHaveCount(0);
    await expect(
      page.getByRole("checkbox", { name: `Select ${bystander.username}` }),
    ).toBeVisible();

    const after = (await control("counts", {})) as { teams: number; staff: number };
    expect(after.staff).toBe(before.staff - 1);
    expect(after.teams).toBe(before.teams - 1);

    // everything of the victim stopped working; the bystander is untouched
    expect(await whoami(victimCookie)).toBe(401);
    expect(await whoami(teamCookieValue)).toBe(401);
    expect(await whoami(bystanderCookie)).toBe(403);
    const ctx = await request.newContext({ baseURL: origin, extraHTTPHeaders: sameOrigin });
    const login = await ctx.post("/api/auth/staff/login", {
      data: { username: victim.username, password: victim.password },
    });
    expect(login.status()).toBe(401);
    await ctx.dispose();

    // the username is free again, with a new identity, and uniqueness holds for live accounts
    const reuse = await api(sup);
    const body = {
      username: victim.username,
      password: victim.password,
      confirmPassword: victim.password,
    };
    const first = await reuse.post("/api/super/admins", {
      data: body,
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    expect(first.status()).toBe(200);
    const rebornId = (await first.json()).data.admin.id as string;
    expect(rebornId).not.toBe(victim.id);
    const second = await reuse.post("/api/super/admins", {
      data: body,
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    expect(second.status()).toBe(409);

    // tidy up the throwaway admins
    const ids = [rebornId, bystander.id]; // only this test's own admins: other tests run in parallel on the same stand-in
    const gone = await reuse.post("/api/super/admins/delete", {
      data: { adminIds: ids },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    expect(gone.status()).toBe(200);
    await reuse.dispose();
  });
});

test.describe("DELETE_BLOCKED (a record elsewhere still references the selection)", () => {
  // The stand-in refuses like migration 20 does: the whole request is rolled back, 409 DELETE_BLOCKED, and the browser
  // sees a fixed sentence. The names of the foreign key and table (logged on the server only) must never reach it.
  const LEAKS =
    /_fkey|reviewed_by|created_by|coin_transactions|staff_users|some_future|ufm_|constraint|foreign key/i;

  test("admins: a blocked selection changes nothing and says so; selecting both sides together succeeds", async ({
    page,
  }, info) => {
    const sup = cookieHeader(
      await loginForCookies("/api/auth/staff/login", staffCredentials("e2e_super")),
    );
    const tag = info.project.name === "mobile" ? "bm" : "bd";
    const owner = await makeAdmin(sup, tag); // referenced by `holder` (as if holder.created_by = owner)
    const holder = await makeAdmin(sup, tag);
    const ownerCookie = await staffCookie(owner.username, owner.password);
    const team = await makeTeam(ownerCookie, "B");
    await control("blockDeletion", {
      kind: "admin",
      target: owner.username,
      partner: holder.username,
      constraint: "staff_users_created_by_fkey",
      table: "staff_users",
    });
    const liveBefore = await control("liveSessions", { username: owner.username });
    expect(liveBefore).toEqual({ live: 1 });

    await signInStaff(page, "e2e_super");
    await page.goto("/superadmin/delete-admins");
    const dialog = page.getByRole("dialog");
    const trash = page.getByRole("button", { name: /^Delete selected/ });
    await page.getByRole("checkbox", { name: `Select ${owner.username}` }).check();
    await trash.click();
    const [refused] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/super/admins/delete")),
      dialog.getByRole("button", { name: "Yes" }).click(),
    ]);
    expect(refused.status()).toBe(409);
    const refusedText = await refused.text();
    const refusedBody = JSON.parse(refusedText) as {
      ok: boolean;
      error: { code: string; details?: unknown };
    };
    expect(refusedBody.ok).toBe(false);
    expect(refusedBody.error.code).toBe("DELETE_BLOCKED");
    expect(refusedBody.error.details).toBeUndefined();
    expect(refusedText).not.toMatch(LEAKS);

    // the dialog stays open with the fixed sentence, nothing is reported as deleted, the selection is kept
    await expect(dialog.getByRole("alert")).toHaveText(
      "Nothing was deleted: some of these admins are still referenced by other records.",
    );
    expect(await page.locator("body").innerText()).not.toMatch(LEAKS);
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByTestId("selected-count")).toHaveText("1 selected");
    // atomic: both admins and the team are still listed (the stand-in is shared with parallel tests, so no global counts),
    // and the owner, its session and its team still work
    const listed = await api(sup);
    const admins = (await (await listed.get("/api/super/admins")).json()).data.admins as {
      username: string;
      team_count: number;
    }[];
    expect(admins.find((a) => a.username === owner.username)?.team_count).toBe(1);
    expect(admins.some((a) => a.username === holder.username)).toBe(true);
    await listed.dispose();
    expect(await whoami(ownerCookie)).toBe(403);
    expect(await whoami(await teamCookie(team))).toBe(403);
    expect(await control("liveSessions", { username: owner.username })).toEqual(liveBefore);

    // select the other side as well: both go together, and so does the owner's team
    await dialog.getByRole("button", { name: "No" }).click();
    await page.getByRole("checkbox", { name: `Select ${holder.username}` }).check();
    await expect(page.getByTestId("selected-count")).toHaveText("2 selected");
    await trash.click();
    await confirmDeletion(page);
    await expect(page.getByRole("status")).toContainText("Deleted 2 admins and 1 team.");
    expect(await whoami(ownerCookie)).toBe(401);
    await control("unblockDeletion", { kind: "admin", target: owner.username });
  });

  test("API: the partner alone goes, the same Idempotency-Key is not poisoned by a refused attempt, and a team blocker behaves the same", async ({}, info) => {
    const sup = cookieHeader(
      await loginForCookies("/api/auth/staff/login", staffCredentials("e2e_super")),
    );
    const tag = info.project.name === "mobile" ? "cm" : "cd";
    const owner = await makeAdmin(sup, tag);
    const holder = await makeAdmin(sup, tag);
    const ownerCookie = await staffCookie(owner.username, owner.password);
    const t1 = await makeTeam(ownerCookie, "C");
    const t2 = await makeTeam(ownerCookie, "D");
    const ctx = await api(sup);
    const teams = async () =>
      (await (await ctx.get("/api/super/teams")).json()).data.teams as {
        id: string;
        team_code: string;
      }[];
    const idOf = async (code: string) => (await teams()).find((t) => t.team_code === code)!.id;
    const t1Id = await idOf(t1.teamCode);
    const t2Id = await idOf(t2.teamCode);

    // an unknown foreign key that references a team: refused whole, even though the other team in the request is fine
    await control("blockDeletion", {
      kind: "team",
      target: t1.teamCode,
      constraint: "some_future_table_team_id_fkey",
      table: "some_future_table",
    });
    const key = crypto.randomUUID();
    const blockedTeams = await ctx.post("/api/super/teams/delete", {
      data: { teamIds: [t1Id, t2Id] },
      headers: { "Idempotency-Key": key },
    });
    expect(blockedTeams.status()).toBe(409);
    const blockedText = await blockedTeams.text();
    expect(JSON.parse(blockedText).error).toEqual(
      expect.objectContaining({ code: "DELETE_BLOCKED" }),
    );
    expect(JSON.parse(blockedText).error.details).toBeUndefined();
    expect(blockedText).not.toMatch(/some_future|_fkey|constraint/i);
    expect((await teams()).map((t) => t.team_code)).toEqual(
      expect.arrayContaining([t1.teamCode, t2.teamCode]), // the innocent team was NOT deleted either
    );
    // once the reference is gone, the very same request (same key) is executed, not replayed as a failure
    await control("unblockDeletion", { kind: "team", target: t1.teamCode });
    const retried = await ctx.post("/api/super/teams/delete", {
      data: { teamIds: [t1Id, t2Id] },
      headers: { "Idempotency-Key": key },
    });
    expect(retried.status()).toBe(200);
    expect(retried.headers()["idempotent-replay"]).toBeUndefined(); // executed, not replayed

    // admins: the holder (the side that owns the reference) can go alone; the referenced owner cannot go before it
    await control("blockDeletion", {
      kind: "admin",
      target: owner.username,
      partner: holder.username,
      constraint: "submissions_reviewed_by_fkey",
      table: "submissions",
    });
    const alone = await ctx.post("/api/super/admins/delete", {
      data: { adminIds: [owner.id] },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    expect(alone.status()).toBe(409);
    const aloneText = await alone.text();
    expect(aloneText).not.toMatch(LEAKS);
    expect(aloneText).not.toContain("submissions");
    const holderGone = await ctx.post("/api/super/admins/delete", {
      data: { adminIds: [holder.id] },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    expect(holderGone.status()).toBe(200);
    const ownerGone = await ctx.post("/api/super/admins/delete", {
      data: { adminIds: [owner.id] },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    expect(ownerGone.status()).toBe(200); // the reference left with its holder
    await control("unblockDeletion", { kind: "admin", target: owner.username });
    await ctx.dispose();
  });
});

test.describe("authorization and navigation", () => {
  test("only the Super Admin can open the screens or call the routes", async ({
    browser,
    playwright,
  }) => {
    const anon = await browser.newContext({ baseURL: origin });
    for (const p of ["/superadmin/delete-admins", "/superadmin/delete-teams"]) {
      const res = await anon.request.get(p, { maxRedirects: 0 });
      expect(res.status()).toBe(307);
      expect(res.headers().location).toContain("/login/superadmin");
    }
    await anon.close();

    const admin = cookieHeader(
      await loginForCookies("/api/auth/staff/login", staffCredentials("e2e_admin")),
    );
    const ctx = await playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { ...sameOrigin, cookie: admin },
    });
    const page = await ctx.get("/superadmin/delete-teams", { maxRedirects: 0 });
    expect(page.status()).toBe(307);
    expect(page.headers().location).not.toContain("delete-teams");
    for (const [method, url, data] of [
      ["get", "/api/super/admins", undefined],
      ["get", "/api/super/teams", undefined],
      ["post", "/api/super/admins/delete", { adminIds: [crypto.randomUUID()] }],
      ["post", "/api/super/teams/delete", { teamIds: [crypto.randomUUID()] }],
    ] as const) {
      const res = await (method === "get"
        ? ctx.get(url)
        : ctx.post(url, { data, headers: { "Idempotency-Key": crypto.randomUUID() } }));
      expect(res.status(), `${method} ${url}`).toBe(403);
    }
    await ctx.dispose();
  });

  test("the Super Admin cannot delete themselves through the API, and a cross-site POST is refused", async ({
    playwright,
  }) => {
    const sup = cookieHeader(
      await loginForCookies("/api/auth/staff/login", staffCredentials("e2e_super")),
    );
    const ctx = await playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { ...sameOrigin, cookie: sup },
    });
    const mine = (await control("staffId", { username: "e2e_super" })) as unknown as string;
    const self = await ctx.post("/api/super/admins/delete", {
      data: { adminIds: [mine] },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    expect(self.status()).toBe(403);
    const cross = await ctx.post("/api/super/teams/delete", {
      data: { teamIds: [crypto.randomUUID()] },
      headers: { Origin: "https://evil.example", "Idempotency-Key": crypto.randomUUID() },
    });
    expect(cross.status()).toBe(403);
    expect(await whoami(sup)).toBe(200); // still the Super Admin
    await ctx.dispose();
  });

  test("no axe violations on either screen or the confirmation dialog", async ({ page }) => {
    test.setTimeout(180_000);
    const scan = async (what: string) => {
      await page.waitForTimeout(600);
      const results = await new AxeBuilder({ page }).analyze();
      expect(
        results.violations.map((v) => `${v.id}: ${v.help}`),
        what,
      ).toEqual([]);
    };
    await signInStaff(page, "e2e_super");
    await page.goto("/superadmin/delete-admins");
    await scan("delete admins");
    await page.goto("/superadmin/delete-teams");
    await scan("delete teams");
    const box = page.getByRole("checkbox", { name: /^Select / }).first();
    if (await box.count()) {
      await box.check();
      await page.getByRole("button", { name: /^Delete selected/ }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await scan("confirmation dialog");
      await page.getByRole("button", { name: "No" }).click();
    }
  });
});

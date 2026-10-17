import AxeBuilder from "@axe-core/playwright";
import { randomBytes } from "node:crypto";

import { expect, request, test, type Page } from "@playwright/test";

import { api as gameApi, createPlayerTeam, beginTheme, player } from "./support/game";
import { installFullscreenShim } from "./support/fullscreen-shim";
import { control, loginForCookies, signInStaff, staffCredentials } from "./support/session";

/**
 * "Renew the Competition" (Super Admin) in a real browser against the real routes, with the in-memory stand-in behind the API.
 *
 * A renewal deletes EVERY Admin the Super Admin created and their teams, and resets the competition: that would pull the rug from
 * under every other spec sharing the stand-in. So this file runs in its own Playwright project ("renewal"), after all the others
 * have finished (see playwright.config.ts), and its tests run in order: the earlier ones leave the data alone, the last one renews.
 */
test.describe.configure({ mode: "serial", timeout: 180_000 });

const origin = `http://localhost:${process.env.PORT ?? 3100}`;
const hex = (n: number) => randomBytes(n).toString("hex");
const cookieHeader = (cs: { name: string; value: string }[]) =>
  cs.map((c) => `${c.name}=${c.value}`).join("; ");

async function apiCtx(cookie?: string) {
  return request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin, ...(cookie ? { cookie } : {}) },
  });
}
async function superApi() {
  return apiCtx(
    cookieHeader(await loginForCookies("/api/auth/staff/login", staffCredentials("e2e_super"))),
  );
}

/** The participant of the team created after the renewal (set by the renewal test, used by the lifecycle tests that follow it). */
let afterTeam: { teamLoginId: string; password: string; admissionNo: string } | null = null;

async function openEditor(page: Page) {
  await signInStaff(page, "e2e_super");
  await page.goto("/superadmin");
  await page.getByRole("link", { name: "Renew the competition" }).click();
  await page.waitForURL((u) => u.pathname === "/superadmin/renew");
  await expect(
    page.getByRole("heading", { level: 1, name: "Renew the Competition" }),
  ).toBeVisible();
}
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
const applyDialog = (page: Page) => page.getByRole("dialog", { name: "Apply Changes" });
async function confirm(page: Page) {
  await page.getByRole("button", { name: "APPLY CHANGES" }).click();
  await expect(applyDialog(page)).toBeVisible();
  await applyDialog(page).getByRole("button", { name: "YES, APPLY CHANGES" }).click();
}

test.describe("Renew the Competition", () => {
  test("only the Super Admin can open the page or call its API", async ({ page }) => {
    // signed out
    await page.goto("/superadmin/renew");
    await expect(page.getByRole("heading", { name: "Renew the Competition" })).toHaveCount(0);
    // an Admin
    await signInStaff(page, "e2e_admin");
    await page.goto("/superadmin/renew");
    await expect(page.getByRole("heading", { name: "Renew the Competition" })).toHaveCount(0);
    expect(new URL(page.url()).pathname).not.toBe("/superadmin/renew");
    // the API says no as well, and a rejected call changes nothing
    const adminCookie = cookieHeader(
      await loginForCookies("/api/auth/staff/login", staffCredentials("e2e_admin")),
    );
    const as = await apiCtx(adminCookie);
    expect((await as.get("/api/super/renew")).status()).toBe(403);
    expect(
      (
        await as.post("/api/super/renew", {
          data: { content: {}, expectedToken: "a".repeat(64) },
          headers: { "Idempotency-Key": crypto.randomUUID() },
        })
      ).status(),
    ).toBe(403);
    await as.dispose();
    const anon = await apiCtx();
    expect((await anon.get("/api/super/renew")).status()).toBe(401);
    await anon.dispose();
  });

  test("the sidebar entry opens the editor: Go back, the title, every theme with its questions, hints, rewards, and the rules", async ({
    page,
  }) => {
    await openEditor(page);
    await expect(page.getByRole("link", { name: /Go back/ })).toHaveAttribute(
      "href",
      "/superadmin",
    );
    // 10 themes × (2 + 5 × 4) fields, plus the rules
    for (const code of "ABCDEFGHIJ") {
      await expect(field(page, `Theme ${code} name`)).not.toHaveValue("");
      await expect(field(page, `Theme ${code} description`)).not.toHaveValue("");
      for (const n of [1, 2, 3, 4, 5]) {
        await expect(field(page, `Question ${code}.${n}`)).not.toHaveValue("");
        await expect(field(page, `Hint 1 of ${code}.${n}`)).not.toHaveValue("");
        await expect(field(page, `Hint 2 of ${code}.${n}`)).not.toHaveValue("");
        await expect(field(page, `Reward of ${code}.${n}`)).toHaveValue(/^[1-9][0-9]*$/);
      }
    }
    await expect(page.getByRole("heading", { name: "Rules and regulations" })).toBeVisible();
    await expect(field(page, "Rule 1")).not.toHaveValue("");
    // the page scrolls: the buttons are at the very end
    const apply = page.getByRole("button", { name: "APPLY CHANGES" });
    await apply.scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "RESET" })).toBeVisible();
    await expect(page.getByTestId("renew-readiness")).toBeVisible();
  });

  test("it is responsive: no horizontal scrolling on a phone-sized screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openEditor(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await field(page, "Reward of J.5").scrollIntoViewIfNeeded();
    await expect(field(page, "Reward of J.5")).toBeVisible();
  });

  test("no axe violations", async ({ page }) => {
    await openEditor(page);
    await page.waitForTimeout(1000);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test("editing, RESET, GO BACK, the unsaved-changes warning and incomplete content: none of them changes the database", async ({
    page,
  }) => {
    const before = (await control("renewalState", {})) as { token: string };
    await openEditor(page);
    const original = await field(page, "Theme A name").inputValue();
    const multiline = "Line one\n\nLine “two”, (punctuated)! — 日本語";

    await field(page, "Theme A name").fill("Edited A");
    await field(page, "Question B.2").fill(multiline);
    await field(page, "Hint 2 of C.3").fill("A new hint");
    await field(page, "Reward of D.4").fill("321");
    await field(page, "Rule 1").fill("An edited rule");
    const rulesBefore = await page.getByRole("button", { name: /^Remove rule/ }).count();
    await page.getByRole("button", { name: /Add\+/ }).click();
    await field(page, `Rule ${rulesBefore + 1}`).fill("A brand new rule");
    await expect(field(page, "Question B.2")).toHaveValue(multiline);

    // RESET puts everything back and sends nothing
    await page.getByRole("button", { name: "RESET" }).click();
    await expect(field(page, "Theme A name")).toHaveValue(original);
    await expect(page.getByLabel(`Rule ${rulesBefore + 1}`, { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("renew-dirty")).toHaveCount(0);

    // GO BACK closes the dialog and keeps the edits
    await field(page, "Theme A name").fill("Edited A");
    await page.getByRole("button", { name: "APPLY CHANGES" }).click();
    const dialog = applyDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      "Are you sure you want to apply the changes? Doing so will delete all admins created by the Superadmin and, consequently, all teams created by those admins. The edited competition content will also be applied.",
    );
    await dialog.getByRole("button", { name: "GO BACK" }).click();
    await expect(dialog).toBeHidden();
    await expect(field(page, "Theme A name")).toHaveValue("Edited A");

    // leaving with edits asks first; staying keeps them
    await page.getByRole("link", { name: "Delete teams" }).click();
    const leave = page.getByRole("dialog", { name: "Leave without applying?" });
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Stay on this page" }).click();
    await expect(leave).toBeHidden();
    expect(new URL(page.url()).pathname).toBe("/superadmin/renew");
    await expect(field(page, "Theme A name")).toHaveValue("Edited A");

    // incomplete content never reaches the dialog or the server
    await field(page, "Hint 1 of E.1").fill("   ");
    await field(page, "Reward of E.1").fill("0");
    await page.getByRole("button", { name: "APPLY CHANGES" }).click();
    await expect(applyDialog(page)).toBeHidden();
    await expect(page.getByTestId("renew-error")).toContainText("Fix 2 fields");
    await expect(field(page, "Hint 1 of E.1")).toHaveAttribute("aria-invalid", "true");
    await expect(field(page, "Reward of E.1")).toHaveAttribute("aria-invalid", "true");

    // after "Leave and discard" the edits are gone, and the database never changed
    await page.getByRole("link", { name: /Go back/ }).click();
    await page.getByRole("button", { name: "Leave and discard" }).click();
    await page.waitForURL((u) => u.pathname === "/superadmin");
    expect(((await control("renewalState", {})) as { token: string }).token).toBe(before.token);
  });

  test("a team that is playing blocks the renewal: it says which, nothing is deleted or changed, the edits stay", async ({
    page,
  }) => {
    // When the whole suite runs first, other specs have left dozens of teams that are still "playing" (the editor lists at most
    // ten blockers). Let their time run out so that the team created here is the one, and the only one, that blocks.
    await control("ageAllTeams", { ms: 14_400_000 + 5000 });
    const team = await createPlayerTeam();
    await beginTheme(team); // theme unlocked, question A.1 ACTIVE
    const before = (await control("renewalState", {})) as { token: string };
    const admins = await superApi();
    const listed = async () =>
      ((await (await admins.get("/api/super/admins")).json()).data.admins as unknown[]).length;
    const adminCount = await listed();

    await openEditor(page);
    await expect(page.getByTestId("renew-readiness")).toContainText("Not ready");
    await expect(page.getByTestId("renew-readiness")).toContainText(team.code);
    await field(page, "Theme A name").fill("Must not be applied");
    await confirm(page);
    await expect(page.getByTestId("renew-error")).toContainText("Nothing was changed");
    await expect(page.getByTestId("renew-error")).toContainText("Some teams are still playing");
    await expect(page.getByTestId("renew-notice")).toHaveCount(0); // never a success message
    await expect(field(page, "Theme A name")).toHaveValue("Must not be applied");

    expect(((await control("renewalState", {})) as { token: string }).token).toBe(before.token);
    expect(await listed()).toBe(adminCount);
    // the playing team is untouched: its session still works
    const ctx = await gameApi(
      await loginForCookies("/api/auth/participant/login", {
        teamLoginId: team.loginId,
        password: team.password,
        admissionNo: team.members[0]!.admissionNo,
      }),
    );
    expect((await player(ctx).state()).ok).toBe(true);
    await ctx.dispose();
    await admins.dispose();
  });

  test("another Super Admin's change after the page loaded: the stale edit is refused, whether it is noticed when the dialog opens or after YES, and nothing is deleted", async ({
    page,
  }) => {
    await control("ageAllTeams", { ms: 14_400_000 + 5000 }); // nobody is playing any more
    const sup = await superApi();
    const adminCount = async () =>
      ((await (await sup.get("/api/super/admins")).json()).data.admins as unknown[]).length;
    const admins = await adminCount();
    expect(admins).toBeGreaterThan(0);
    const apply = page.getByRole("button", { name: "APPLY CHANGES" });

    // (a) the content changed after the page loaded: noticed when the Apply dialog re-reads the server, nothing can be confirmed
    await openEditor(page);
    await field(page, "Theme A name").fill("My late edit");
    await control("editThemeName", { code: "B", name: "Changed behind your back" });
    await apply.click();
    await expect(page.getByTestId("renew-stale")).toBeVisible();
    await expect(page.getByTestId("renew-stale")).toContainText("changed by someone else");
    await expect(applyDialog(page)).toBeHidden();
    await expect(apply).toBeDisabled();
    // edits are not lost silently; loading the latest replaces them on purpose
    await expect(field(page, "Theme A name")).toHaveValue("My late edit");
    await page.getByRole("button", { name: /Discard my edits and load the latest/ }).click();
    await expect(field(page, "Theme B name")).toHaveValue("Changed behind your back");
    await expect(field(page, "Theme A name")).not.toHaveValue("My late edit");
    await expect(apply).toBeEnabled();
    expect(await adminCount()).toBe(admins);

    // (b) the content changes while the dialog is open (after its check, before YES): the server refuses the renewal
    await field(page, "Theme A name").fill("My second edit");
    await apply.click();
    const yes = applyDialog(page).getByRole("button", { name: "YES, APPLY CHANGES" });
    await expect(yes).toBeEnabled();
    await control("editThemeName", { code: "C", name: "Changed while the dialog was open" });
    await yes.click();
    await expect(page.getByTestId("renew-stale")).toBeVisible();
    await expect(page.getByTestId("renew-error")).toContainText("changed by someone else");
    await expect(page.getByTestId("renew-notice")).toHaveCount(0); // never a success message
    await expect(apply).toBeDisabled();
    await expect(field(page, "Theme A name")).toHaveValue("My second edit");
    expect(await adminCount()).toBe(admins); // nothing was deleted
    await sup.dispose();
  });

  test("a submission awaiting approval is announced, with its number, in the confirmation dialog before anything is discarded", async ({
    page,
  }) => {
    const team = await createPlayerTeam();
    await beginTheme(team); // question A.1 ACTIVE
    const ctx = await gameApi(
      await loginForCookies("/api/auth/participant/login", {
        teamLoginId: team.loginId,
        password: team.password,
        admissionNo: team.members[0]!.admissionNo,
      }),
    );
    expect((await player(ctx).submit(1, "my answer")).status).toBe(200); // now PENDING_APPROVAL
    await ctx.dispose();
    const before = (await control("renewalState", {})) as { token: string };

    await openEditor(page);
    await expect(page.getByTestId("renew-readiness")).toContainText(
      "awaiting approval will be discarded",
    );
    await field(page, "Theme A name").fill("Not applied");
    await page.getByRole("button", { name: "APPLY CHANGES" }).click();
    const warning = applyDialog(page).getByTestId("renew-pending-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(
      /Warning: [1-9]\d* submissions? still awaiting approval will be permanently discarded together with (its team|their teams)\./,
    );
    await expect(
      applyDialog(page).getByRole("button", { name: "YES, APPLY CHANGES" }),
    ).toBeEnabled();
    await applyDialog(page).getByRole("button", { name: "GO BACK" }).click();
    await expect(applyDialog(page)).toBeHidden();
    await expect(field(page, "Theme A name")).toHaveValue("Not applied"); // the edit is kept
    expect(((await control("renewalState", {})) as { token: string }).token).toBe(before.token); // nothing was applied
  });

  test("applying: the admins and their teams are deleted, the content and rules go live, the Super Admin stays, and new admins and teams can be provisioned", async ({
    page,
  }) => {
    const renamed = `Renewed theme ${hex(2)} “C”`;
    const rules = ["First renewed rule.", "Second renewed rule:\nwith a second line."];

    await control("ageAllTeams", { ms: 14_400_000 + 5000 }); // every team is finished or out of time
    await openEditor(page);
    await expect(page.getByTestId("renew-readiness")).toContainText("Ready to apply");

    await field(page, "Theme C name").fill(renamed);
    await field(page, "Theme C description").fill("A renewed description\nsecond line");
    await field(page, "Question C.2").fill("A renewed question?\nWith detail.");
    await field(page, "Hint 1 of C.2").fill("Renewed hint 1");
    await field(page, "Hint 2 of C.2").fill("Renewed hint 2");
    await field(page, "Reward of C.2").fill("555");
    // rules: replace the list with two
    await page.getByRole("button", { name: "Remove rule 1" }).click();
    while ((await page.getByRole("button", { name: /^Remove rule/ }).count()) > 2) {
      await page.getByRole("button", { name: /^Remove rule 3$/ }).click();
    }
    await field(page, "Rule 1").fill(rules[0]!);
    await field(page, "Rule 2").fill(rules[1]!);

    await confirm(page);
    await expect(page.getByTestId("renew-notice")).toContainText("The competition was renewed", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("renew-error")).toHaveCount(0);
    await expect(page.getByTestId("renew-dirty")).toHaveCount(0);
    // what the editor shows is what the server now holds
    await expect(field(page, "Theme C name")).toHaveValue(renamed);
    await expect(field(page, "Reward of C.2")).toHaveValue("555");
    await expect(field(page, "Rule 2")).toHaveValue(rules[1]!);
    await expect(page.getByTestId("renew-readiness")).toContainText("0 admins and 0 teams");

    // the previous admin and teams are gone; the Super Admin is not
    const gone = await apiCtx();
    const login = await gone.post("/api/auth/staff/login", {
      data: staffCredentials("e2e_admin"),
    });
    expect(login.status()).toBe(401);
    await gone.dispose();
    const sup = await superApi();
    const admins = (await (await sup.get("/api/super/admins")).json()).data.admins as unknown[];
    const teams = (await (await sup.get("/api/super/teams")).json()).data.teams as unknown[];
    expect(admins).toEqual([]);
    expect(teams).toEqual([]);
    const state = (await control("renewalState", {})) as { competition: { status: string } };
    expect(state.competition.status).toBe("SETUP");

    // a repeat of the same request is refused for stale content; nothing more happens
    const read = (await (await sup.get("/api/super/renew")).json()).data;
    expect(read.content.themes[2].name).toBe(renamed);
    expect(read.content.rules).toEqual(rules);

    // a new admin and team can be provisioned, and a participant sees the renewed names and rules
    const username = `after_${hex(3)}`;
    const pw = `Pw-${hex(8)}`;
    const made = await sup.post("/api/super/admins", {
      data: { username, password: pw, confirmPassword: pw },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    expect(made.status()).toBe(200);
    const adminCtx = await apiCtx(
      cookieHeader(await loginForCookies("/api/auth/staff/login", { username, password: pw })),
    );
    const n = hex(3).toUpperCase();
    const team = {
      loginId: `after_${n.toLowerCase()}`,
      password: `Tp-${hex(8)}`,
      admission: [1, 2, 3, 4].map((i) => `AFT${n}${i}`),
    };
    const createdTeam = await adminCtx.post("/api/admin/teams", {
      data: {
        teamCode: `AFT${n}`,
        name: `After ${n}`,
        loginId: team.loginId,
        password: team.password,
        confirmPassword: team.password,
        admissionNos: team.admission,
      },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    expect(createdTeam.status()).toBe(200);
    await adminCtx.dispose();
    await sup.dispose();
    afterTeam = {
      teamLoginId: team.loginId,
      password: team.password,
      admissionNo: team.admission[0]!,
    };

    // The reported bug: a renewal leaves the competition in SETUP, so a participant of the brand-new team is refused ...
    const refused = await apiCtx();
    const attempt = await refused.post("/api/auth/participant/login", { data: afterTeam });
    expect(attempt.status()).toBe(423);
    expect((await attempt.json()).error.code).toBe("COMPETITION_NOT_RUNNING");
    await refused.dispose();
    // ... until the Super Admin opens the competition from the dashboard (no confirmation: Pause undoes it).
    await page.goto("/superadmin");
    await expect(page.getByTestId("competition-status")).toHaveText("Setup");
    await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);
    await page.getByRole("button", { name: "Open competition" }).click();
    await expect(page.getByTestId("competition-notice")).toContainText(
      "The competition is open. Participants can now sign in.",
    );
    await expect(page.getByTestId("competition-status")).toHaveText("Running");
    await expect(page.getByRole("button", { name: "Open competition" })).toHaveCount(0);

    const cookies = await loginForCookies("/api/auth/participant/login", {
      teamLoginId: team.loginId,
      password: team.password,
      admissionNo: team.admission[0]!,
    });
    const ctx = await gameApi(cookies);
    expect((await player(ctx).start()).ok).toBe(true);
    await ctx.dispose();
    const participant = await page.context().browser()!.newContext();
    await participant.addCookies(cookies);
    await installFullscreenShim(participant);
    const p = await participant.newPage();
    await p.goto(`${origin}/participant`);
    await expect(p.getByRole("button", { name: renamed })).toBeVisible({ timeout: 60_000 });
    await p.getByRole("button", { name: "Rules and regulations" }).click();
    const rulesDialog = p.getByRole("dialog", { name: "Rules and Regulations" });
    await expect(rulesDialog.getByRole("listitem")).toHaveCount(2);
    await expect(rulesDialog).toContainText("First renewed rule.");
    await expect(rulesDialog).toContainText("Second renewed rule:");
    await participant.close();
  });
});

/**
 * The Superadmin lifecycle control (`/superadmin`, POST /api/super/competition/status). They run after the renewal above, whose
 * last step opened the competition, and walk the rest of the lifecycle: RUNNING -> PAUSED -> RUNNING -> ENDED.
 */
test.describe("Competition lifecycle control", () => {
  const statusOf = async () =>
    ((await control("renewalState", {})) as { competition: { status: string } }).competition.status;
  const participantLogin = async () => {
    const api = await apiCtx();
    try {
      const res = await api.post("/api/auth/participant/login", { data: afterTeam });
      return { status: res.status(), body: await res.json() };
    } finally {
      await api.dispose();
    }
  };
  const statusPost = async (
    ctx: Awaited<ReturnType<typeof apiCtx>>,
    action: string,
    key = crypto.randomUUID(),
  ) =>
    ctx.post("/api/super/competition/status", {
      data: { action, confirm: true },
      headers: { "Idempotency-Key": key },
    });

  test("the control is for the Superadmin only; the API refuses everybody else and changes nothing", async () => {
    expect(afterTeam).not.toBeNull();
    const before = await statusOf();
    const anon = await apiCtx();
    expect((await statusPost(anon, "pause")).status()).toBe(401);
    await anon.dispose();
    const participant = await apiCtx(
      cookieHeader(await loginForCookies("/api/auth/participant/login", afterTeam!)),
    );
    expect((await statusPost(participant, "pause")).status()).toBe(403);
    await participant.dispose();
    expect(await statusOf()).toBe(before);
  });

  test("the dashboard shows the state the server holds: Running offers Pause and End, not Open or Resume", async ({
    page,
  }) => {
    await signInStaff(page, "e2e_super");
    await page.goto("/superadmin");
    const box = page.getByTestId("competition-control");
    await expect(box).toBeVisible();
    await expect(page.getByTestId("competition-status")).toHaveText("Running");
    await expect(box.getByRole("button", { name: "Pause" })).toBeEnabled();
    await expect(box.getByRole("button", { name: "End competition" })).toBeEnabled();
    await expect(box.getByRole("button", { name: "Open competition" })).toHaveCount(0);
    await expect(box.getByRole("button", { name: "Resume" })).toHaveCount(0);
    // the leaderboard and the rest of the dashboard are still there
    await expect(page.getByRole("heading", { level: 1, name: "Superadmin" })).toBeVisible();
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
  });

  test("Pause then Resume, with no confirmation: participants stay able to sign in while paused", async ({
    page,
  }) => {
    await signInStaff(page, "e2e_super");
    await page.goto("/superadmin");
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByTestId("competition-notice")).toContainText(
      "The competition is paused.",
    );
    await expect(page.getByTestId("competition-status")).toHaveText("Paused");
    expect(await statusOf()).toBe("PAUSED");
    await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);
    expect((await participantLogin()).status).toBe(200);

    // a reload shows the server's state, not the page's memory
    await page.reload();
    await expect(page.getByTestId("competition-status")).toHaveText("Paused");

    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByTestId("competition-notice")).toContainText(
      "The competition is running again.",
    );
    await expect(page.getByTestId("competition-status")).toHaveText("Running");
    expect(await statusOf()).toBe("RUNNING");
  });

  test("the same Idempotency-Key is applied once; a different action in the wrong state is refused", async () => {
    const sup = await superApi();
    const key = crypto.randomUUID();
    const first = await statusPost(sup, "pause", key);
    expect(first.status()).toBe(200);
    expect((await first.json()).data).toMatchObject({ changed: true, to: "PAUSED" });
    expect(first.headers()["idempotent-replay"]).toBeUndefined();
    // the same key again: the stored answer comes back (marked as a replay), and nothing is applied a second time
    const again = await statusPost(sup, "pause", key);
    expect(again.status()).toBe(200);
    expect(again.headers()["idempotent-replay"]).toBe("true");
    expect((await again.json()).data).toMatchObject({ changed: true, to: "PAUSED" });
    // PAUSED: `open` is not a transition from here
    const bad = await statusPost(sup, "open");
    expect(bad.status()).toBe(409);
    expect((await bad.json()).error.code).toBe("INVALID_COMPETITION_TRANSITION");
    expect(await statusOf()).toBe("PAUSED");
    expect((await statusPost(sup, "resume")).status()).toBe(200);
    expect(await statusOf()).toBe("RUNNING");
    await sup.dispose();
  });

  test("a page that is out of date converges on the server's state: the repeated pause is a no-op, not an error", async ({
    page,
  }) => {
    await signInStaff(page, "e2e_super");
    await page.goto("/superadmin");
    await expect(page.getByTestId("competition-status")).toHaveText("Running");
    // somebody else pauses it behind this page's back
    const sup = await superApi();
    expect((await statusPost(sup, "pause")).status()).toBe(200);
    await page.getByRole("button", { name: "Pause" }).click(); // same-state request: an idempotent no-op
    await expect(page.getByTestId("competition-status")).toHaveText("Paused");
    await expect(page.getByTestId("competition-error")).toHaveCount(0);
    expect(await statusOf()).toBe("PAUSED");
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByTestId("competition-status")).toHaveText("Running");
    await sup.dispose();
  });

  test("End asks first: Go back changes nothing; confirming ends it for good and the participant is refused", async ({
    page,
  }) => {
    await signInStaff(page, "e2e_super");
    await page.goto("/superadmin");
    await page.getByRole("button", { name: "End competition" }).click();
    const dialog = page.getByRole("dialog", { name: "End the competition?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("cannot be undone");
    await dialog.getByRole("button", { name: "Go back" }).click();
    await expect(dialog).toBeHidden();
    expect(await statusOf()).toBe("RUNNING");
    await expect(page.getByTestId("competition-status")).toHaveText("Running");

    await page.getByRole("button", { name: "End competition" }).click();
    await dialog.getByRole("button", { name: "Yes, end competition" }).click();
    await expect(page.getByTestId("competition-notice")).toContainText(
      "The competition has ended.",
    );
    await expect(page.getByTestId("competition-status")).toHaveText("Ended");
    expect(await statusOf()).toBe("ENDED");
    // the ended state has no action that could reopen it
    for (const name of ["Open competition", "Pause", "Resume", "End competition"]) {
      await expect(page.getByRole("button", { name })).toHaveCount(0);
    }
    expect((await participantLogin()).status).toBe(423);
    // and the API agrees
    const sup = await superApi();
    expect((await statusPost(sup, "open")).status()).toBe(409);
    await sup.dispose();
    await page.reload();
    await expect(page.getByTestId("competition-status")).toHaveText("Ended");
  });
});

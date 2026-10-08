import { expect, test } from "@playwright/test";

import type { Page } from "@playwright/test";

import { beginTheme, createPlayerTeam, inspect, signInMember } from "./support/game";
import { signInSharedParticipant, teamFor } from "./support/session";

/** The ring is always drifting, so open a ticket the way a keyboard user would: focus it, press Enter. */
async function openTicket(page: Page, name: string) {
  const ticket = page.getByRole("button", { name });
  await ticket.focus();
  await page.keyboard.press("Enter");
}

const ticketNames = [..."ABCDEFGHIJ"].map((c) => `THEME ${c}`);

test.describe("participant home", () => {
  // /participant is a protected route (B11): every test here starts from a real signed-in participant session.
  test.beforeEach(async ({ page }, info) => {
    await signInSharedParticipant(page, info);
  });

  test("renders everything from the spec with no console errors", async ({ page }, info) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("/participant");

    await expect(
      page.getByRole("heading", { level: 1, name: "WELCOME TO THE ESCAPE ROOM ISMites" }),
    ).toBeVisible();
    for (const alt of ["IIT (ISM) Dhanbad", "Event mark", "Mathematics Club IIT (ISM)"]) {
      await expect(page.getByRole("img", { name: alt })).toBeVisible();
    }
    // B13: the numbers are the server's. The shared team entered the competition in global setup, so its team timer is
    // running (just under 04:00:00) and it still holds the starting 500 coins; its rank and score are not published yet.
    await expect(page.locator(".home-stats .stat-value").first()).toHaveText(/^0[34]:\d\d:\d\d$/);
    await expect(page.getByText("500", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Live Leaderboard" })).toBeVisible();
    await expect(page.getByLabel("Your rank")).toHaveText("—");
    await expect(page.getByLabel("Your team ID")).toHaveText(teamFor(info).code);
    await expect(page.getByLabel("Your score")).toHaveText("—");
    for (const name of [...ticketNames, "FINAL SUBMIT"]) {
      await expect(page.getByRole("button", { name })).toBeAttached();
    }
    await expect(page.locator("tbody tr")).toHaveCount(100);
    // exactly 10 themes + Final Submit = 11 tickets; Final Submit is last; K and L do not exist
    await expect(page.locator(".ticket")).toHaveCount(11);
    await expect(page.locator(".ticket").last()).toHaveText(/FINAL SUBMIT/);
    await expect(page.locator(".ticket", { hasText: /^\s*[A-Z]?\s*THEME/ })).toHaveCount(10);
    await expect(page.getByRole("button", { name: "THEME K" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "THEME L" })).toHaveCount(0);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("layout follows the supplied mock-up (desktop fractions)", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "desktop layout only");
    await page.setViewportSize({ width: 1440, height: 810 });
    await page.goto("/participant");
    const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
    const W = 1440;
    const H = 810;
    const tol = 0.03;

    const lb = await box(".leaderboard");
    expect(lb.x / W).toBeGreaterThan(0.71 - tol);
    expect(lb.x / W).toBeLessThan(0.71 + tol);
    expect((lb.x + lb.width) / W).toBeGreaterThan(0.97);
    expect(lb.height / H).toBeGreaterThan(0.95);

    const logos = await box(".logo-badges");
    expect(logos.x).toBeLessThan(8);
    expect(logos.y / H).toBeLessThan(0.05);
    expect(logos.height / H).toBeGreaterThan(0.12);
    expect(logos.height / H).toBeLessThan(0.2);

    const area = await box(".spiral-area");
    expect(Math.abs(area.x / W - 0.044)).toBeLessThan(tol + 0.02);
    expect(Math.abs((area.x + area.width) / W - 0.67)).toBeLessThan(tol + 0.02);
    expect(Math.abs(area.y / H - 0.26)).toBeLessThan(tol);
    expect(Math.abs((area.y + area.height) / H - 0.96)).toBeLessThan(tol);

    const title = await box(".home-title");
    const stats = await box(".home-stats");
    expect(title.y).toBeLessThan(stats.y);
    expect(stats.x).toBeGreaterThan(logos.x + logos.width);
    expect(stats.x + stats.width).toBeLessThan(lb.x);
  });

  test("every ticket stays inside the ticket area", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "desktop layout only");
    await page.setViewportSize({ width: 1440, height: 810 });
    await page.goto("/participant");
    const area = (await page.locator(".spiral-area").boundingBox())!;
    for (const b of await page.locator(".ticket").all()) {
      const r = (await b.boundingBox())!;
      expect(r.y).toBeGreaterThanOrEqual(area.y - 20);
      expect(r.y + r.height).toBeLessThanOrEqual(area.y + area.height + 20);
    }
  });

  test("no horizontal overflow", async ({ page }) => {
    await page.goto("/participant");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("a ticket can be opened with a real mouse click once the ring slows under the pointer", async ({
    page,
  }, info) => {
    test.skip(info.project.name === "mobile", "hover is a desktop behaviour");
    await page.goto("/participant");
    const area = (await page.locator(".spiral").boundingBox())!;
    await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
    await page.waitForTimeout(2500); // eased pause on hover
    const front = page.locator('.ticket[data-index="0"]');
    const r = (await front.boundingBox())!;
    await page.mouse.click(r.x + r.width * 0.6, r.y + r.height / 2);
    await expect(page.getByRole("dialog", { name: /THEME/ })).toBeVisible();
  });

  test("rules dialog opens, Close closes it, Escape closes it", async ({ page }) => {
    await page.goto("/participant");
    const opener = page.getByRole("button", { name: "Rules and regulations" });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Rules and Regulations" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Lorem ipsum/).first()).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await opener.click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("theme dialog: the server's theme, an authoritative unlock, then explore closes", async ({
    page,
  }) => {
    // Unlocking is team-wide and charged once, so this test plays with a team of its own.
    const team = await createPlayerTeam();
    await beginTheme(team, { enterQ1: false }); // its own login is superseded by the page's, which comes last
    await signInMember(page.context(), team, 1);
    // beginTheme already unlocked theme A for the team; theme F is still locked
    await page.goto("/participant");
    await expect(page.locator(".home-stats .stat-value").nth(1)).toHaveText("400");
    await openTicket(page, "THEME F");
    const dialog = page.getByRole("dialog", { name: "THEME F" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("E2E Theme F", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Description of E2E theme F.")).toBeVisible();
    await dialog.getByRole("button", { name: "Unlock with 100 coins" }).click();
    await expect(dialog.getByRole("link", { name: "Let's solve" })).toBeVisible();
    await expect(page.locator(".home-stats .stat-value").nth(1)).toHaveText("300");
    expect((await inspect(team)).coins).toBe(300);
    await dialog.getByRole("button", { name: "Explore other themes" }).click();
    await expect(dialog).toBeHidden();
  });

  test("final dialog: Go back closes it and submits nothing", async ({ page }) => {
    // "Yes, submit" is irreversible since B15 (it freezes the whole team), so it is exercised on a throw-away team in
    // final-submit.spec.ts and never on the team the specs share.
    await page.goto("/participant");
    await openTicket(page, "FINAL SUBMIT");
    const dialog = page.getByRole("dialog", { name: "Final Submit" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Go back" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".ticket").last()).toHaveText(/FINAL SUBMIT/);
  });

  test("spiral turns by itself, pauses while a dialog is open", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "motion is checked once");
    // The ring only rests after its frame-driven ease finishes, which takes many wall-clock seconds at software-WebGL
    // frame rates (~1 fps under load): well beyond the 30 s default there.
    test.setTimeout(120_000);
    await page.goto("/participant");
    const rot = () =>
      page
        .locator(".spiral-ring")
        .evaluate((el) => Number((el as HTMLElement).style.getPropertyValue("--rot")));
    const a = await rot();
    await page.waitForTimeout(2500);
    const b = await rot();
    expect(b).toBeGreaterThan(a + 0.3);
    await openTicket(page, "THEME A");
    await expect(page.getByRole("dialog")).toBeVisible();
    // The pause is eased and frame-driven: the ring first glides to the opened ticket, then its drift fades to 0.
    // How long that takes depends on how far the ring had drifted and on the frame rate, so a fixed sleep is not a
    // stable synchronisation point. Wait until the ring has actually come to rest: moving by less than 0.005 deg per
    // frame for 5 frames and 400 ms (the time rule keeps the tail of the glide, which also moves very little per
    // frame on a fast display, from counting as rest). A ring that does not pause keeps drifting at 5 deg/s, never
    // rests, and fails here.
    await page.locator(".spiral-ring").evaluate(
      (el) =>
        new Promise<void>((resolve, reject) => {
          const read = () => Number((el as HTMLElement).style.getPropertyValue("--rot"));
          const deadline = performance.now() + 90_000;
          let last = read();
          let frames = 0;
          let since = performance.now();
          const frame = () => {
            const now = read();
            if (Math.abs(now - last) < 0.005) frames += 1;
            else {
              frames = 0;
              since = performance.now();
            }
            last = now;
            if (frames >= 5 && performance.now() - since >= 400) resolve();
            else if (performance.now() > deadline) reject(new Error("ring never came to rest"));
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        }),
    );
    const c = await rot();
    await page.waitForTimeout(800);
    expect(Math.abs((await rot()) - c)).toBeLessThan(0.5);
  });

  test("arrow keys step the ring", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "keyboard check once");
    await page.goto("/participant");
    await page.keyboard.press("Tab");
    await page.getByRole("button", { name: "THEME A" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("button", { name: "THEME B" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByRole("button", { name: "FINAL SUBMIT" })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.getByRole("button", { name: "THEME A" })).toBeFocused();
  });

  test("dragging rotates the ring without opening a ticket", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "mouse drag, desktop only");
    await page.goto("/participant");
    const before = await page
      .locator(".spiral-ring")
      .evaluate((el) => (el as HTMLElement).style.getPropertyValue("--rot"));
    const area = (await page.locator(".spiral").boundingBox())!;
    const y = area.y + area.height / 2;
    await page.mouse.move(area.x + 100, y);
    await page.mouse.down();
    await page.mouse.move(area.x + 300, y, { steps: 8 });
    await page.mouse.up();
    const after = await page
      .locator(".spiral-ring")
      .evaluate((el) => (el as HTMLElement).style.getPropertyValue("--rot"));
    expect(Math.abs(Number(after) - Number(before))).toBeGreaterThan(20);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("reduced motion: ring does not drift", async ({ browser }, info) => {
    test.skip(info.project.name === "mobile", "checked once");
    const ctx = await browser.newContext({
      reducedMotion: "reduce",
      viewport: { width: 1440, height: 810 },
    });
    await signInSharedParticipant(ctx, info); // this test builds its own context, so it signs in itself
    const page = await ctx.newPage();
    await page.goto(
      new URL("/participant", info.project.use.baseURL ?? "http://localhost:3100").toString(),
    );
    const rot = () =>
      page
        .locator(".spiral-ring")
        .evaluate((el) => (el as HTMLElement).style.getPropertyValue("--rot"));
    const a = await rot();
    await page.waitForTimeout(1000);
    expect(await rot()).toBe(a);
    await ctx.close();
  });
});

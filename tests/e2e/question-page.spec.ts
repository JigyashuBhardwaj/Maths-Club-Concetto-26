import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** Unlock a theme the way a member does: open its ticket on the home page, unlock, "Let's solve". */
async function startTheme(page: Page, letter = "A") {
  await page.goto("/participant");
  const ticket = page.getByRole("button", { name: `THEME ${letter}` });
  await ticket.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Unlock with xyz coins" }).click();
  await page.getByRole("link", { name: "Let's solve" }).click();
  await page.waitForURL(`**/participant/theme/${letter}/1`);
  await expect(page.getByText("Q1.")).toBeVisible({ timeout: 20_000 });
}

test.describe("question page", () => {
  test("renders everything from the spec with no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await startTheme(page, "C");
    await expect(page.getByRole("heading", { level: 1, name: "THEME C" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Ultimate timer" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Question timer" })).toBeVisible();
    await expect(page.getByRole("button", { name: "buy time" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Coins left" })).toContainText("446");
    await expect(page.getByRole("group", { name: /Reward/ })).toContainText("50 coins++");
    await expect(page.getByRole("button", { name: /^Hint 1/ })).toContainText("buy with 40 coins");
    await expect(page.getByRole("button", { name: /^Hint 2/ })).toBeDisabled();
    await expect(page.getByPlaceholder("write your answer here with explanation")).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear all" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit" })).toBeVisible();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("question timer runs from 04:00 as soon as Q1 is entered", async ({ page }) => {
    await startTheme(page);
    const timer = page.getByRole("group", { name: "Question timer" }).locator(".stat-value");
    await expect(timer).toHaveText(/0[34]:\d\d/);
    const a = await timer.innerText();
    await page.waitForTimeout(2200);
    expect(await timer.innerText()).not.toBe(a);
  });

  test("layout follows the supplied mock-up (desktop fractions)", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "desktop layout only");
    await page.setViewportSize({ width: 1440, height: 810 });
    await startTheme(page);
    const W = 1440;
    const H = 810;
    const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
    const frame = await box(".q-frame");
    // image: frame x 4.3-95.1 %, y 27.8-93.8 %
    expect(Math.abs(frame.x / W - 0.043)).toBeLessThan(0.025);
    expect(Math.abs((frame.x + frame.width) / W - 0.951)).toBeLessThan(0.025);
    expect(Math.abs(frame.y / H - 0.278)).toBeLessThan(0.03);
    expect(Math.abs((frame.y + frame.height) / H - 0.938)).toBeLessThan(0.03);

    const home = await box(".q-home");
    expect(home.x + home.width / 2).toBeLessThan(W * 0.07);
    expect(home.y + home.height / 2).toBeLessThan(H * 0.1);
    const title = await box(".q-title");
    expect(Math.abs(title.x + title.width / 2 - W / 2)).toBeLessThan(8);

    const stats = await box(".q-stats");
    expect(stats.y).toBeGreaterThan(H * 0.1);
    expect(stats.y + stats.height).toBeLessThan(frame.y);

    // hints column is on the right of the question box, the answer box underneath, footer last
    const q = await box(".q-question");
    const hints = await box(".q-hints");
    const answer = await box(".q-input");
    const footer = await box(".q-footer");
    expect(hints.x).toBeGreaterThan(q.x + q.width - 2);
    expect(Math.abs((hints.x - frame.x) / frame.width - 0.855)).toBeLessThan(0.03);
    expect(answer.y).toBeGreaterThan(q.y + q.height - 2);
    expect(footer.y).toBeGreaterThan(answer.y + answer.height - 2);

    // arrows straddle the left/right edges at the question/answer divider
    const prev = await box(".q-arrows .q-arrow-back");
    const next = await box(".q-arrows .q-arrow-next");
    expect(prev.x).toBeLessThan(frame.x);
    expect(prev.x + prev.width).toBeGreaterThan(frame.x);
    expect(next.x).toBeLessThan(frame.x + frame.width);
    expect(next.x + next.width).toBeGreaterThan(frame.x + frame.width);
    expect(Math.abs(prev.y + prev.height / 2 - (q.y + q.height))).toBeLessThan(4);
  });

  test("no horizontal overflow", async ({ page }) => {
    await startTheme(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("answer → submit → pending → (admin) approved → next question opens; previous is read-only", async ({
    page,
  }) => {
    await startTheme(page);
    await page.getByRole("textbox").fill("x = 4 because ...");
    await page.getByRole("button", { name: "Submit" }).click();
    await expect(page.getByRole("button", { name: "Pending for approval" })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Next question/ })).toBeDisabled();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByRole("button", { name: "Approved" })).toBeDisabled();
    await expect(page.getByRole("group", { name: "Coins left" })).toContainText("496");
    await page.getByRole("link", { name: "Next question" }).click();
    await page.waitForURL("**/theme/A/2");
    await expect(page.getByText("Q2.")).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveValue("");
    await page.getByRole("link", { name: "Previous question" }).click();
    await page.waitForURL("**/theme/A/1");
    await expect(page.getByRole("textbox")).toHaveValue("x = 4 because ...");
    await expect(page.getByRole("textbox")).toHaveAttribute("readonly", "");
    await page.getByRole("link", { name: "Back to home" }).click();
    await page.waitForURL("**/participant");
  });

  test("disapproval puts the red Submit back and keeps the text", async ({ page }) => {
    await startTheme(page);
    await page.getByRole("textbox").fill("wrong");
    await page.getByRole("button", { name: "Submit" }).click();
    await page.getByRole("button", { name: "Disapprove" }).click();
    await expect(page.getByRole("textbox")).toHaveValue("wrong");
    await expect(page.getByRole("textbox")).toBeEditable();
    await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();
    await page.getByRole("textbox").fill("better");
    await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();
  });

  test("hint and buy-time dialogs", async ({ page }) => {
    await startTheme(page);
    await page.getByRole("button", { name: /^Hint 1/ }).click();
    let dlg = page.getByRole("dialog", { name: "Hint 1" });
    await expect(dlg).toContainText("Do you want to purchase this hint for 40 coins?");
    await dlg.getByRole("button", { name: "Yes" }).click();
    await expect(page.getByRole("group", { name: "Coins left" })).toContainText("406");
    dlg = page.getByRole("dialog", { name: "Hint 1" });
    await expect(dlg).toContainText(/Lorem ipsum/);
    await dlg.getByRole("button", { name: "Close" }).click();
    await expect(dlg).toBeHidden();

    await page.getByRole("button", { name: "buy time" }).click();
    dlg = page.getByRole("dialog", { name: "Buy time" });
    await dlg.getByRole("button", { name: /2 mins/ }).click();
    await expect(dlg).toContainText("Are you sure?");
    await dlg.getByRole("button", { name: "Yes" }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByRole("group", { name: "Coins left" })).toContainText("386");
    await expect(page.getByRole("group", { name: "Question timer" })).toContainText(/0[56]:\d\d/);
  });

  test("direct visits to a locked theme or question show a notice", async ({ page }) => {
    await page.goto("/participant/theme/D/1");
    await expect(page.getByText(/theme is locked/i)).toBeVisible();
    await page.getByRole("link", { name: "Back to home" }).click();
    await page.waitForURL("**/participant");
    await startTheme(page, "E");
    await page.goto("/participant/theme/E/2");
    await expect(page.getByText(/locked until the previous one is approved/i)).toBeVisible();
  });

  test("unknown theme or question number is a 404", async ({ page }) => {
    expect((await page.goto("/participant/theme/Z/1"))?.status()).toBe(404);
    expect((await page.goto("/participant/theme/K/1"))?.status()).toBe(404);
    expect((await page.goto("/participant/theme/L/1"))?.status()).toBe(404);
    expect((await page.goto("/participant/theme/J/5"))?.status()).toBe(200);
    expect((await page.goto("/participant/theme/A/6"))?.status()).toBe(404);
    expect((await page.goto("/participant/theme/A/0"))?.status()).toBe(404);
  });

  test("no axe violations: active, dialog open, pending, approved", async ({ page }) => {
    const scan = async (label: string) => {
      await page.waitForTimeout(600);
      const r = await new AxeBuilder({ page }).analyze();
      expect(
        r.violations.map((v) => `${v.id}: ${v.help}`),
        label,
      ).toEqual([]);
    };
    await startTheme(page);
    await scan("active");
    await page.getByRole("button", { name: "buy time" }).click();
    await scan("buy time dialog");
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("textbox").fill("answer");
    await page.getByRole("button", { name: "Submit" }).click();
    await scan("pending");
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await scan("approved");
  });
});

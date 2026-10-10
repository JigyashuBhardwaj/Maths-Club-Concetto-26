import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { signInSharedParticipant } from "./support/session";
import { adminReviewer, beginTheme, createPlayerTeam, inspect, signInMember } from "./support/game";
import type { E2ETeam } from "./support/identities";
import { firstLine, officialTheme, rewardOf } from "./support/official";

/**
 * A team of its own, signed in as member 1 in this page, that has entered the competition, unlocked theme A and
 * entered Q1 (all through the real API), then the Q1 page itself. Unlocking, answering and approving change team-wide
 * server state, so no two tests share a team.
 */
async function startTheme(page: Page): Promise<E2ETeam> {
  const team = await createPlayerTeam();
  // beginTheme signs member 1 in itself; a later login supersedes that session, so the page signs in AFTER it
  await beginTheme(team);
  await signInMember(page.context(), team, 1);
  await page.goto("/participant/theme/A/1");
  await expect(page.getByText("Q1.")).toBeVisible({ timeout: 60_000 }); // inside the 90 s test budget below
  await expect(page.locator(".q-text")).toContainText(firstLine("A.1"));
  return team;
}

test.describe("question page", () => {
  // Every test here pays startTheme() first. Under software WebGL the full-size liquid background leaves the desktop
  // viewport at ~1.5 fps, so loading a question page takes 10-15 s and each test runs 16-30 s, with no headroom under
  // the 30 s default (more under parallel workers). Same assertions, more time.
  test.describe.configure({ timeout: 90_000 });

  test("renders everything from the spec with no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await startTheme(page);
    await expect(
      page.getByRole("heading", { level: 1, name: officialTheme("A").name }),
    ).toBeVisible();
    await expect(page.getByRole("group", { name: "Team timer" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Question timer" })).toBeVisible();
    await expect(page.getByRole("button", { name: "buy time" })).toBeEnabled();
    // 500 starting coins less the 100 the team paid for the theme, both from the server
    await expect(page.getByRole("group", { name: "Coins left" })).toContainText("400");
    await expect(page.getByRole("group", { name: /Reward/ })).toContainText(
      `${rewardOf("A.1")} coins++`,
    );
    // B15: Hint 1 can be bought on an active question; Hint 2 only after Hint 1
    await expect(page.getByRole("button", { name: /^Hint 1/ })).toBeEnabled();
    await expect(page.getByRole("button", { name: /^Hint 2/ })).toBeDisabled();
    // entering Q1 started its timer on the server: there is nothing to press
    await expect(page.getByRole("button", { name: /start/i })).toHaveCount(0);
    await expect(page.getByPlaceholder("write your answer here with explanation")).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear all" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit" })).toBeVisible();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("question timer is running as soon as Q1 is entered (started by the server, not by a button)", async ({
    page,
  }) => {
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
    const team = await startTheme(page);
    await page.getByRole("textbox").fill("x = 4 because ...");
    await page.getByRole("button", { name: "Submit" }).click();
    await expect(page.getByRole("button", { name: "Pending for approval" })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Next question/ })).toBeDisabled();
    // the question timer is frozen while the team waits for review; the team timer keeps running
    const pending = (await inspect(team)).questions["1"]!;
    expect(pending.state).toBe("PENDING_APPROVAL");
    expect(pending.deadline).toBeNull();

    // the controlled approval path: an Admin approves through the real route; the page learns it by polling
    const admin = await adminReviewer();
    try {
      const submission = (await inspect(team)).submissions[0]!;
      const approved = await admin.review.approve(submission.id);
      expect(approved.body.data).toMatchObject({
        reward_awarded: rewardOf("A.1"),
        next_question_activated: true,
      });
    } finally {
      await admin.api.dispose();
    }
    await expect(page.getByRole("button", { name: "Approved" })).toBeDisabled({ timeout: 20_000 });
    await expect(page.getByRole("group", { name: "Coins left" })).toContainText(
      String(400 + rewardOf("A.1")),
    );
    await page.getByRole("link", { name: "Next question" }).click();
    await page.waitForURL("**/theme/A/2");
    await expect(page.getByText("Q2.")).toBeVisible();
    await expect(page.locator(".q-text")).toContainText(firstLine("A.2"));
    await expect(page.getByRole("textbox")).toHaveValue("");
    await page.getByRole("link", { name: "Previous question" }).click();
    await page.waitForURL("**/theme/A/1");
    await expect(page.getByRole("textbox")).toHaveValue("x = 4 because ...");
    await expect(page.getByRole("textbox")).toHaveAttribute("readonly", "");
    await page.getByRole("link", { name: "Back to home" }).click();
    await page.waitForURL("**/participant");
  });

  test("disapproval puts the red Submit back and keeps the text", async ({ page }) => {
    const team = await startTheme(page);
    await page.getByRole("textbox").fill("wrong");
    await page.getByRole("button", { name: "Submit" }).click();
    await expect(page.getByRole("button", { name: "Pending for approval" })).toBeDisabled();
    const admin = await adminReviewer();
    try {
      const submission = (await inspect(team)).submissions[0]!;
      const res = await admin.review.disapprove(submission.id, "Check the sign.");
      expect(res.body.data.submission.status).toBe("REJECTED");
    } finally {
      await admin.api.dispose();
    }
    await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled({ timeout: 20_000 });
    await expect(page.getByRole("textbox")).toHaveValue("wrong");
    await expect(page.getByRole("textbox")).toBeEditable();
    await expect(page.getByRole("status").filter({ hasText: "Not approved" })).toContainText(
      "Check the sign.",
    );
    await page.getByRole("textbox").fill("better");
    await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();
  });

  test("hints and buy time are live: prices come from the server, Hint 2 waits for Hint 1", async ({
    page,
  }) => {
    await startTheme(page);
    await expect(page.getByRole("button", { name: /^Hint 1/ })).toBeEnabled();
    await expect(page.getByRole("button", { name: /^Hint 1/ })).toContainText("20 coins");
    await expect(page.getByRole("button", { name: /^Hint 2/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Hint 2/ })).toContainText("after Hint 1");
    await expect(page.getByRole("button", { name: "buy time" })).toBeEnabled();
  });

  test("direct visits to a locked theme or question show a notice", async ({ page }) => {
    await startTheme(page);
    await page.goto("/participant/theme/D/1");
    await expect(page.getByText(/theme is locked/i)).toBeVisible();
    await page.getByRole("link", { name: "Back to home" }).click();
    await page.waitForURL("**/participant");
    await page.goto("/participant/theme/A/2");
    await expect(page.getByText(/locked until the previous one is approved/i)).toBeVisible();
    // the locked page carries no question body
    await expect(page.getByText(firstLine("A.2"))).toHaveCount(0);
  });

  test("unknown theme or question number is a 404", async ({ page }, info) => {
    await signInSharedParticipant(page, info);
    expect((await page.goto("/participant/theme/Z/1"))?.status()).toBe(404);
    expect((await page.goto("/participant/theme/K/1"))?.status()).toBe(404);
    expect((await page.goto("/participant/theme/L/1"))?.status()).toBe(404);
    expect((await page.goto("/participant/theme/J/5"))?.status()).toBe(200);
    expect((await page.goto("/participant/theme/A/6"))?.status()).toBe(404);
    expect((await page.goto("/participant/theme/A/0"))?.status()).toBe(404);
  });

  test("no axe violations: active, pending, approved", async ({ page }) => {
    // Three axe scans plus UI steps take ~40 s under software WebGL, longer than the 30 s default.
    test.setTimeout(90_000);
    const scan = async (label: string) => {
      await page.waitForTimeout(600);
      const r = await new AxeBuilder({ page }).analyze();
      expect(
        r.violations.map((v) => `${v.id}: ${v.help}`),
        label,
      ).toEqual([]);
    };
    const team = await startTheme(page);
    await scan("active");
    await page.getByRole("textbox").fill("answer");
    await page.getByRole("button", { name: "Submit" }).click();
    await expect(page.getByRole("button", { name: "Pending for approval" })).toBeDisabled();
    await scan("pending");
    const admin = await adminReviewer();
    try {
      await admin.review.approve((await inspect(team)).submissions[0]!.id);
    } finally {
      await admin.api.dispose();
    }
    await expect(page.getByRole("button", { name: "Approved" })).toBeDisabled({ timeout: 20_000 });
    await scan("approved");
  });
});

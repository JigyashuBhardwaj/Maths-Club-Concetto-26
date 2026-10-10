import { expect, test, type Page } from "@playwright/test";

import {
  adminReviewer,
  createPlayerTeam,
  inspect,
  memberApi,
  player,
  signInMember,
} from "./support/game";
import type { E2ETeam } from "./support/identities";
import { officialQuestion, officialRules, officialTheme } from "./support/official";
import { signInSharedParticipant } from "./support/session";

/**
 * B17: the official competition content, as a participant sees it on a desktop and on a phone (both Playwright projects run
 * this file). Rewards, hints and the database side are covered by the other specs and by supabase/tests/180; this file is about
 * what reaches the screen: the ticket names, the rules, the theme descriptions and questions written with maths.
 */
test.describe.configure({ timeout: 120_000 });

const THEMES = [..."ABCDEFGHIJ"];

async function openTicket(page: Page, name: string) {
  const ticket = page.getByRole("button", { name, exact: true });
  await ticket.focus();
  await page.keyboard.press("Enter");
}

test.describe("participant home", () => {
  test.beforeEach(async ({ page }, info) => {
    await signInSharedParticipant(page, info);
  });

  test("the rules dialog shows all eight rules, in order, inside the screen, and can be read to the end", async ({
    page,
  }) => {
    await page.goto("/participant");
    await page.getByRole("button", { name: "Rules and regulations" }).click();
    const dialog = page.getByRole("dialog", { name: "Rules and Regulations" });
    await expect(dialog).toBeVisible();

    const items = dialog.getByRole("listitem");
    await expect(items).toHaveCount(8);
    for (const [i, rule] of officialRules.entries()) await expect(items.nth(i)).toHaveText(rule);
    await expect(dialog.getByText(/lorem ipsum/i)).toHaveCount(0);
    // the numbers 1-8 are actually drawn (a reset stylesheet can silently remove list markers)
    expect(await items.first().evaluate((el) => getComputedStyle(el).listStyleType)).toBe(
      "decimal",
    );
    expect(await items.first().evaluate((el) => getComputedStyle(el).display)).toBe("list-item");

    // the dialog fits the screen and the page behind does not gain a sideways scrollbar
    const box = (await dialog.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflowX).toBeLessThanOrEqual(0);

    // the last rule is reachable by scrolling the dialog, and the Close button stays on screen
    await items.nth(7).scrollIntoViewIfNeeded();
    await expect(items.nth(7)).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "Close" })).toBeInViewport();
    const sideways = await dialog
      .locator(".dialog-scroll")
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(sideways).toBeLessThanOrEqual(0);

    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
  });

  test("every ticket shows its whole official name, and nothing spills out of the ticket", async ({
    page,
  }) => {
    await page.goto("/participant");
    const labels = page.locator(".ticket:not(.ticket-final) .ticket-label");
    await expect(labels).toHaveText(THEMES.map((c) => officialTheme(c).name));
    const spill = await labels.evaluateAll((els) =>
      els.map((el) => ({
        text: el.textContent,
        wide: el.scrollWidth - el.clientWidth,
        tall: el.scrollHeight - el.clientHeight,
      })),
    );
    for (const s of spill) {
      expect(s.wide, `${s.text} overflows sideways`).toBeLessThanOrEqual(1);
      expect(s.tall, `${s.text} overflows vertically`).toBeLessThanOrEqual(1);
    }
    // the longest name is wrapped over lines, not cut: it is complete in the DOM and has no ellipsis styling
    const longest = labels.filter({ hasText: officialTheme("I").name });
    await expect(longest).toHaveCount(1);
    expect(await longest.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("clip");
  });

  test("each theme's dialog shows its own official name and description - and no other theme's", async ({
    page,
  }) => {
    await page.goto("/participant");
    for (const c of THEMES) {
      const { name, description } = officialTheme(c);
      const dialog = page.getByRole("dialog", { name });
      // the ring is still easing right after a dialog closed (a software-rendered browser takes seconds), and a key pressed
      // mid-glide can miss: try again until the ticket opens
      await expect(async () => {
        await openTicket(page, name);
        await expect(dialog).toBeVisible({ timeout: 3000 });
      }).toPass({ timeout: 40_000 });
      await expect(dialog.getByRole("heading", { name, exact: true })).toBeVisible();
      await expect(dialog.getByText(description, { exact: true })).toBeVisible();
      for (const other of THEMES.filter((x) => x !== c)) {
        const text = officialTheme(other).description;
        if (text !== description)
          await expect(dialog.getByText(text, { exact: true })).toHaveCount(0);
      }
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      // closing hands the focus back to the ticket that opened it (and only then is the next ticket safe to open)
      await expect(page.getByRole("button", { name, exact: true })).toBeFocused();
    }
  });
});

test.describe("questions written with maths", () => {
  /** A fresh team that has unlocked A and E and played up to A.4 / E.3, so those pages can be opened for real. */
  async function teamAt(): Promise<E2ETeam> {
    const team = await createPlayerTeam();
    const ctx = await memberApi(team, 1);
    const admin = await adminReviewer();
    try {
      const p = player(ctx);
      for (const step of [await p.start(), await p.unlock(1), await p.unlock(5)])
        expect(step.ok, JSON.stringify(step.body)).toBe(true);
      // theme A: A.1-A.3 approved, so A.4 is the active question; theme E: E.1-E.2 approved, so E.3 is
      for (const qids of [
        [1, 2, 3],
        [21, 22],
      ]) {
        expect((await p.enter(qids[0]!)).ok).toBe(true);
        for (const qid of qids) {
          const sent = await p.submit(qid, "42");
          expect(sent.status, JSON.stringify(sent.body)).toBe(200);
          const id = (await inspect(team)).submissions.find((s) => s.qid === qid)!.id;
          expect((await admin.review.approve(id)).status).toBe(200);
        }
      }
    } finally {
      await ctx.dispose();
      await admin.api.dispose();
    }
    return team;
  }

  test("A.4 keeps its indented formula and numbered tasks; E.3 keeps its payoff table; both fit the screen", async ({
    page,
  }) => {
    const team = await teamAt();
    await signInMember(page.context(), team, 1);

    // A.4: an indented formula line, then numbered tasks
    await page.goto("/participant/theme/A/4");
    const a4 = page.locator(".q-text");
    await expect(a4).toContainText(officialQuestion("A.4").question.split("\n")[0]!, {
      timeout: 60_000,
    });
    const formula = a4.locator("pre.content-pre").first();
    expect(await formula.evaluate((el) => el.textContent)).toBe(
      "    A[i] = (i^2 + 3*i) (mod 50)   for 1 <= i <= 1000",
    );
    expect(await formula.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre");
    await expect(a4).toContainText("1. Define the prefix sum sequence");
    await expect(a4).toContainText("2. Let C_r be the frequency");

    // E.3: the matrix is a monospace block with its columns where the author put them
    await page.goto("/participant/theme/E/3");
    const e3 = page.locator(".q-text");
    await expect(e3).toContainText("Two poker players", { timeout: 60_000 });
    const table = e3.locator("pre.content-pre").first();
    const shown = await table.evaluate((el) => el.textContent ?? "");
    expect(shown).toContain("Player A  Bluff (B)      −4           6");
    expect(shown).toContain("          Play Safe (S)   3          −2");
    // on a phone the block scrolls inside itself; the page never scrolls sideways
    expect(await table.evaluate((el) => getComputedStyle(el).overflowX)).toMatch(/auto|scroll/);
    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflowX).toBeLessThanOrEqual(0);

    // the maths fallback font is served and loads, so Greek letters, roots and integrals are not boxes
    const loaded = await page.evaluate(async () => {
      const faces = await document.fonts.load("16px mathFallback", "θ∫√Σ");
      return { faces: faces.length, ready: document.fonts.check("16px mathFallback", "θ∫√Σ") };
    });
    expect(loaded.faces).toBeGreaterThan(0);
    expect(loaded.ready).toBe(true);
  });

  test("an unpurchased hint is nowhere on the question page or in its data; a bought one is shown as written", async ({
    page,
  }) => {
    const team = await teamAt();
    await signInMember(page.context(), team, 1);
    const seen: string[] = [];
    page.on("response", async (r) => {
      if (r.url().includes("/api/p/")) seen.push(await r.text().catch(() => ""));
    });
    await page.goto("/participant/theme/A/4");
    await expect(page.locator(".q-text")).toContainText("An array A of size N = 1000", {
      timeout: 60_000,
    });
    const h1 = officialQuestion("A.4").hint1.split("\n")[0]!.slice(0, 40);
    const h2 = officialQuestion("A.4").hint2.split("\n")[0]!.slice(0, 40);
    expect(await page.content()).not.toContain(h1);
    expect(seen.join("\n")).not.toContain(h1);
    expect(seen.join("\n")).not.toContain(h2);

    await page.getByRole("button", { name: /^Hint 1/ }).click();
    await page.getByRole("dialog", { name: "Hint 1" }).getByRole("button", { name: "Yes" }).click();
    const dialog = page.getByRole("dialog", { name: "Hint 1" });
    await expect(dialog).toContainText(h1);
    const shownHint = await dialog.locator(".q-hint-body").evaluate((el) =>
      Array.from(el.children)
        .map((c) => c.textContent)
        .join("\n"),
    );
    expect(shownHint).toBe(officialQuestion("A.4").hint1);
    expect(await page.content()).not.toContain(h2); // Hint 2 is still not bought
  });
});

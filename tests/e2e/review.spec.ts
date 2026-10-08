import { expect, test, type Page } from "@playwright/test";

import { api, beginTheme, createPlayerTeam, inspect, player } from "./support/game";
import type { E2ETeam } from "./support/identities";
import { loginForCookies, participantCredentials, signInStaff } from "./support/session";

/**
 * The thin B13 review page (/admin/review) drives the REAL approve / disapprove endpoints: every click here changes
 * server state (the in-memory database mirrors the SQL), never client state. Each test plays with a team of its own,
 * owned by the E2E admin.
 */

/** A new team that has entered, unlocked theme A, entered Q1 and submitted `answer` (all through the real API). */
async function withPendingSubmission(
  answer: string,
): Promise<{ team: E2ETeam; submissionId: string }> {
  const team = await createPlayerTeam();
  await beginTheme(team);
  const ctx = await api(
    await loginForCookies("/api/auth/participant/login", participantCredentials(team, 1)),
  );
  try {
    const res = await player(ctx).submit(1, answer);
    expect(res.status).toBe(200);
  } finally {
    await ctx.dispose();
  }
  const submissionId = (await inspect(team)).submissions[0]!.id;
  return { team, submissionId };
}

const entry = (page: Page, team: E2ETeam) =>
  page.getByRole("listitem").filter({ hasText: team.code });

test.describe("review queue page", () => {
  test.beforeEach(async ({ page }) => {
    await signInStaff(page, "e2e_admin");
  });

  test("lists a pending submission, opens it, and Approve runs the real approval once", async ({
    page,
  }) => {
    const { team } = await withPendingSubmission("x = 4");
    const before = await inspect(team);
    await page.goto("/admin/review");
    const row = entry(page, team);
    await expect(row).toContainText("Theme A · Q1");
    await row.getByRole("button", { name: "Open" }).click();
    await expect(row.getByTestId("review-answer")).toHaveText("x = 4");
    await row.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });

    const after = await inspect(team);
    expect(after.coins).toBe(before.coins + 50);
    expect(after.questions["1"]!.state).toBe("APPROVED");
    expect(after.questions["2"]!.state).toBe("ACTIVE");
    expect(after.submissions[0]).toMatchObject({ status: "APPROVED", reward: 50 });
    expect(after.audit.filter((e) => e === "SUBMISSION_APPROVED")).toHaveLength(1);
  });

  test("Disapprove with a note returns the question to the team with its time and the draft kept", async ({
    page,
  }) => {
    const { team } = await withPendingSubmission("wrong");
    await page.goto("/admin/review");
    const row = entry(page, team);
    await row.getByRole("button", { name: "Open" }).click();
    await row.getByLabel(/Note for the team/).fill("Check the sign.");
    await row.getByRole("button", { name: "Disapprove" }).click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });

    const after = await inspect(team);
    expect(after.submissions[0]).toMatchObject({ status: "REJECTED", reward: null });
    expect(after.questions["1"]).toMatchObject({ state: "ACTIVE", remaining: null });
    expect(after.questions["1"]!.deadline).not.toBeNull();
    expect(after.coins).toBe(400); // no reward
  });

  test("the queue is closed to anonymous callers and to participants", async () => {
    const anon = await api();
    const team = await createPlayerTeam();
    const member = await api(
      await loginForCookies("/api/auth/participant/login", participantCredentials(team, 1)),
    );
    try {
      expect((await anon.get("/api/admin/queue")).status()).toBe(401);
      expect((await member.get("/api/admin/queue")).status()).toBe(403);
    } finally {
      await anon.dispose();
      await member.dispose();
    }
  });
});

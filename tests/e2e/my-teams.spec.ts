import AxeBuilder from "@axe-core/playwright";
import { randomBytes, randomUUID } from "node:crypto";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  adminReviewer,
  api,
  beginTheme,
  createPlayerTeam,
  inspect,
  player,
  signInMember,
} from "./support/game";
import type { E2ETeam } from "./support/identities";
import { control, loginForCookies, signInStaff, staffCredentials } from "./support/session";
import { rewardOf } from "./support/official";

/**
 * B14: the Admin "My Teams" live control matrix, in real browsers against the real routes. Everything the Admin does
 * here (open a cell, read a submission, Approve, Disapprove) goes through the authenticated endpoints, so every click
 * changes SERVER state; the board only re-reads it. The browser-side database is the in-memory stand-in whose rules
 * mirror the SQL (tests/e2e/support/fake-*.mjs); the SQL itself, presence timing, ownership, reward and idempotency are
 * proven against real PostgreSQL in supabase/tests/110_admin_matrix.test.sql and the concurrency script.
 *
 * Every test builds its OWN team through the real `POST /api/admin/teams` (owned by the E2E admin), so they run in
 * parallel without sharing a clock, a balance or a draft. Question ids: theme n, ordinal k -> (n - 1) * 5 + k.
 */
test.describe.configure({ timeout: 120_000 });

const A1 = 1;
const B1 = 6;
/** The board polls every ~3 s and the participant pages every ~5 s; this is the budget for one round trip of each. */
const LIVE = { timeout: 25_000 };

const rowOf = (page: Page, team: E2ETeam) => page.locator(`tr[data-team="${team.code}"]`);
const cellOf = (page: Page, team: E2ETeam, theme: string) =>
  page.getByTestId(`cell-${team.code}-${theme}`);
const presenceOf = (page: Page, team: E2ETeam, slot: number) =>
  page.getByTestId(`presence-${team.code}-M${slot}`);
const coinsOf = (page: Page) => page.locator(".home-stats .stat-value").nth(1);

async function openBoard(page: Page) {
  await signInStaff(page, "e2e_admin");
  await page.goto("/admin/teams");
}

/** Signs member `slot` in through the real endpoint; returns an API client carrying that member's cookies. */
async function memberApi(team: E2ETeam, slot: 1 | 2 | 3 | 4, context?: BrowserContext) {
  const cookies = context
    ? await signInMember(context, team, slot)
    : await loginForCookies("/api/auth/participant/login", {
        teamLoginId: team.loginId,
        password: team.password,
        admissionNo: team.members.find((m) => m.slot === slot)!.admissionNo,
      });
  return api(cookies);
}

/** A team that has entered, unlocked theme A and entered A.1; member 1 is signed in last and submitted `answer`. */
async function submitted(answer: string, extra: (team: E2ETeam) => Promise<void> = async () => {}) {
  const team = await createPlayerTeam();
  await beginTheme(team);
  await extra(team);
  const m1 = await memberApi(team, 1);
  const res = await player(m1).submit(A1, answer);
  expect(res.status).toBe(200);
  return { team, m1 };
}

test.describe("My Teams: the live matrix", () => {
  test("a new team is a row; member presence, a submission, its review and the approval all show up live", async ({
    page,
    browser,
  }) => {
    const team = await createPlayerTeam(); // the existing B12 flow, untouched
    await openBoard(page);
    // 3. the Admin-owned team is a row, and nobody is IN yet
    await expect(rowOf(page, team)).toBeVisible(LIVE);
    for (const slot of [1, 2, 3, 4]) await expect(presenceOf(page, team, slot)).toHaveText("OUT");
    await expect(cellOf(page, team, "A")).toHaveAttribute("data-state", "NORMAL");

    // 4-5. M2 signs in and opens the participant page (real session + heartbeat): the Admin sees exactly M2 turn IN
    const ctx2 = await browser.newContext();
    await memberApi(team, 2, ctx2);
    const p2 = await ctx2.newPage();
    await p2.goto("/participant");
    await expect(presenceOf(page, team, 2)).toHaveText("IN", LIVE);
    for (const slot of [1, 3, 4]) await expect(presenceOf(page, team, slot)).toHaveText("OUT");

    // 6. M1 (the team's first member) enters the competition, unlocks theme A and opens A.1; M1 stays signed in
    await beginTheme(team);
    const ctx1 = await browser.newContext();
    const m1 = await memberApi(team, 1, ctx1);
    const p1 = await ctx1.newPage();
    await p1.goto("/participant");
    await expect(presenceOf(page, team, 1)).toHaveText("IN", LIVE);
    await expect(coinsOf(p1)).toHaveText("400", { timeout: 45_000 }); // 500 - the theme unlock

    // 7-8. M1 submits A.1: theme A turns RED on the Admin's board, and only A
    expect((await player(m1).submit(A1, "x = 4")).status).toBe(200);
    await expect(cellOf(page, team, "A")).toHaveAttribute("data-state", "RED", LIVE);
    await expect(cellOf(page, team, "B")).toHaveAttribute("data-state", "NORMAL");

    // 9-10. open the theme: five questions, A.1 red, the rest white
    await cellOf(page, team, "A").click();
    const dialog = page.getByRole("dialog", { name: new RegExp(`${team.code} · Theme A`) });
    await expect(dialog).toBeVisible();
    for (const q of ["A.1", "A.2", "A.3", "A.4", "A.5"]) {
      await expect(dialog.getByTestId(`question-${q}`)).toHaveAttribute(
        "data-color",
        q === "A.1" ? "RED" : "WHITE",
      );
    }
    // 11. open the red question: the actual submission
    await dialog.getByTestId("question-A.1").click();
    await expect(dialog.getByTestId("review-answer")).toHaveText("x = 4");
    // (this team gave no explanation, so none is shown; the component test covers the explanation)
    await expect(dialog.getByTestId("review-explanation")).toHaveCount(0);
    await expect(dialog).toContainText("submitted by M1");
    // no reference answer or key anywhere on the page
    await expect(dialog).not.toContainText("E2E-SECRET-ANSWER");

    // 12-13. Approve: A.1 green, + its official reward, A.2 opens
    const before = await inspect(team);
    await dialog.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText(
      `A.1 approved: +${rewardOf("A.1")} coins`,
    );
    await expect(dialog.getByTestId("question-A.1")).toHaveAttribute("data-color", "GREEN", LIVE);
    await expect(dialog.getByTestId("question-A.2")).toContainText("In progress", LIVE);
    const after = await inspect(team);
    expect(after.coins).toBe(before.coins + rewardOf("A.1")); // 14
    expect(after.questions["1"]!.state).toBe("APPROVED");
    expect(after.questions["2"]!.state).toBe("ACTIVE"); // 15
    expect(after.audit.filter((e) => e === "SUBMISSION_APPROVED")).toHaveLength(1);
    await dialog.getByRole("button", { name: "Close" }).click();

    // 17. the board no longer shows red; it shows progress (1 of 5)
    await expect(cellOf(page, team, "A")).toHaveAttribute("data-state", "NORMAL", LIVE);
    await expect(cellOf(page, team, "A")).toHaveText("1/5");
    // 16. and the participant sees the coins and the next question without any action of their own
    await expect(coinsOf(p1)).toHaveText(String(400 + rewardOf("A.1")), LIVE);
    const state = await player(m1).state();
    expect(state.body.data.team.coins).toBe(400 + rewardOf("A.1"));
    await ctx1.close();
    await ctx2.close();
  });

  test("Disapprove: no reward, the cell stops being red, the team can correct and submit again", async ({
    page,
  }) => {
    const { team, m1 } = await submitted("wrong");
    await openBoard(page);
    await expect(cellOf(page, team, "A")).toHaveAttribute("data-state", "RED", LIVE);
    await cellOf(page, team, "A").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("question-A.1").click();
    await dialog.getByLabel(/Note for the team/).fill("Check the sign.");
    await dialog.getByRole("button", { name: "Disapprove" }).click();
    await expect(dialog.getByRole("status")).toContainText("A.1 disapproved");
    await expect(dialog.getByTestId("question-A.1")).toHaveAttribute("data-color", "WHITE", LIVE);
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(cellOf(page, team, "A")).toHaveAttribute("data-state", "NORMAL", LIVE);

    const after = await inspect(team);
    expect(after.submissions[0]).toMatchObject({ status: "REJECTED", reward: null });
    expect(after.questions["1"]).toMatchObject({ state: "ACTIVE", remaining: null });
    expect(after.coins).toBe(400); // no reward
    // resubmission remains possible: the cell goes red again
    expect((await player(m1).submit(A1, "right")).status).toBe(200);
    await expect(cellOf(page, team, "A")).toHaveAttribute("data-state", "RED", LIVE);
  });

  test("several themes and several teams are red at once; an unlocked theme with nothing pending is not", async ({
    page,
  }) => {
    const second = async (team: E2ETeam) => {
      const ctx = await memberApi(team, 1);
      const p = player(ctx);
      expect((await p.unlock(2)).ok).toBe(true); // theme B
      expect((await p.enter(B1)).ok).toBe(true);
      expect((await p.unlock(3)).ok).toBe(true); // theme C: unlocked only, never submitted
    };
    const t1 = await submitted("a1", second);
    expect((await player(t1.m1).submit(B1, "b1")).status).toBe(200);
    const t2 = await submitted("other team a1");
    await openBoard(page);
    await expect(cellOf(page, t1.team, "A")).toHaveAttribute("data-state", "RED", LIVE);
    await expect(cellOf(page, t1.team, "B")).toHaveAttribute("data-state", "RED");
    await expect(cellOf(page, t1.team, "C")).toHaveAttribute("data-state", "NORMAL"); // unlocked != red
    await expect(cellOf(page, t2.team, "A")).toHaveAttribute("data-state", "RED");
    await expect(cellOf(page, t2.team, "B")).toHaveAttribute("data-state", "NORMAL");
    await expect(rowOf(page, t1.team).locator('[data-state="RED"]')).toHaveCount(2);
    // the Admin reviews them one by one: approving A leaves B red
    const reviewer = await adminReviewer();
    try {
      const a = (await inspect(t1.team)).submissions.find((s) => s.qid === A1)!;
      expect((await reviewer.review.approve(a.id)).status).toBe(200);
    } finally {
      await reviewer.api.dispose();
    }
    await expect(cellOf(page, t1.team, "A")).toHaveAttribute("data-state", "NORMAL", LIVE);
    await expect(cellOf(page, t1.team, "B")).toHaveAttribute("data-state", "RED");
    await expect(cellOf(page, t2.team, "A")).toHaveAttribute("data-state", "RED");
  });

  test("approval is idempotent: a double click, a replay and a burst of attempts pay once", async ({
    page,
  }) => {
    const { team } = await submitted("x = 4");
    await openBoard(page);
    await cellOf(page, team, "A").click({ timeout: 45_000 });
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("question-A.1").click();
    await dialog.getByRole("button", { name: "Approve", exact: true }).dblclick();
    await expect(dialog.getByTestId("question-A.1")).toHaveAttribute("data-color", "GREEN", LIVE);
    const once = await inspect(team);
    expect(once.coins).toBe(400 + rewardOf("A.1"));
    expect(once.audit.filter((e) => e === "SUBMISSION_APPROVED")).toHaveLength(1);

    // the same request replayed with its own key, and five concurrent attempts with fresh keys
    const reviewer = await adminReviewer();
    try {
      const id = once.submissions[0]!.id;
      const key = randomUUID();
      const first = await reviewer.review.approve(id, key);
      const replay = await reviewer.review.approve(id, key);
      const burst = await Promise.all([1, 2, 3, 4, 5].map(() => reviewer.review.approve(id)));
      expect([first.status, replay.status]).toEqual([409, 409]); // already approved by the dialog; nothing left to pay
      expect(burst.every((r) => r.status === 409)).toBe(true);
    } finally {
      await reviewer.api.dispose();
    }
    const end = await inspect(team);
    expect(end.coins).toBe(400 + rewardOf("A.1"));
    expect(end.audit.filter((e) => e === "SUBMISSION_APPROVED")).toHaveLength(1);
  });

  test("concurrent first approvals: exactly one wins, one reward", async () => {
    const { team } = await submitted("x");
    const id = (await inspect(team)).submissions[0]!.id;
    const reviewer = await adminReviewer();
    try {
      const key = randomUUID();
      const same = await Promise.all([1, 2, 3].map(() => reviewer.review.approve(id, key)));
      const others = await Promise.all([1, 2, 3].map(() => reviewer.review.approve(id)));
      const wins = [...same, ...others].filter((r) => r.ok && !r.replayed);
      expect(wins).toHaveLength(1);
      expect([...same, ...others].filter((r) => !r.ok).every((r) => r.status === 409)).toBe(true);
    } finally {
      await reviewer.api.dispose();
    }
    const end = await inspect(team);
    expect(end.coins).toBe(400 + rewardOf("A.1"));
    expect(end.questions["2"]!.state).toBe("ACTIVE");
    expect(end.audit.filter((e) => e === "SUBMISSION_APPROVED")).toHaveLength(1);
  });

  test("presence is per member: login is IN, logout is OUT, silence goes OUT, any sign of life is IN again", async ({
    page,
    browser,
  }) => {
    const team = await createPlayerTeam();
    await openBoard(page);
    await expect(rowOf(page, team)).toBeVisible(LIVE);
    const m1 = await memberApi(team, 1);
    const m3 = await memberApi(team, 3);
    await expect(presenceOf(page, team, 1)).toHaveText("IN", LIVE);
    await expect(presenceOf(page, team, 3)).toHaveText("IN");
    await expect(presenceOf(page, team, 2)).toHaveText("OUT");
    await expect(presenceOf(page, team, 4)).toHaveText("OUT");

    // logout: OUT at once (the session is revoked), the others are not affected
    const out = await m1.post("/api/auth/logout");
    expect(out.ok()).toBe(true);
    await expect(presenceOf(page, team, 1)).toHaveText("OUT", LIVE);
    await expect(presenceOf(page, team, 3)).toHaveText("IN");

    // network loss / closed browser: no heartbeat for longer than the timeout -> OUT
    const admission = team.members.find((m) => m.slot === 3)!.admissionNo;
    await control("silence", { admissionNo: admission, seconds: 80 });
    await expect(presenceOf(page, team, 3)).toHaveText("OUT", LIVE);
    // recovery: the heartbeat endpoint alone brings the member back
    expect((await m3.post("/api/p/heartbeat")).ok()).toBe(true);
    await expect(presenceOf(page, team, 3)).toHaveText("IN", LIVE);

    // and a real participant page recovers on its own, with no action by anyone
    const ctx = await browser.newContext();
    await memberApi(team, 4, ctx);
    const p4 = await ctx.newPage();
    await p4.goto("/participant");
    await expect(presenceOf(page, team, 4)).toHaveText("IN", LIVE);
    await control("silence", {
      admissionNo: team.members.find((m) => m.slot === 4)!.admissionNo,
      seconds: 80,
    });
    await expect(presenceOf(page, team, 4)).toHaveText("OUT", LIVE);
    await expect(presenceOf(page, team, 4)).toHaveText("IN", { timeout: 40_000 });
    await ctx.close();
    await m1.dispose();
    await m3.dispose();
  });

  test("another Admin sees nothing of this team and cannot reach or decide its submissions", async ({
    page,
    browser,
  }) => {
    const { team } = await submitted("secret-ish answer");
    const sub = (await inspect(team)).submissions[0]!;
    // a second Admin, created by the Super Admin through the real endpoint
    const username = `adm_${randomBytes(3).toString("hex")}`;
    const password = `Pw-${randomBytes(12).toString("base64url")}`;
    const sup = await api(
      await loginForCookies("/api/auth/staff/login", {
        username: "e2e_super",
        password: await superPassword(),
      }),
    );
    const created = await sup.post("/api/super/admins", {
      headers: { "Idempotency-Key": randomUUID() },
      data: { username, password, confirmPassword: password },
    });
    expect(created.ok()).toBe(true);
    await sup.dispose();

    const other = await api(await loginForCookies("/api/auth/staff/login", { username, password }));
    const matrix = await other.get("/api/admin/matrix");
    expect(matrix.status()).toBe(200);
    expect(JSON.stringify(await matrix.json())).not.toContain(team.code);
    expect((await other.get(`/api/admin/teams/${await teamId(team)}/themes/A`)).status()).toBe(404);
    expect(
      (
        await other.post(`/api/admin/submissions/${sub.id}/approve`, {
          headers: { "Idempotency-Key": randomUUID() },
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await other.post(`/api/admin/submissions/${sub.id}/disapprove`, {
          headers: { "Idempotency-Key": randomUUID() },
          data: {},
        })
      ).status(),
    ).toBe(404);
    await other.dispose();
    const end = await inspect(team);
    expect(end.submissions[0]!.status).toBe("PENDING");
    expect(end.coins).toBe(400);

    // in the browser: the page of the other Admin has no row for the team
    const ctx = await browser.newContext();
    await ctx.addCookies(await loginForCookies("/api/auth/staff/login", { username, password }));
    const op = await ctx.newPage();
    await op.goto("/admin/teams");
    await expect(op.getByText("You have not created a team yet.")).toBeVisible();
    await expect(op.getByText(team.code)).toHaveCount(0);
    await ctx.close();
    // the owner still sees it
    await openBoard(page);
    await expect(cellOf(page, team, "A")).toHaveAttribute("data-state", "RED", LIVE);
  });

  test("the matrix API is closed to anonymous callers, participants and the Super Admin", async () => {
    const anon = await api();
    const team = await createPlayerTeam();
    const member = await memberApi(team, 1);
    const sup = await api(
      await loginForCookies("/api/auth/staff/login", {
        username: "e2e_super",
        password: await superPassword(),
      }),
    );
    try {
      for (const url of ["/api/admin/matrix", `/api/admin/teams/${randomUUID()}/themes/A`]) {
        expect((await anon.get(url)).status(), url).toBe(401);
        expect((await member.get(url)).status(), url).toBe(403);
        expect((await sup.get(url)).status(), url).toBe(403);
      }
      expect((await anon.post("/api/p/heartbeat")).status()).toBe(401);
    } finally {
      await anon.dispose();
      await member.dispose();
      await sup.dispose();
    }
  });

  test("navigating away, signing out and signing in again lose nothing", async ({ page }) => {
    const { team } = await submitted("keep me");
    await openBoard(page);
    await expect(cellOf(page, team, "A")).toHaveAttribute("data-state", "RED", LIVE);
    await page.getByRole("link", { name: "Go back" }).click();
    await page.waitForURL((u) => u.pathname === "/admin");
    await page.getByRole("link", { name: "My teams" }).click();
    await page.waitForURL((u) => u.pathname === "/admin/teams");
    await expect(cellOf(page, team, "A")).toHaveAttribute("data-state", "RED");
    // a brand-new session of the same Admin sees the same board (the database is the source, not the browser)
    await page.context().clearCookies();
    await signInStaff(page, "e2e_admin");
    await page.goto("/admin/teams");
    await expect(cellOf(page, team, "A")).toHaveAttribute("data-state", "RED");
    expect(
      await page.evaluate(() => window.localStorage.length + window.sessionStorage.length),
    ).toBe(0);
  });

  test("the Final Submit column is there and shows no submission yet; the board has no axe violations", async ({
    page,
  }) => {
    const { team } = await submitted("axe");
    await openBoard(page);
    await expect(page.getByRole("columnheader", { name: "Final submit" })).toBeVisible(LIVE);
    await expect(page.getByTestId(`final-${team.code}`)).toHaveText("—");
    for (const name of ["Team ID", "M1", "M2", "M3", "M4", "A", "J"]) {
      await expect(page.getByRole("columnheader", { name, exact: true })).toBeVisible();
    }
    await expect(cellOf(page, team, "A")).toHaveAttribute("data-state", "RED", LIVE);
    const scan = async (what: string) => {
      await page.waitForTimeout(800);
      const results = await new AxeBuilder({ page }).analyze();
      expect(
        results.violations.map((v) => `${v.id}: ${v.help}`),
        what,
      ).toEqual([]);
    };
    await scan("matrix");
    await cellOf(page, team, "A").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await scan("theme dialog");
    await page.getByTestId("question-A.1").click();
    await expect(page.getByTestId("review-answer")).toBeVisible();
    await scan("review dialog");
  });
});

// --- helpers that need the fake's directory of identities -----------------------------------------------------------
async function superPassword(): Promise<string> {
  return staffCredentials("e2e_super").password;
}

/** The team's id as the Admin's own board knows it (read through the admin API, never from the fake's internals). */
async function teamId(team: E2ETeam): Promise<string> {
  const admin = await adminReviewer();
  try {
    const res = await admin.api.get("/api/admin/matrix");
    const body = (await res.json()) as { data: { teams: { id: string; team_code: string }[] } };
    return body.data.teams.find((t) => t.team_code === team.code)!.id;
  } finally {
    await admin.api.dispose();
  }
}

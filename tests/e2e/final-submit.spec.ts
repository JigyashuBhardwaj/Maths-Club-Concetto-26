import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
  adminReviewer,
  beginTheme,
  createPlayerTeam,
  inspect,
  memberApi,
  player,
  signInMember,
} from "./support/game";
import type { E2ETeam } from "./support/identities";
import { rewardOf } from "./support/official";

/**
 * Patch B15: Final Submit. It is the team's own irreversible end, with the same terminal freeze as the timer reaching
 * zero. Every test builds its own team (an irreversible action must never touch the team the other specs share).
 */
async function ready(): Promise<E2ETeam> {
  const team = await createPlayerTeam();
  await beginTheme(team);
  return team;
}

test.describe("Final Submit (API)", () => {
  test("freezes the whole team: status, end time and every participant action", async () => {
    const team = await ready();
    const a = player(await memberApi(team, 1));
    const b = player(await memberApi(team, 2));
    const before = await inspect(team);

    const key = randomUUID();
    const done = await b.finalSubmit(key);
    expect(done.status).toBe(200);
    expect(done.body.data.team).toMatchObject({
      status: "FINAL_SUBMITTED",
      frozen: true,
      expired: false,
      duration_seconds: 14_400,
    });
    const t = await inspect(team);
    expect(t.status).toBe("FINAL_SUBMITTED");
    expect(t.finalSubmittedAt).not.toBeNull();
    expect(t.endedAt).toBe(t.finalSubmittedAt);
    expect(t.endsAt).toBe(before.endsAt); // the scheduled end is never rewritten
    expect(t.startedAt).toBe(before.startedAt);
    expect(t.coins).toBe(before.coins); // no score, penalty or coin movement here (that is B16)

    // the same intent again is a replay
    const replay = await b.finalSubmit(key);
    expect(replay.replayed).toBe(true);
    expect((await inspect(team)).finalSubmittedAt).toBe(t.finalSubmittedAt);

    // every participant mutation is refused with the same code, from any member
    const refused = [
      await a.finalSubmit(),
      await a.unlock(2),
      await a.enter(2),
      await a.draft(1, "late", 0),
      await a.submit(1, "late"),
      await a.hint(1, 1),
      await a.buyTime(1, 1, 0),
    ];
    for (const r of refused) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("ALREADY_SUBMITTED");
    }
    const after = await inspect(team);
    expect(after.coins).toBe(before.coins);
    expect(after.hints).toEqual([]);
    expect(after.themes).toEqual(before.themes);
    expect(after.submissions).toEqual([]);

    // reading stays possible, and the remaining time no longer runs
    const s1 = (await a.state()).body.data.team;
    await new Promise((r) => setTimeout(r, 2200));
    const s2 = (await b.state()).body.data.team;
    expect(s1.status).toBe("FINAL_SUBMITTED");
    expect(s2.remaining_seconds).toBe(s1.remaining_seconds);
    expect((await a.question(1)).status).toBe(200);
  });

  test("needs an explicit confirmation and an Idempotency-Key", async () => {
    const team = await ready();
    const ctx = await memberApi(team, 1);
    const p = player(ctx);
    for (const body of [{}, { confirm: false }, { confirm: "true" }, { confirm: true, score: 9 }]) {
      const r = await p.finalSubmit(randomUUID(), body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    const noKey = await ctx.post("/api/p/final-submit", { data: { confirm: true } });
    expect(noKey.status()).toBe(400);
    expect((await inspect(team)).status).toBe("RUNNING");
  });

  test("survives logout and login, and an answer already waiting is still reviewed once", async () => {
    const team = await ready();
    const a = player(await memberApi(team, 1));
    expect((await a.submit(1, "42")).status).toBe(200);
    expect((await a.finalSubmit()).status).toBe(200);

    // a brand-new session of another member sees the same frozen team
    const again = player(await memberApi(team, 3));
    const s = (await again.state()).body.data;
    expect(s.team.status).toBe("FINAL_SUBMITTED");
    expect(s.team.frozen).toBe(true);

    // the pending answer is still the reviewer's to decide: it pays once, and the next question does not open
    const { api, review } = await adminReviewer();
    try {
      const id = (await inspect(team)).submissions[0]!.id;
      const approved = await review.approve(id);
      expect(approved.status).toBe(200);
      expect(approved.body.data.reward_awarded).toBe(rewardOf("A.1"));
      expect(approved.body.data.next_question_activated).toBe(false);
      expect((await review.approve(id)).status).toBe(409);
    } finally {
      await api.dispose();
    }
    const t = await inspect(team);
    expect(t.coins).toBe(400 + rewardOf("A.1"));
    expect(t.questions["2"]!.state).toBe("LOCKED");
  });
});

test.describe("Final Submit (browser)", () => {
  test.describe.configure({ timeout: 120_000 });

  test("Yes, submit freezes the home screen; Go back first changes nothing", async ({ page }) => {
    const team = await ready();
    await signInMember(page.context(), team, 1);
    await page.goto("/participant");
    const open = async () => {
      const ticket = page.getByRole("button", { name: "FINAL SUBMIT" });
      await ticket.focus();
      await page.keyboard.press("Enter");
      return page.getByRole("dialog", { name: "Final Submit" });
    };

    let dialog = await open();
    await expect(dialog).toContainText("cannot be undone");
    await dialog.getByRole("button", { name: "Go back" }).click();
    await expect(dialog).toBeHidden();
    expect((await inspect(team)).status).toBe("RUNNING");

    dialog = await open();
    await dialog.getByRole("button", { name: "Yes, submit" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Your team has made its final submission.")).toBeVisible();
    await expect(page.getByRole("button", { name: "SUBMITTED" })).toBeVisible();
    expect((await inspect(team)).status).toBe("FINAL_SUBMITTED");

    // reopening explains it instead of offering the action again
    await page.getByRole("button", { name: "SUBMITTED" }).focus();
    await page.keyboard.press("Enter");
    const info = page.getByRole("dialog", { name: "Final Submit" });
    await expect(info).toContainText("already made its final submission");
    await expect(info.getByRole("button", { name: "Yes, submit" })).toHaveCount(0);

    // the question page is read-only for everybody on the team
    await page.goto("/participant/theme/A/1");
    await expect(page.getByText("Q1.")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "buy time" })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Hint 1/ })).toBeDisabled();
    await expect(page.getByRole("textbox")).not.toBeEditable();
  });
});

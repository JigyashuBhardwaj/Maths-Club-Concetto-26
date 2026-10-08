import { expect, test } from "@playwright/test";

import {
  ageTeam,
  beginTheme,
  createPlayerTeam,
  inspect,
  makeLegacyTimer,
  memberApi,
  player,
  signInMember,
} from "./support/game";
import type { E2ETeam } from "./support/identities";

/**
 * Patch B15: the Ultimate Team Timer. 4 hours for a team that starts now, a stored per-team allowance (a team that
 * started under the old 2 h rule keeps 2 h), and a persisted ENDED status when it reaches zero -- decided by the server
 * the moment anyone reads or tries to act, and by the scheduled sweep (cron.spec.ts) for a team nobody touches.
 * "Time passes" is `ageTeam`: it moves ONE team's clocks, never the shared one, so parallel specs are unaffected.
 */
const FOUR_HOURS = 14_400_000;

async function ready(): Promise<E2ETeam> {
  const team = await createPlayerTeam();
  await beginTheme(team);
  return team;
}

test.describe("Ultimate Team Timer", () => {
  test("a team that starts now gets 4 hours, stored on the team", async () => {
    const team = await ready();
    const t = await inspect(team);
    expect(t.timerSeconds).toBe(14_400);
    expect(t.endsAt! - t.startedAt!).toBe(FOUR_HOURS);
    const s = (await player(await memberApi(team, 1)).state()).body.data.team;
    expect(s.duration_seconds).toBe(14_400);
    expect(s.remaining_seconds).toBeGreaterThan(14_300);
  });

  test("a team started under the 2 h rule keeps its 2 h, whatever the competition says now", async () => {
    const team = await ready();
    await makeLegacyTimer(team, 7200);
    const t = await inspect(team);
    expect(t.timerSeconds).toBe(7200);
    expect(t.endsAt! - t.startedAt!).toBe(7_200_000);
    const s = (await player(await memberApi(team, 1)).state()).body.data.team;
    expect(s.duration_seconds).toBe(7200);
    expect(s.remaining_seconds).toBeLessThanOrEqual(7200);
    // and a second start (a retry) neither restarts it nor moves it to 4 h
    await player(await memberApi(team, 2)).start();
    expect((await inspect(team)).timerSeconds).toBe(7200);
  });

  test("at zero the first read persists ENDED at the team's own end, and questions time out", async () => {
    const team = await ready();
    const before = await inspect(team);
    await ageTeam(team, FOUR_HOURS + 5_000);
    const mid = await inspect(team);
    expect(mid.status).toBe("RUNNING"); // nothing has looked yet: still the stored RUNNING

    const res = await player(await memberApi(team, 1)).state();
    expect(res.status).toBe(200);
    expect(res.body.data.team).toMatchObject({
      status: "ENDED",
      frozen: true,
      remaining_seconds: 0,
      ended_at: mid.endsAt,
    });
    const t = await inspect(team);
    expect(t.status).toBe("ENDED");
    expect(t.endedAt).toBe(t.endsAt); // ended_at = ends_at, not "when somebody looked"
    expect(t.endsAt).toBe(before.endsAt! - FOUR_HOURS - 5_000);
    expect(t.questions["1"]!.state).toBe("TIMED_OUT");
    expect(t.coins).toBe(before.coins); // coins and ledger are not touched by the freeze
    expect(t.audit.filter((e) => e === "TEAM_ENDED")).toHaveLength(1);

    // reading again is idempotent: no second ENDED, no change
    await player(await memberApi(team, 2)).state();
    expect((await inspect(team)).audit.filter((e) => e === "TEAM_ENDED")).toHaveLength(1);
  });

  test("an action after zero is refused with TEAM_ENDED and the refusal still persists the end", async () => {
    const team = await ready();
    const a = player(await memberApi(team, 1));
    await ageTeam(team, FOUR_HOURS + 1_000);
    expect((await inspect(team)).status).toBe("RUNNING");

    const r = await a.submit(1, "too late");
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("TEAM_ENDED");
    // the rejected request rolled back, yet the end was written by the separate finalize that follows it
    const t = await inspect(team);
    expect(t.status).toBe("ENDED");
    expect(t.submissions).toEqual([]);
    expect(t.coins).toBe(400);

    for (const next of [await a.hint(1, 1), await a.buyTime(1, 1, 0), await a.finalSubmit()]) {
      expect(next.status).toBe(409);
      expect(next.body.error.code).toBe("TEAM_ENDED");
    }
    expect((await inspect(team)).coins).toBe(400);
  });

  test("a team that is not yet due is not finalized by a read or a refusal", async () => {
    const team = await ready();
    await ageTeam(team, FOUR_HOURS - 60_000); // one minute left
    const a = player(await memberApi(team, 1));
    const s = (await a.state()).body.data.team;
    expect(s.status).toBe("RUNNING");
    expect(s.frozen).toBe(false);
    expect((await inspect(team)).status).toBe("RUNNING");
  });
});

test.describe("Ultimate Team Timer in the browser", () => {
  test.describe.configure({ timeout: 120_000 });

  test("home shows 4 hours; a team past zero sees the frozen state", async ({ page }) => {
    const team = await ready();
    await signInMember(page.context(), team, 1);
    await page.goto("/participant");
    await expect(page.locator(".home-stats .stat-value").first()).toHaveText(/^03:59:\d\d$/);

    await ageTeam(team, FOUR_HOURS + 10_000);
    await page.reload();
    await expect(page.getByText("Your team's time is up.")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".home-stats .stat-value").first()).toHaveText("00:00:00");
    expect((await inspect(team)).status).toBe("ENDED");
  });
});

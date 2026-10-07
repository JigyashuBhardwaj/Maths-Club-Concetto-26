import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { signInSharedParticipant } from "./support/session";

for (const path of ["/", "/login/admin", "/login/participant", "/participant"]) {
  test(`no axe violations on ${path}`, async ({ page }, info) => {
    // /participant runs the WebGL ring + liquid background: ~1.5 fps on a software-GL desktop viewport, so the load,
    // the settle wait and the axe scan can exceed the 30 s default. The assertion is unchanged.
    if (path === "/participant") test.setTimeout(90_000);
    // "/" runs the same liquid-background WebGL canvas, and axe.analyze() alone took 5-14 s once the main thread was
    // starved by parallel workers (a Windows full run hit the 30 s default on mobile). /login/admin has no canvas.
    if (path === "/") test.setTimeout(90_000);
    // /participant is a protected route (B11): sign in first, through the real login endpoint.
    if (path === "/participant") await signInSharedParticipant(page, info);
    await page.goto(path);
    await page.waitForTimeout(2000); // let entrance animations settle (contrast is measured on final colours)
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
}

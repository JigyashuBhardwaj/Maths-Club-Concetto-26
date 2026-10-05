import { expect, test } from "@playwright/test";

test.describe("landing page", () => {
  test("renders with no console or page errors and loads every asset", async ({ page }) => {
    const errors: string[] = [];
    const failed: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("requestfailed", (r) => failed.push(r.url()));
    page.on("response", (r) => r.status() >= 400 && failed.push(`${r.status()} ${r.url()}`));

    await page.goto("/");
    await expect(page).toHaveTitle("Mathematics Club Portal");
    await expect(
      page.getByRole("heading", { level: 1, name: /Mathematics Club, IIT \(ISM\) Dhanbad/ }),
    ).toBeAttached();

    for (const alt of ["Event mark", "IIT (ISM) Dhanbad", "Mathematics Club IIT (ISM)"]) {
      const img = page.getByRole("img", { name: alt });
      await expect(img).toBeVisible();
      expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(
        true,
      );
    }

    await page.waitForTimeout(500);
    expect(errors, errors.join("\n")).toEqual([]);
    expect(failed, failed.join("\n")).toEqual([]);
  });

  test("role selector sits at 55–62% of the viewport height, centred", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Select your role" });
    await expect(nav).toBeVisible();
    const box = (await nav.boundingBox())!;
    const vp = page.viewportSize()!;
    const centreY = (box.y + box.height / 2) / vp.height;
    const centreX = (box.x + box.width / 2) / vp.width;
    expect(centreY).toBeGreaterThan(0.55);
    expect(centreY).toBeLessThan(0.62);
    expect(Math.abs(centreX - 0.5)).toBeLessThan(0.01);
  });

  for (const [label, role] of [
    ["Superadmin", "superadmin"],
    ["Admin", "admin"],
    ["Participant", "participant"],
  ] as const) {
    test(`${label} button navigates to /login/${role}`, async ({ page }) => {
      await page.goto("/");
      await page.getByRole("link", { name: label, exact: true }).click();
      await expect(page).toHaveURL(`/login/${role}`);
      await expect(page.getByRole("heading", { name: "Sign-in" })).toBeVisible();
    });
  }

  test("has no horizontal overflow and the page does not scroll", async ({ page }) => {
    await page.goto("/");
    const m = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth > innerWidth,
      scrollY: document.documentElement.scrollHeight > innerHeight + 1,
    }));
    expect(m.overflowX).toBe(false);
    expect(m.scrollY).toBe(false);
  });

  test("role buttons are reachable by keyboard in order", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Superadmin" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Admin", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Participant" })).toBeFocused();
  });

  test("reduced motion disables the float and halo animations", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const name = await page
      .locator(".landing-stage .float")
      .first()
      .evaluate((el) => getComputedStyle(el).animationName);
    expect(name).toBe("none");
  });

  test("CSS fallback engages when WebGL is unavailable", async ({ page }) => {
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type: string, ...rest: unknown[]) {
        if (type === "webgl" || type === "webgl2") return null;
        // @ts-expect-error pass-through
        return orig.call(this, type, ...rest);
      } as typeof orig;
    });
    await page.goto("/");
    await expect(page.locator(".landing-stage")).toHaveAttribute("data-fallback", "true");
    await expect(page.getByRole("navigation", { name: "Select your role" })).toBeVisible();
  });
});

test.describe("placeholders and platform", () => {
  test("shell routes render", async ({ page }) => {
    for (const path of ["/participant", "/admin", "/superadmin"]) {
      await page.goto(path);
      await expect(page.getByText("Placeholder", { exact: true })).toBeVisible();
    }
  });

  test("unknown role and unknown route 404", async ({ page }) => {
    expect((await page.goto("/login/root"))?.status()).toBe(404);
    expect((await page.goto("/nope"))?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });

  test("health endpoint and security headers", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    const home = await request.get("/");
    const h = home.headers();
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-powered-by"]).toBeUndefined();
  });
});

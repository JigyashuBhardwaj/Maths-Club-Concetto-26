import { randomBytes } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

import { ensureIdentities } from "./tests/e2e/support/identities";

const PORT = Number(process.env.PORT ?? 3100);
const DB_PORT = Number(process.env.E2E_DB_PORT ?? PORT + 1);

// Hermetic authentication fixture. Every value below is random per run and lives only in this process tree's
// environment: the app server talks to an in-memory stand-in for Supabase (tests/e2e/support/fake-postgrest.mjs), so
// the browser tests need no database, no Docker and no credential in the repository. The application code is the
// production code; only the environment differs.
process.env.E2E_DB_PORT = String(DB_PORT);
process.env.E2E_SERVICE_KEY ??= randomBytes(24).toString("base64url");
process.env.E2E_SESSION_PEPPER ??= randomBytes(36).toString("base64url");
// The scheduled sweep (GET /api/cron/expire-teams) is authenticated by this shared secret; random per run as well.
process.env.E2E_CRON_SECRET ??= randomBytes(36).toString("base64url");
const identities = JSON.stringify(ensureIdentities());

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/support/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      // Lets a machine without Playwright's browser download use an installed Chromium.
      executablePath: process.env.PW_CHROMIUM_PATH || undefined,
      // Headless machines without a GPU: render WebGL in software.
      args: process.env.PW_SOFTWARE_GL
        ? [
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
          ]
        : [],
    },
  },
  projects: [
    {
      name: "desktop",
      testIgnore: /cron\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    { name: "mobile", testIgnore: /cron\.spec\.ts/, use: { ...devices["Pixel 7"] } },
    {
      // The scheduled sweep ends every due team, so it runs alone, once, after everything else (cron.spec.ts).
      name: "sweep",
      testMatch: /cron\.spec\.ts/,
      dependencies: ["desktop", "mobile"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "node tests/e2e/support/fake-postgrest.mjs",
      url: `http://127.0.0.1:${DB_PORT}/__health`,
      // Never reuse: the identities and keys above exist only for this run.
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        E2E_IDENTITIES: identities,
        E2E_SERVICE_KEY: process.env.E2E_SERVICE_KEY,
        E2E_DB_PORT: String(DB_PORT),
      },
    },
    {
      command: `npm run build && npm run start -- -p ${PORT}`,
      url: `http://localhost:${PORT}/api/health`,
      // Not reusable either: a server started earlier has other keys and cannot see this run's identities.
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        APP_ENV: "test",
        APP_ORIGIN: `http://localhost:${PORT}`,
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${DB_PORT}`,
        SUPABASE_SERVICE_ROLE_KEY: process.env.E2E_SERVICE_KEY,
        SESSION_TOKEN_PEPPER: process.env.E2E_SESSION_PEPPER,
        CRON_SECRET: process.env.E2E_CRON_SECRET,
      },
    },
  ],
});

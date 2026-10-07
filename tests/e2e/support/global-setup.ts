import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ensureIdentities } from "./identities";
import { AUTH_DIR, loginForCookies, participantCredentials } from "./session";

/**
 * Signs member 1 of each test team in through the real login endpoint and keeps the resulting session cookie for the
 * specs that need an authenticated participant (the home and question pages). Nothing is written to the repository:
 * the file lives under node_modules/.cache and holds a session token that dies with the run's in-memory backend.
 */
export default async function globalSetup(): Promise<void> {
  mkdirSync(AUTH_DIR, { recursive: true });
  for (const team of ensureIdentities().teams) {
    const cookies = await loginForCookies(
      "/api/auth/participant/login",
      participantCredentials(team, 1),
    );
    writeFileSync(path.join(AUTH_DIR, `${team.code}.json`), JSON.stringify({ cookies }), {
      mode: 0o600,
    });
  }
}

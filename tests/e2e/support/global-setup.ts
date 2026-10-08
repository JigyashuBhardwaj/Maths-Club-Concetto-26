import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { api, player } from "./game";
import { ensureIdentities } from "./identities";
import { AUTH_DIR, loginForCookies, participantCredentials } from "./session";

/**
 * Signs member 1 of each shared test team in through the real login endpoint and keeps the resulting session cookie for the
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
    // Signing in does not start a team's timer (B13): the shared teams enter the competition once, through the real
    // endpoint, so the layout specs see the participant pages and not the "Enter the competition" gate. The specs
    // that change game state (unlock, answer, approve) build their own team instead (support/game.ts).
    const ctx = await api(cookies);
    try {
      const entered = await player(ctx).start();
      if (!entered.ok) throw new Error(`test entry failed: ${entered.status}`);
    } finally {
      await ctx.dispose();
    }
  }
}

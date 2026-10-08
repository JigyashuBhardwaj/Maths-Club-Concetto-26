import "server-only";

import { authDeps } from "@/lib/auth/routes";
import { parseCronSecret } from "@/lib/env/cron";

import { createExpireTeamsHandler } from "./handlers";

/** Production wiring: the service-role client of the auth routes and `CRON_SECRET` from the environment. */
export const expireTeams = createExpireTeamsHandler({
  db: authDeps.db,
  secret: () => parseCronSecret(process.env),
  now: authDeps.now,
});

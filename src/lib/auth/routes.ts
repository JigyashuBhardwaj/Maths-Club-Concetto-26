import "server-only";

import { createSupabaseDb } from "@/lib/db/supabase";
import { getAuthEnv } from "@/lib/env/server";

import {
  createLogoutHandler,
  createMeHandler,
  createParticipantLoginHandler,
  createStaffLoginHandler,
  type AuthDeps,
} from "./handlers";

/** Production wiring: the service-role database client and the validated environment, created on first use. */
let db: ReturnType<typeof createSupabaseDb> | undefined;
const deps: AuthDeps = {
  db: () => {
    const env = getAuthEnv();
    db ??= createSupabaseDb({
      url: env.NEXT_PUBLIC_SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    });
    return db;
  },
  env: getAuthEnv,
  now: () => Date.now(),
};

export const participantLogin = createParticipantLoginHandler(deps);
export const staffLogin = createStaffLoginHandler(deps);
export const logout = createLogoutHandler(deps);
export const me = createMeHandler(deps);

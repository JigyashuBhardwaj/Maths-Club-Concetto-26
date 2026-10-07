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
export const authDeps: AuthDeps = {
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

export const participantLogin = createParticipantLoginHandler(authDeps);
export const staffLogin = createStaffLoginHandler(authDeps);
export const logout = createLogoutHandler(authDeps);
export const me = createMeHandler(authDeps);

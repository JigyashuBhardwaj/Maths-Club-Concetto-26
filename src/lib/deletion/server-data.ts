import "server-only";

import { authDeps } from "@/lib/auth/routes";
import {
  deletableAdminsResultSchema,
  deletableTeamsResultSchema,
  type DeletableAdmin,
  type DeletableTeam,
} from "@/lib/contracts/deletion";
import { callDb, parseResult } from "@/lib/runtime/handlers";

/**
 * First paint of the two Super Admin deletion screens. Same database functions, same whitelist schemas and same
 * authority as the API routes: the staff id is the session's, never a request value. A failure is NOT swallowed into
 * an empty list (that would look like "no admins"): it is returned as `null`, and the screen shows an error state with a
 * retry instead.
 */
export async function loadDeletableAdmins(staffId: string): Promise<DeletableAdmin[] | null> {
  try {
    return parseResult(
      deletableAdminsResultSchema,
      await callDb(authDeps.db(), "list_deletable_admins", { p_staff_id: staffId }),
    ).admins;
  } catch {
    return null;
  }
}

export async function loadDeletableTeams(staffId: string): Promise<DeletableTeam[] | null> {
  try {
    return parseResult(
      deletableTeamsResultSchema,
      await callDb(authDeps.db(), "list_deletable_teams", { p_staff_id: staffId }),
    ).teams;
  } catch {
    return null;
  }
}

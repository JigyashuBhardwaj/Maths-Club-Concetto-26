import "server-only";

import { authDeps } from "@/lib/auth/routes";
import {
  adminTeamsResultSchema,
  leaderboardResultSchema,
  type AdminTeamRow,
  type LeaderboardResult,
} from "@/lib/contracts/provisioning";
import { callDb, parseResult } from "@/lib/runtime/handlers";

/**
 * Reads for the server-rendered Admin / Super Admin pages. Same database functions, same whitelist schemas and same
 * authority as the API routes: the staff id is the session's, never a request value.
 */

/** "My teams": only the signed-in Admin's own teams (the database enforces `teams.admin_id`). */
export async function loadMyTeams(staffId: string): Promise<AdminTeamRow[]> {
  const { teams } = parseResult(
    adminTeamsResultSchema,
    await callDb(authDeps.db(), "list_admin_teams", { p_staff_id: staffId }),
  );
  return teams;
}

/**
 * The first paint of the leaderboard. A failure is not allowed to break the whole page: the board then starts empty and
 * its own polling fills it in (`null`).
 */
export async function loadLeaderboard(staffId: string): Promise<LeaderboardResult["rows"] | null> {
  try {
    return parseResult(
      leaderboardResultSchema,
      await callDb(authDeps.db(), "get_leaderboard", { p_staff_id: staffId }),
    ).rows;
  } catch {
    return null;
  }
}

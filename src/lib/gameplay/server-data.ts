import "server-only";

import { authDeps } from "@/lib/auth/routes";
import { teamStateSchema, type TeamState } from "@/lib/contracts/runtime";
import { callDb, parseResult } from "@/lib/runtime/handlers";

/**
 * The first paint of the participant pages. Same database function and whitelist schema as `GET /api/p/state`, with
 * the team and member taken from the session. A failure must not break the page: the client then loads the snapshot
 * itself (and retries), so this returns `null` instead of throwing.
 */
export async function loadTeamState(teamId: string, memberId: string): Promise<TeamState | null> {
  try {
    return parseResult(
      teamStateSchema,
      await callDb(authDeps.db(), "get_team_state", { p_team_id: teamId, p_member_id: memberId }),
    );
  } catch {
    return null;
  }
}

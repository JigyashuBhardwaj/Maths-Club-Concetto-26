import "server-only";

import { authDeps } from "@/lib/auth/routes";
import type { TeamState } from "@/lib/contracts/runtime";
import { readTeamState } from "@/lib/runtime/handlers";

/**
 * The first paint of the participant pages. Same database function and whitelist schema as `GET /api/p/state`, with
 * the team and member taken from the session. A failure must not break the page: the client then loads the snapshot
 * itself (and retries), so this returns `null` instead of throwing.
 */
export async function loadTeamState(teamId: string, memberId: string): Promise<TeamState | null> {
  try {
    // Same path as GET /api/p/state: a team whose timer has run out is finalized before it is shown.
    return await readTeamState(authDeps.db(), teamId, memberId);
  } catch {
    return null;
  }
}

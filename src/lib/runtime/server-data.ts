import "server-only";

import { z } from "zod";

import { authDeps } from "@/lib/auth/routes";
import { competitionStatusSchema } from "@/lib/contracts/runtime";
import { callDb, parseResult } from "@/lib/runtime/handlers";

/**
 * What the Super Admin's lifecycle control needs on first paint: the competition's CURRENT status (and how many teams exist, which
 * `open` requires). Read on the server with the session's staff id, never taken from a request.
 *
 * There is no staff-readable function that returns only the status, so this reuses `get_renewal_content` (Super Admin only,
 * re-checked inside the database) and reads two fields of its `readiness` block. Only those fields are validated: the control must
 * not stop working because some unrelated part of the renewal content is malformed. If the payload size ever matters, a dedicated
 * read-only function would replace this one call without touching the UI.
 *
 * A failure is returned as `null` (the control then says the status is unavailable and offers a retry) and never as a guess:
 * a wrong status would offer the wrong action.
 */
const overviewSchema = z.object({
  readiness: z.object({
    competition_status: competitionStatusSchema,
    teams: z.number().int().nonnegative(),
  }),
});

export interface CompetitionOverview {
  status: z.infer<typeof competitionStatusSchema>;
  teams: number;
}

export async function loadCompetitionOverview(
  staffId: string,
): Promise<CompetitionOverview | null> {
  try {
    const { readiness } = parseResult(
      overviewSchema,
      await callDb(authDeps.db(), "get_renewal_content", { p_staff_id: staffId }),
    );
    return { status: readiness.competition_status, teams: readiness.teams };
  } catch {
    return null;
  }
}

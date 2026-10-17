import "server-only";

import { z } from "zod";

import { authDeps } from "@/lib/auth/routes";
import { OFFICIAL_RULES } from "@/lib/content/official-public";
import { type RenewalRead } from "@/lib/contracts/renewal";
import { callDb } from "@/lib/runtime/handlers";

import { resolveRenewalRead } from "./handlers";

/**
 * First paint of the Super Admin's "Renew the Competition" page: the same database function, whitelist schema and authority
 * as `GET /api/super/renew`; the staff id is the session's, never a request value. A failure is NOT swallowed into an empty
 * editor (that would invite publishing blanks): it is returned as `null` and the page shows an error state with a retry.
 */
export async function loadRenewal(staffId: string): Promise<RenewalRead | null> {
  try {
    return resolveRenewalRead(
      await callDb(authDeps.db(), "get_renewal_content", { p_staff_id: staffId }),
    );
  } catch {
    return null;
  }
}

const rulesResultSchema = z.object({
  rules: z.array(z.string().min(1)).min(1).max(50).nullable(),
});

/**
 * The rules and regulations every participant reads: the rules a renewal wrote into the database, else (never renewed) the
 * built-in official rules compiled into this build. `null` when the database could not be read — the rules dialog then says so
 * instead of showing text that may be out of date.
 */
export async function loadCompetitionRules(): Promise<readonly string[] | null> {
  try {
    const parsed = rulesResultSchema.safeParse(
      await callDb(authDeps.db(), "get_competition_rules", {}),
    );
    if (!parsed.success) return null;
    return parsed.data.rules ?? OFFICIAL_RULES;
  } catch {
    return null;
  }
}

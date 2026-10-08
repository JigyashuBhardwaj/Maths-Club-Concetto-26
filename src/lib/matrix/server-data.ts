import "server-only";

import { authDeps } from "@/lib/auth/routes";
import { matrixResultSchema, type MatrixResult } from "@/lib/contracts/matrix";
import { callDb, parseResult } from "@/lib/runtime/handlers";

/**
 * The first paint of "My teams": same database function and whitelist schema as `GET /api/admin/matrix`, with the staff
 * id taken from the session. A failure must not break the page: the client then loads the board itself (`null`).
 */
export async function loadMatrix(staffId: string): Promise<MatrixResult | null> {
  try {
    return parseResult(
      matrixResultSchema,
      await callDb(authDeps.db(), "admin_matrix", { p_staff_id: staffId }),
    );
  } catch {
    return null;
  }
}

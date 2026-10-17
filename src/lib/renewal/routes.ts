import "server-only";

import { authDeps } from "@/lib/auth/routes";

import { createGetRenewalHandler, createRenewHandler } from "./handlers";

/** Production wiring: the same lazily created service-role client and validated environment as the auth routes. */
export const getRenewal = createGetRenewalHandler(authDeps);
export const renewCompetition = createRenewHandler(authDeps);

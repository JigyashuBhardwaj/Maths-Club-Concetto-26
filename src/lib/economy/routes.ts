import "server-only";

import { authDeps } from "@/lib/auth/routes";

import { createBuyHintHandler, createBuyTimeHandler, createFinalSubmitHandler } from "./handlers";

/** Production wiring: the same lazily created service-role client and validated environment as the auth routes. */
export const buyHint = createBuyHintHandler(authDeps);
export const buyTime = createBuyTimeHandler(authDeps);
export const finalSubmit = createFinalSubmitHandler(authDeps);

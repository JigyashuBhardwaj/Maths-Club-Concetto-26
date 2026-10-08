import "server-only";

import { authDeps } from "@/lib/auth/routes";

import { createHeartbeatHandler, createMatrixHandler, createTeamThemeHandler } from "./handlers";

/** Production wiring: the same lazily created service-role client and validated environment as the auth routes. */
export const adminMatrix = createMatrixHandler(authDeps);
export const adminTeamTheme = createTeamThemeHandler(authDeps);
export const heartbeat = createHeartbeatHandler(authDeps);

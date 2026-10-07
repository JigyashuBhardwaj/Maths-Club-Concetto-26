import "server-only";

import { authDeps } from "@/lib/auth/routes";

import {
  createCompetitionStatusHandler,
  createStartTeamHandler,
  createTeamStateHandler,
} from "./handlers";

/** Production wiring: the same lazily created service-role client and validated environment as the auth routes. */
export const startTeam = createStartTeamHandler(authDeps);
export const teamState = createTeamStateHandler(authDeps);
export const competitionStatus = createCompetitionStatusHandler(authDeps);

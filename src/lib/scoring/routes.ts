import "server-only";

import { authDeps } from "@/lib/auth/routes";

import { createParticipantLeaderboardHandler, createPenalizeTeamHandler } from "./handlers";

/** Production wiring: the same lazily created service-role client and validated environment as the auth routes. */
export const participantLeaderboard = createParticipantLeaderboardHandler(authDeps);
export const penalizeTeam = createPenalizeTeamHandler(authDeps);

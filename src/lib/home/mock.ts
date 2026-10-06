/**
 * DEMO DATA — static values taken from the supplied layout image so the screen can be reviewed.
 * They are replaced by the authoritative server snapshot (GET /api/p/state) in a later patch.
 * Nothing here is computed, ticking or persisted.
 */

export const MOCK_TEAM = { rank: 12, teamId: "TEAM123", score: 60 } as const;

/** 03:46:54 — the timer is not running yet; this is a static placeholder. */
export const MOCK_TIME_LEFT_SECONDS = 3 * 3600 + 46 * 60 + 54;

export const MOCK_COINS_LEFT = 446;

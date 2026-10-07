import { randomBytes } from "node:crypto";

/**
 * Throwaway identities for the browser tests. Generated at random for every run (see ensureIdentities), kept only in
 * the process environment, and consumed by the in-memory backend (fake-postgrest.mjs). No password in this repository
 * is, or ever was, a real credential: there are none here at all.
 */
export interface E2EMember {
  slot: number;
  admissionNo: string;
}
export interface E2ETeam {
  code: string;
  name: string;
  loginId: string;
  password: string;
  members: E2EMember[];
}
export interface E2EStaff {
  username: string;
  password: string;
  displayName: string;
  role: "ADMIN" | "SUPER_ADMIN";
  active?: boolean;
}
export interface E2EIdentities {
  staff: E2EStaff[];
  teams: E2ETeam[];
}

const secret = () => randomBytes(15).toString("base64url");

function team(letter: "A" | "B"): E2ETeam {
  return {
    code: `E2E${letter}`,
    name: `E2E Team ${letter}`,
    loginId: `e2e_team_${letter.toLowerCase()}`,
    password: secret(),
    members: [1, 2, 3, 4].map((slot) => ({ slot, admissionNo: `E2E${letter}${slot}` })),
  };
}

export function generateIdentities(): E2EIdentities {
  return {
    staff: [
      {
        username: "e2e_super",
        password: secret(),
        displayName: "E2E Super Admin",
        role: "SUPER_ADMIN",
      },
      { username: "e2e_admin", password: secret(), displayName: "E2E Admin", role: "ADMIN" },
      {
        username: "e2e_admin_off",
        password: secret(),
        displayName: "E2E Disabled Admin",
        role: "ADMIN",
        active: false,
      },
    ],
    // Team A serves the desktop project, team B the mobile project, so the two projects never log the same member in
    // at once (a new login revokes that member's previous session, exactly as in production).
    teams: [team("A"), team("B")],
  };
}

/** The identities of this run: generated once by the process that loads the config, inherited by every worker. */
export function ensureIdentities(): E2EIdentities {
  const existing = process.env.E2E_IDENTITIES;
  if (existing) return JSON.parse(existing) as E2EIdentities;
  const fresh = generateIdentities();
  process.env.E2E_IDENTITIES = JSON.stringify(fresh);
  return fresh;
}

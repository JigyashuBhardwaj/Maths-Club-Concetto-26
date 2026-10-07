import { readFileSync } from "node:fs";
import path from "node:path";

import { request, type BrowserContext, type Page, type TestInfo } from "@playwright/test";

import { ensureIdentities, type E2ETeam } from "./identities";

/** Where global-setup wrote the shared participant sessions (one per project; see identities.ts). */
export const AUTH_DIR = process.env.E2E_AUTH_DIR ?? path.join("node_modules", ".cache", "e2e-auth");

export function teamFor(info: TestInfo): E2ETeam {
  const [a, b] = ensureIdentities().teams as [E2ETeam, E2ETeam];
  return info.project.name === "mobile" ? b : a;
}

export function participantCredentials(team: E2ETeam, slot: 1 | 2 | 3 | 4) {
  const member = team.members.find((m) => m.slot === slot);
  if (!member) throw new Error(`no member in slot ${slot}`);
  return { teamLoginId: team.loginId, password: team.password, admissionNo: member.admissionNo };
}

export function staffCredentials(username: "e2e_super" | "e2e_admin" | "e2e_admin_off") {
  const s = ensureIdentities().staff.find((x) => x.username === username);
  if (!s) throw new Error(`no staff ${username}`);
  return { username: s.username, password: s.password };
}

const origin = () => `http://localhost:${process.env.PORT ?? 3100}`;

type Cookies = Awaited<ReturnType<BrowserContext["cookies"]>>;

/** Real login through the real endpoint (same-origin header included); returns the cookies the server set. */
export async function loginForCookies(
  endpoint: "/api/auth/participant/login" | "/api/auth/staff/login",
  body: Record<string, string>,
): Promise<Cookies> {
  const api = await request.newContext({
    baseURL: origin(),
    extraHTTPHeaders: { Origin: origin() },
  });
  try {
    const res = await api.post(endpoint, { data: body });
    if (!res.ok()) throw new Error(`test login failed: ${endpoint} -> ${res.status()}`);
    return (await api.storageState()).cookies as Cookies;
  } finally {
    await api.dispose();
  }
}

/**
 * Gives a page (or a browser context a test created itself) the project's shared participant session: member 1 of the
 * project's team.
 */
export async function signInSharedParticipant(
  target: Page | BrowserContext,
  info: TestInfo,
): Promise<void> {
  const file = path.join(AUTH_DIR, `${teamFor(info).code}.json`);
  const state = JSON.parse(readFileSync(file, "utf8")) as { cookies: Cookies };
  const context =
    "context" in target && typeof target.context === "function"
      ? target.context()
      : (target as BrowserContext);
  await context.addCookies(state.cookies);
}

/** A fresh staff session (staff sessions are not unique per account, so tests never interfere). */
export async function signInStaff(page: Page, username: "e2e_super" | "e2e_admin"): Promise<void> {
  const cookies = await loginForCookies("/api/auth/staff/login", staffCredentials(username));
  await page.context().addCookies(cookies);
}

/** Test-only controls of the in-memory backend (fake-postgrest.mjs). */
export async function control(
  name: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${process.env.E2E_DB_PORT}/__test/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`control ${name} failed: ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

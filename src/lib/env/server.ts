import "server-only";

import { parseAuthEnv, type AuthEnv } from "./auth";
import { parseServerEnv, type ServerEnv } from "./schema";

let cached: ServerEnv | undefined;

/** Validated server environment. Importing this from a client component fails the build. */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}

let cachedAuth: AuthEnv | undefined;

/** Validated authentication environment (database + session secrets). Throws, naming the variables, when incomplete. */
export function getAuthEnv(): AuthEnv {
  cachedAuth ??= parseAuthEnv(process.env);
  return cachedAuth;
}

import { z } from "zod";

/**
 * Environment the authentication layer needs. Kept apart from `serverEnvSchema` on purpose: pages, `next build` and the
 * health probe must keep working without database credentials, so these are required only where they are used
 * (`getAuthEnv()` in the auth route wiring). Pure, so it can be unit tested.
 */
export const authEnvSchema = z.object({
  APP_ORIGIN: z.url(),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  /** Secret mixed into the session-token hash (HMAC key). At least 32 characters; never logged or exposed. */
  SESSION_TOKEN_PEPPER: z.string().min(32),
});

export type AuthEnv = z.infer<typeof authEnvSchema>;

export function parseAuthEnv(source: Record<string, string | undefined>): AuthEnv {
  const result = authEnvSchema.safeParse({
    APP_ORIGIN: source.APP_ORIGIN || "http://localhost:3000",
    NEXT_PUBLIC_SUPABASE_URL: source.NEXT_PUBLIC_SUPABASE_URL || undefined,
    SUPABASE_SERVICE_ROLE_KEY: source.SUPABASE_SERVICE_ROLE_KEY || undefined,
    SESSION_TOKEN_PEPPER: source.SESSION_TOKEN_PEPPER || undefined,
  });
  if (!result.success) {
    // Name the offending variables, never their values.
    const names = [...new Set(result.error.issues.map((i) => i.path.join(".")))].join(", ");
    throw new Error(`Invalid authentication environment: ${names}`);
  }
  return result.data;
}

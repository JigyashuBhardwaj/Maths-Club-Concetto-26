import { z } from "zod";

/**
 * Server-side environment schema. Pure (no `server-only`) so it can be unit tested.
 * Only variables actually used by shipped code are validated; the Supabase and
 * session variables listed in `.env.example` are reserved for later patches and
 * get validated when the code that needs them arrives.
 */
export const serverEnvSchema = z.object({
  APP_ENV: z.enum(["development", "test", "preview", "production"]).default("development"),
  APP_ORIGIN: z.url().default("http://localhost:3000"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse({
    APP_ENV: source.APP_ENV || undefined,
    APP_ORIGIN: source.APP_ORIGIN || undefined,
  });
  if (!result.success) {
    // Name the offending variables, never their values.
    const names = [...new Set(result.error.issues.map((i) => i.path.join(".")))].join(", ");
    throw new Error(`Invalid environment configuration: ${names}`);
  }
  return result.data;
}

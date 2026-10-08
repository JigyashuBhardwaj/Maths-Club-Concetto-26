import { z } from "zod";

/**
 * Environment of the scheduled sweep (`GET /api/cron/expire-teams`, Patch B15). Kept apart from the other schemas so
 * that a deployment without a secret keeps working: the route then refuses every request (401) and lazy finalization
 * remains the correctness path. Pure, so it can be unit tested.
 */
export const cronEnvSchema = z.object({
  /** Shared secret Vercel Cron sends as `Authorization: Bearer <CRON_SECRET>`. At least 32 characters. */
  CRON_SECRET: z.string().min(32),
});

/** The secret, or `undefined` when it is missing or too short. Never throws and never echoes the value. */
export function parseCronSecret(source: Record<string, string | undefined>): string | undefined {
  const parsed = cronEnvSchema.safeParse({ CRON_SECRET: source.CRON_SECRET || undefined });
  return parsed.success ? parsed.data.CRON_SECRET : undefined;
}

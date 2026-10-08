import { methodNotAllowed } from "@/lib/cron/handlers";
import { expireTeams } from "@/lib/cron/routes";

export const dynamic = "force-dynamic";

export const GET = expireTeams;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

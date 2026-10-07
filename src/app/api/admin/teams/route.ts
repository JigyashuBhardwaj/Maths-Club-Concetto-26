import { createTeam, listTeams } from "@/lib/provisioning/routes";

export const dynamic = "force-dynamic";

export const GET = listTeams;
export const POST = createTeam;

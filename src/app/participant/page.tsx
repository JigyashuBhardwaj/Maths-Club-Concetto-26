import { ParticipantHome } from "@/components/home/participant-home";
import { requireArea } from "@/lib/auth/guard";
import { loadCompetitionRules } from "@/lib/renewal/server-data";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireArea("participant");
  // The rules in force: what the last renewal wrote, else the official rules. Read per request, so a renewal shows at once.
  const rules = await loadCompetitionRules();
  return <ParticipantHome rules={rules} />;
}

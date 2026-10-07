import { ParticipantHome } from "@/components/home/participant-home";
import { requireArea } from "@/lib/auth/guard";

export default async function Page() {
  await requireArea("participant");
  return <ParticipantHome />;
}

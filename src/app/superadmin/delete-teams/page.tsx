import { DeletionScreen } from "@/components/deletion/deletion-screen";
import { requireStaffArea } from "@/lib/auth/guard";
import { loadDeletableTeams } from "@/lib/deletion/server-data";

export default async function Page() {
  const principal = await requireStaffArea("superadmin");
  const teams = await loadDeletableTeams(principal.staff.id);
  return <DeletionScreen kind="teams" initialTeams={teams} />;
}

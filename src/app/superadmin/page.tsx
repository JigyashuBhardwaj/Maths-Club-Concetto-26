import { StaffHome } from "@/components/provisioning/staff-home";
import { requireStaffArea } from "@/lib/auth/guard";
import { loadLeaderboard } from "@/lib/provisioning/server-data";

export default async function Page() {
  const principal = await requireStaffArea("superadmin");
  const rows = await loadLeaderboard(principal.staff.id);
  return (
    <StaffHome
      title="Superadmin"
      description="Use Create admin in the sidebar to add an Admin who can sign in and create teams. The live leaderboard of every team is on the right."
      rows={rows}
    />
  );
}

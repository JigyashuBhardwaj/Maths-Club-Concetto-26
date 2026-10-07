import { StaffHome } from "@/components/provisioning/staff-home";
import { requireStaffArea } from "@/lib/auth/guard";
import { loadLeaderboard } from "@/lib/provisioning/server-data";

export default async function Page() {
  const principal = await requireStaffArea("admin");
  const rows = await loadLeaderboard(principal.staff.id);
  return (
    <StaffHome
      title="Admin"
      description="Use Create a team in the sidebar to add a team, and My teams to see the teams you created. The live leaderboard of every team is on the right."
      rows={rows}
    />
  );
}

import { CompetitionControl } from "@/components/lifecycle/competition-control";
import { StaffHome } from "@/components/provisioning/staff-home";
import { requireStaffArea } from "@/lib/auth/guard";
import { loadLeaderboard } from "@/lib/provisioning/server-data";
import { loadCompetitionOverview } from "@/lib/runtime/server-data";

// The competition's status changes while the Super Admin is away: always read it fresh.
export const dynamic = "force-dynamic";

export default async function Page() {
  const principal = await requireStaffArea("superadmin");
  const [rows, overview] = await Promise.all([
    loadLeaderboard(principal.staff.id),
    loadCompetitionOverview(principal.staff.id),
  ]);
  return (
    <StaffHome
      title="Superadmin"
      description="Use Create admin in the sidebar to add an Admin who can sign in and create teams. The live leaderboard of every team is on the right."
      rows={rows}
    >
      <CompetitionControl initial={overview} />
    </StaffHome>
  );
}

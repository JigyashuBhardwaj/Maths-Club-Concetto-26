import { MyTeamsMatrix } from "@/components/admin/my-teams-matrix";
import { requireStaffArea } from "@/lib/auth/guard";
import { loadMatrix } from "@/lib/matrix/server-data";

export const metadata = { title: "My teams" };

/**
 * "My teams" (docs: admin dashboard ui): the live matrix of the teams the signed-in Admin created. The rows are the
 * Admin's own teams, read from the database on every request (B12 ownership is unchanged: `teams.admin_id`), so signing
 * out and in again or navigating away loses nothing. The client component then keeps the board live.
 */
export default async function Page() {
  const principal = await requireStaffArea("admin");
  const initial = await loadMatrix(principal.staff.id);
  return (
    <div className="w-full max-w-7xl">
      <MyTeamsMatrix initial={initial} />
    </div>
  );
}

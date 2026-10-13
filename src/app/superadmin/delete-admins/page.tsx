import { DeletionScreen } from "@/components/deletion/deletion-screen";
import { requireStaffArea } from "@/lib/auth/guard";
import { loadDeletableAdmins } from "@/lib/deletion/server-data";

export default async function Page() {
  const principal = await requireStaffArea("superadmin");
  const admins = await loadDeletableAdmins(principal.staff.id);
  return <DeletionScreen kind="admins" initialAdmins={admins} />;
}

import { RenewScreen } from "@/components/renewal/renew-screen";
import { requireStaffArea } from "@/lib/auth/guard";
import { loadRenewal } from "@/lib/renewal/server-data";

export const dynamic = "force-dynamic";

export default async function Page() {
  const principal = await requireStaffArea("superadmin");
  const initial = await loadRenewal(principal.staff.id);
  return <RenewScreen initial={initial} />;
}

import { PlaceholderPage } from "@/components/shell/placeholder-page";
import { requireArea } from "@/lib/auth/guard";

export default async function Page() {
  await requireArea("superadmin");
  return (
    <PlaceholderPage
      title="Superadmin"
      description="The super-admin interface (admin management, team assignment, UFM, audit log) is not built yet. This route only demonstrates the shell."
    />
  );
}

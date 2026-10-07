import { PlaceholderPage } from "@/components/shell/placeholder-page";
import { requireArea } from "@/lib/auth/guard";

export default async function Page() {
  await requireArea("admin");
  return (
    <PlaceholderPage
      title="Admin"
      description="The admin interface (assigned teams, review queue, hints) is not built yet. This route only demonstrates the shell."
    />
  );
}

import Link from "next/link";

import { ReviewQueue } from "@/components/admin/review-queue";
import { GlassPanel } from "@/components/ui/glass-panel";
import { requireStaffArea } from "@/lib/auth/guard";

export const metadata = { title: "Review queue" };

/** Temporary B13 testing page: pending submissions with Approve / Disapprove. Not the final Admin dashboard. */
export default async function Page() {
  await requireStaffArea("admin");
  return (
    <GlassPanel className="max-w-4xl p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-ink">Review queue</h1>
        <Link href="/admin" className="btn btn-primary max-w-40">
          <span className="grid h-full place-items-center">Go back</span>
        </Link>
      </div>
      <div className="mt-6">
        <ReviewQueue />
      </div>
    </GlassPanel>
  );
}

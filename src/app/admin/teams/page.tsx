import Link from "next/link";

import { GlassPanel } from "@/components/ui/glass-panel";
import { requireStaffArea } from "@/lib/auth/guard";
import { loadMyTeams } from "@/lib/provisioning/server-data";

export const metadata = { title: "My teams" };

/**
 * "My teams": the teams created by the signed-in Admin, read from the database on every request (so signing out and in
 * again, or reloading, shows the same list). Member presence, theme progress and review controls arrive in later
 * milestones; this page only establishes ownership.
 */
export default async function Page() {
  const principal = await requireStaffArea("admin");
  const teams = await loadMyTeams(principal.staff.id);

  return (
    <GlassPanel className="max-w-4xl p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-ink">My teams</h1>
        <Link href="/admin" className="btn btn-primary max-w-40">
          <span className="grid h-full place-items-center">Go back</span>
        </Link>
      </div>

      {teams.length === 0 ? (
        <p className="mt-6 text-sm text-ink-dim">
          You have not created a team yet. Use Create a team in the sidebar.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto" role="region" aria-label="My teams" tabIndex={0}>
          <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
            <thead>
              <tr className="text-[11px] tracking-[0.2em] text-ink-dim uppercase">
                <th scope="col" className="py-2 pr-4 font-semibold">
                  Team_ID
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  Team name
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  Login ID
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  Members
                </th>
                <th scope="col" className="py-2 font-semibold">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => (
                <tr key={team.id} className="border-t border-line text-ink">
                  <th scope="row" className="py-2.5 pr-4 font-semibold">
                    {team.team_code}
                  </th>
                  <td className="py-2.5 pr-4">{team.name}</td>
                  <td className="py-2.5 pr-4">{team.login_id}</td>
                  <td className="py-2.5 pr-4">{team.member_count}</td>
                  <td className="py-2.5">{team.status.replace(/_/g, " ").toLowerCase()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </GlassPanel>
  );
}

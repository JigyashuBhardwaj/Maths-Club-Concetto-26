import { createAdmin } from "@/lib/provisioning/routes";
import { listDeletableAdmins } from "@/lib/deletion/routes";

export const dynamic = "force-dynamic";

export const GET = listDeletableAdmins;
export const POST = createAdmin;

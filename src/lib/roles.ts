/**
 * The three portal roles, in the order they appear on the landing page.
 * Single source of truth for labels and routes; the landing selector, login
 * placeholder and app shells all derive from this list.
 */
export const ROLES = [
  { id: "superadmin", label: "Superadmin", home: "/superadmin" },
  { id: "admin", label: "Admin", home: "/admin" },
  { id: "participant", label: "Participant", home: "/participant" },
] as const;

export type Role = (typeof ROLES)[number];
export type RoleId = Role["id"];

export const ROLE_IDS = ROLES.map((r) => r.id) as readonly RoleId[];

export function isRoleId(value: string): value is RoleId {
  return (ROLE_IDS as readonly string[]).includes(value);
}

export function getRole(id: RoleId): Role {
  const role = ROLES.find((r) => r.id === id);
  if (!role) throw new Error(`Unknown role: ${id}`);
  return role;
}

export function loginPath(id: RoleId): string {
  return `/login/${id}`;
}

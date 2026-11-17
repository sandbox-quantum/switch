import type { Member, TenantRole } from "../../data/api";

export interface WorkspaceRoleOption {
  role: TenantRole;
  label: string;
  description: string;
}

/** The roles a person can hold in a workspace, as the role pickers name and
 * describe them. Org admin is not one: it is granted in the organization's
 * settings, and comes with admin of every workspace in it. */
export const WORKSPACE_ROLES: readonly WorkspaceRoleOption[] = [
  {
    role: "admin",
    label: "Workspace admin",
    description:
      "One workspace — invite and remove users, turn connectors on and off, connect messaging apps, manage rooms, agents, devices and templates, set budgets.",
  },
  {
    role: "member",
    label: "Member",
    description:
      "Their own resources — create and manage their own agents and rooms, connect their own accounts and grant them to their agents, add their own devices, run shared templates.",
  },
];

export type RoleTone = "organization" | "admin" | "member";

/** What someone acts as here, strongest first: an organization admin is an
 * admin of every workspace whatever their own membership says. */
export function roleOf(member: Pick<Member, "role" | "organization_role">): {
  label: string;
  tone: RoleTone;
} {
  if (member.organization_role === "org_admin") return { label: "Org admin", tone: "organization" };
  return member.role === "admin"
    ? { label: "Workspace admin", tone: "admin" }
    : { label: "Member", tone: "member" };
}

export function workspaceRoleLabel(role: TenantRole): string {
  const option = WORKSPACE_ROLES.find((r) => r.role === role);
  if (option === undefined) throw new Error(`No workspace role "${role}"`);
  return option.label;
}

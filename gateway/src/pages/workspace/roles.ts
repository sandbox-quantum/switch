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
      "Runs the whole workspace: invites and removes users, and manages every agent, room and template, its messaging apps and its budgets.",
  },
  {
    role: "member",
    label: "Member",
    description:
      "Works with their own: creates and manages their own agents and rooms, takes part in rooms they're added to, and runs the workspace's templates.",
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

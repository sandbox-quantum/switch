import {
  type TenantMembership,
  type WorkspaceCounts,
  fetchCurrentOrganization,
  fetchOrganizations,
} from "./api";

/** An organization the switcher can name. */
export interface OrganizationName {
  id: string;
  name: string;
}

/** The organizations the switcher names: those of the workspaces the caller
 * may enter, and the current workspace's where it is none of those, as when
 * the platform operator entered it on the operator flag alone. Left out, it
 * would leave the breadcrumb without its organization and the switcher
 * without headings. */
export async function loadOrganizationNames(
  currentOrganizationId: string | null,
): Promise<OrganizationName[]> {
  const listed: OrganizationName[] = await fetchOrganizations();
  if (currentOrganizationId === null || listed.some((o) => o.id === currentOrganizationId)) {
    return listed;
  }
  const current = await fetchCurrentOrganization();
  return [...listed, { id: current.id, name: current.name }];
}

/** The workspaces of one organization, as the switcher lists them. */
export interface WorkspaceGroup {
  /** Null for the workspaces that name no organization. */
  organizationId: string | null;
  /** Null where the organization could not be named. */
  name: string | null;
  workspaces: TenantMembership[];
}

/** What the switcher lists: every workspace the session may enter, and the
 * current one where it is none of those, as when the platform operator
 * entered it on the operator flag alone. */
export function switcherWorkspaces(
  current: TenantMembership | null,
  tenants: TenantMembership[],
): TenantMembership[] {
  if (current === null || tenants.some((t) => t.id === current.id)) return tenants;
  return [current, ...tenants];
}

/** The name of `organizationId` among `organizations`, or null. */
export function organizationName(
  organizationId: string | null,
  organizations: OrganizationName[],
): string | null {
  if (organizationId === null) return null;
  return organizations.find((o) => o.id === organizationId)?.name ?? null;
}

function byName(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

/** `workspaces` in one section per organization, each headed with its name,
 * where there is more than one organization and every one of them has a
 * name to show. Otherwise one unheaded section: headings without names would
 * read as several identical ones. Sections and the workspaces in each are in
 * name order, the workspaces of no organization last. As Console's switcher
 * decides it (`organization-groups.ts`). */
export function switcherSections(
  workspaces: TenantMembership[],
  organizations: OrganizationName[],
): { sections: WorkspaceGroup[]; headed: boolean } {
  const sorted = [...workspaces].sort((a, b) => byName(a.name, b.name));
  const groups = new Map<string | null, WorkspaceGroup>();
  for (const workspace of sorted) {
    const key = workspace.organization_id;
    let group = groups.get(key);
    if (group === undefined) {
      group = { organizationId: key, name: organizationName(key, organizations), workspaces: [] };
      groups.set(key, group);
    }
    group.workspaces.push(workspace);
  }
  const sections = [...groups.values()].sort((a, b) => {
    if (a.organizationId === null) return 1;
    if (b.organizationId === null) return -1;
    return byName(a.name, b.name);
  });
  if (sections.length <= 1) return { sections, headed: false };
  const named = sections.every((s) => s.organizationId === null || s.name !== null);
  if (named) return { sections, headed: true };
  return { sections: [{ organizationId: null, name: null, workspaces: sorted }], headed: false };
}

function counted(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

/** "3 users · 2 agents", for a workspace's line in the switcher. */
export function countsLabel(counts: WorkspaceCounts): string {
  return `${counted(counts.users, "user")} · ${counted(counts.agents, "agent")}`;
}

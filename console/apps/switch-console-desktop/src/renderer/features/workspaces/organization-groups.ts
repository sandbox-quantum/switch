import {
  administersOrganization,
  type Workspace,
  workspaceUnavailability,
} from '@shared/core/workspaces/workspaces';

/** A server's workspaces in one organization, in the order they were listed. */
export type OrganizationGroup = {
  /** Null for the workspaces that name no organization. */
  organizationId: string | null;
  name: string | null;
  workspaces: Workspace[];
};

/**
 * `workspaces` grouped by the organization each belongs to, the groups in the
 * order their first workspace appears.
 *
 * Every workspace names an organization on a server that has them, and none
 * does on one from before them, so a server's list is one group there.
 */
export function groupByOrganization(workspaces: Workspace[]): OrganizationGroup[] {
  const groups = new Map<string | null, OrganizationGroup>();
  for (const workspace of workspaces) {
    const key = workspace.organizationId;
    let group = groups.get(key);
    if (!group) {
      group = { organizationId: key, name: workspace.organizationName, workspaces: [] };
      groups.set(key, group);
    }
    group.name ??= workspace.organizationName;
    group.workspaces.push(workspace);
  }
  return [...groups.values()];
}

/** What a server answered about creating, for the workspace it was asked about. */
export type CreationAnswer = { canAddWorkspace: boolean; workspaceId: string };

/**
 * The workspace to add another to `group`'s organization through, or null when
 * the account may not.
 *
 * The workspace is any one the account can open there as its `org_admin`: the
 * gateway reads the organization from the workspace the call is scoped to.
 *
 * The server's answer was given for one workspace. Where the account is an
 * `org_admin` there, a refusal is about the account — its allowance spent, or
 * a deployment that keeps to one workspace — and holds in every organization;
 * anywhere else it says nothing about this one, and the role decides until the
 * server refuses.
 */
export function addWorkspaceThrough(
  group: OrganizationGroup,
  onServer: Workspace[],
  answer: CreationAnswer | null
): Workspace | null {
  if (group.organizationId === null) return null;
  const through = group.workspaces.find(
    (workspace) =>
      administersOrganization(workspace) &&
      workspaceUnavailability(workspace, onServer.length) === null
  );
  if (!through || answer === null) return through ?? null;
  const asked = onServer.find((workspace) => workspace.id === answer.workspaceId);
  if (asked && administersOrganization(asked) && !answer.canAddWorkspace) return null;
  return through;
}

import {
  addJoinDomain,
  createInvitation,
  fetchInvitations,
  fetchInviteEmailEnabled,
  fetchJoinDomains,
  removeJoinDomain,
  revokeInvitation,
} from '@main/core/switch-servers/gateway-client';
import {
  inviteLink,
  type CreatedInvitation,
  type CreateInvitationParams,
  type Invitation,
  type WorkspaceInvitations,
  type WorkspaceJoinDomains,
} from '@shared/core/workspaces/invitations';
import { withReachableWorkspaceSession } from './workspace-session';
import { requireWorkspace } from './workspaces-store';

/**
 * The gateway's id for a workspace, which the invitation routes are addressed by.
 *
 * A workspace not yet matched to a tenant has none, and there is nothing to
 * invite anyone to until it has: the call would name no workspace at all.
 */
async function requireTenantId(workspaceId: string): Promise<string> {
  const workspace = await requireWorkspace(workspaceId);
  if (workspace.tenantId === null) {
    throw new Error(
      `${workspace.name} is not matched to a workspace on its server yet, so there is nothing to invite anyone to. Sign in to the server again and retry.`
    );
  }
  return workspace.tenantId;
}

export async function listWorkspaceInvitations(workspaceId: string): Promise<WorkspaceInvitations> {
  const tenantId = await requireTenantId(workspaceId);
  return withReachableWorkspaceSession(workspaceId, async (server) => {
    const [invitations, emailEnabled] = await Promise.all([
      fetchInvitations(server, tenantId),
      fetchInviteEmailEnabled(server),
    ]);
    return { invitations, emailEnabled };
  });
}

export async function createWorkspaceInvitation({
  workspaceId,
  ...params
}: CreateInvitationParams): Promise<CreatedInvitation> {
  const tenantId = await requireTenantId(workspaceId);
  return withReachableWorkspaceSession(workspaceId, async (server) => {
    const created = await createInvitation(server, tenantId, params);
    return {
      invitation: created.invitation,
      link: inviteLink(server.gatewayUrl, created.token),
      emailDelivery: created.emailDelivery,
    };
  });
}

export async function revokeWorkspaceInvitation({
  workspaceId,
  invitationId,
}: {
  workspaceId: string;
  invitationId: string;
}): Promise<Invitation> {
  const tenantId = await requireTenantId(workspaceId);
  return withReachableWorkspaceSession(workspaceId, (server) =>
    revokeInvitation(server, tenantId, invitationId)
  );
}

export async function listWorkspaceJoinDomains(workspaceId: string): Promise<WorkspaceJoinDomains> {
  const tenantId = await requireTenantId(workspaceId);
  return withReachableWorkspaceSession(workspaceId, (server) => fetchJoinDomains(server, tenantId));
}

export async function addWorkspaceJoinDomain({
  workspaceId,
  domain,
}: {
  workspaceId: string;
  domain: string;
}): Promise<void> {
  const tenantId = await requireTenantId(workspaceId);
  return withReachableWorkspaceSession(workspaceId, (server) =>
    addJoinDomain(server, tenantId, domain)
  );
}

export async function removeWorkspaceJoinDomain({
  workspaceId,
  domain,
}: {
  workspaceId: string;
  domain: string;
}): Promise<void> {
  const tenantId = await requireTenantId(workspaceId);
  return withReachableWorkspaceSession(workspaceId, (server) =>
    removeJoinDomain(server, tenantId, domain)
  );
}

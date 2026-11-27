/**
 * Workspace invitation types shared between Console and the gateway.
 */

export type Invitation = {
  id: string;
  role: string;
  email: string | null;
  expiresAt: string;
  usesRemaining: number;
  revokedAt: string | null;
  createdAt: string;
};

export type PendingInvitation = {
  id: string;
  tenantId: string;
  workspaceName: string;
  role: string;
  expiresAt: string;
  invitedBy: string;
};

export type JoinableWorkspace = {
  tenantId: string;
  workspaceName: string;
  domain: string;
};

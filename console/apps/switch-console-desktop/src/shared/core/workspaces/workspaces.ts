/**
 * Shared types for workspaces: what a Switch Console window is scoped to, and
 * the thing agents belong to.
 *
 * A workspace sits one level below a registered server. On a server with
 * tenancy it mirrors a tenant the signed-in user is a member of; the server's
 * own identity (its URLs, its session cookie, its auth method) stays at the
 * server, because one session cookie covers every workspace on it.
 */

/** The caller's standing in a workspace, as the gateway reports it. */
export type WorkspaceRole = 'owner' | 'admin' | 'member';

/**
 * The caller's standing in the organization a workspace belongs to. An
 * `org_admin` administers every workspace in it, and may add more.
 */
export type OrganizationRole = 'org_admin' | 'member';

/** A workspace on a registered Switch server. */
export type Workspace = {
  id: string;
  serverId: string;
  name: string;
  /**
   * The workspace's tenant id on the gateway.
   *
   * Null means the workspace has not been matched to a tenant yet — the state
   * every workspace starts in, since one is created locally the moment a server
   * is registered and the gateway is only asked afterwards. It is a transient
   * "not reconciled yet", not a description of the server.
   */
  tenantId: string | null;
  /** The gateway's slug for the workspace; null alongside a null `tenantId`. */
  slug: string | null;
  /**
   * Null alongside a null `tenantId`, where the notion does not apply yet — and
   * null beside a tenant id once the membership has been withdrawn, which is
   * what {@link isWithdrawnWorkspace} reads.
   */
  role: WorkspaceRole | null;
  /**
   * The organization the workspace belongs to on the gateway. Null on a server
   * from before organizations, and alongside a null `tenantId`.
   */
  organizationId: string | null;
  /**
   * The organization's name. Null where `organizationId` is, and on a server
   * that reports the id but cannot yet list organizations by name.
   */
  organizationName: string | null;
  /** The caller's role in that organization; null where `organizationId` is. */
  organizationRole: OrganizationRole | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Whether this account runs a workspace — invites people to it, connects its
 * messaging apps — which the gateway also enforces.
 */
export function administersWorkspace(workspace: Workspace): boolean {
  return workspace.role === 'owner' || workspace.role === 'admin';
}

/**
 * Whether this account may add workspaces to the organization `workspace`
 * belongs to. Whether the server allows it right now (its allowance) is the
 * server's to say; this is only the role.
 */
export function administersOrganization(workspace: Workspace): boolean {
  return workspace.organizationRole === 'org_admin' && !isWithdrawnWorkspace(workspace);
}

/**
 * Whether this account has lost its membership of a workspace still held here.
 *
 * The row is kept so the agents registered through it stay attached to
 * something, but nothing scoped to it can be answered any more: the gateway
 * refuses a session selecting a tenant the account does not belong to. Views
 * say so rather than offering it, so the refusal is read before the click
 * rather than after it.
 */
export function isWithdrawnWorkspace(workspace: Workspace): boolean {
  return workspace.tenantId !== null && workspace.role === null;
}

/**
 * Whether a row that names no tenant is one nothing can answer for.
 *
 * Every server's first workspace is created tenant-less and matched to a
 * membership by the reconcile, so on a server holding one workspace this state
 * is ordinary: there is nothing to confuse it with, and the gateway resolves
 * the account's sole membership to exactly that row. Beside siblings it is the
 * placeholder the reconcile could not match, kept only because it holds agents
 * — and a call scoped to it selects no tenant, so the gateway answers with
 * whichever workspace the session last selected, under this one's name.
 *
 * `onSameServer` is every workspace on the server, this one included.
 */
export function isUnmatchedWorkspace(workspace: Workspace, onSameServer: number): boolean {
  return workspace.tenantId === null && onSameServer > 1;
}

/** Why a workspace cannot be opened, or null when it can. */
export type WorkspaceUnavailability = 'withdrawn' | 'unmatched';

/**
 * The two ways a workspace held here can be one nothing scoped to it will be
 * answered for, as one question — so a view offering workspaces cannot rule out
 * the first and go on offering the second.
 */
export function workspaceUnavailability(
  workspace: Workspace,
  onSameServer: number
): WorkspaceUnavailability | null {
  if (isWithdrawnWorkspace(workspace)) return 'withdrawn';
  return isUnmatchedWorkspace(workspace, onSameServer) ? 'unmatched' : null;
}

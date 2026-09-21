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
  createdAt: string;
  updatedAt: string;
};

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

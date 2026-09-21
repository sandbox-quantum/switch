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
  /** Null alongside a null `tenantId`, where the notion does not apply yet. */
  role: WorkspaceRole | null;
  createdAt: string;
  updatedAt: string;
};

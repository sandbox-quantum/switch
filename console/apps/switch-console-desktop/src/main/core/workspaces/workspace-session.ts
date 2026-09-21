import { decodeJwtTenantId, switchTenant } from '@main/core/switch-servers/gateway-client';
import { hostUnreachable, requireServer } from '@main/core/switch-servers/require-server';
import { getSessionCookie } from '@main/core/switch-servers/servers-store';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { isUnmatchedWorkspace, type Workspace } from '@shared/core/workspaces/workspaces';
import { clearAssertedTenant, setAssertedTenant } from './asserted-tenant';
import { listWorkspacesForServer, requireWorkspace } from './workspaces-store';

/**
 * Calls in flight on a server's current tenant selection, and the queue that
 * changes it.
 *
 * A server session selects one tenant at a time, so a workspace-scoped call is
 * only addressing the workspace it names while that selection matches. Calls
 * that share the selection run in parallel and hold a lease; changing the
 * selection waits for every lease to be given up, so a switch can never land
 * between another call reading the cookie and sending it.
 */
type ServerSession = {
  leases: number;
  /** Resolvers waiting for `leases` to reach zero. */
  idle: Array<() => void>;
};

const sessions = new Map<string, ServerSession>();

/** Serialises the decision to switch, per server — never the calls themselves. */
const admissions = new Map<string, Promise<unknown>>();

function sessionFor(serverId: string): ServerSession {
  let session = sessions.get(serverId);
  if (!session) {
    session = { leases: 0, idle: [] };
    sessions.set(serverId, session);
  }
  return session;
}

function release(serverId: string, session: ServerSession): void {
  session.leases -= 1;
  if (session.leases > 0) return;
  for (const resolve of session.idle.splice(0)) resolve();
  clearAssertedTenant(serverId);
}

/**
 * Drop everything held for a server that no longer exists.
 *
 * Nothing prunes these as calls finish — an entry is the server's, not a call's
 * — so a removal is the one moment they can go. Left behind, a lease that leaked
 * would be inherited by whatever next holds the id, and a switch waiting for it
 * to be given up would wait for a call that ended with the server.
 */
export function forgetServerSession(serverId: string): void {
  const session = sessions.get(serverId);
  // Waiters first: a switch queued behind a server that has just gone would
  // otherwise never be woken at all.
  if (session) for (const resolve of session.idle.splice(0)) resolve();
  sessions.delete(serverId);
  admissions.delete(serverId);
  clearAssertedTenant(serverId);
}

function whenIdle(session: ServerSession): Promise<void> {
  if (session.leases === 0) return Promise.resolve();
  return new Promise<void>((resolve) => session.idle.push(resolve));
}

function admit<T>(serverId: string, task: () => Promise<T>): Promise<T> {
  const queued = (admissions.get(serverId) ?? Promise.resolve()).then(task, task);
  admissions.set(
    serverId,
    queued.then(
      () => {},
      () => {}
    )
  );
  return queued;
}

/**
 * Take a lease on `server`'s session with `tenantId` selected, switching the
 * selection first if it is something else.
 *
 * The caller must release the lease. Never call this from inside a leased call
 * on the same server: a switch waits for outstanding leases, and a call waiting
 * on its own would wait forever.
 */
async function acquire(server: SwitchServer, tenantId: string | null): Promise<ServerSession> {
  const session = sessionFor(server.id);
  await admit(server.id, async () => {
    if (tenantId !== null) {
      const cookie = await getSessionCookie(server.id);
      if (!cookie || decodeJwtTenantId(cookie) !== tenantId) {
        await whenIdle(session);
        await switchTenant(server, tenantId);
      }
      setAssertedTenant(server.id, tenantId);
    }
    session.leases += 1;
  });
  return session;
}

/**
 * The workspace, refusing one that names no tenant on a server holding several.
 *
 * A row without a tenant asserts nothing, so the call goes out under whatever
 * the session last selected and the gateway answers for that — another
 * workspace's rooms and agents, under this one's name, with no error anywhere.
 * Refusing costs nothing where a server holds one workspace: there is nothing
 * to confuse it with, and the gateway resolves the account's sole membership to
 * exactly that row.
 */
async function requireAddressableWorkspace(workspaceId: string): Promise<Workspace> {
  const workspace = await requireWorkspace(workspaceId);
  if (workspace.tenantId) return workspace;
  const onServer = await listWorkspacesForServer(workspace.serverId);
  if (isUnmatchedWorkspace(workspace, onServer.length)) {
    throw new Error(
      // Not "sign in again": signing in re-runs the reconcile, which is what
      // left the row unmatched in the first place and would do so again. The
      // row only survives because it holds agents, so the way out is to open
      // one of the workspaces the account does belong to and add those agents
      // there.
      `This workspace has not been matched to one of the ${onServer.length} this account belongs to on its Switch server, so there is no way to tell which one to ask. Switch to one of the others on this server; the agents left here have to be added again in the workspace they belong to.`
    );
  }
  return workspace;
}

/**
 * The server hosting a workspace, with no session work done.
 *
 * For the callers that have to know which server they are about to address
 * before they address it — the ones that report their own outcome, and so must
 * be able to count a refusal the session seam would otherwise raise past them.
 */
export async function workspaceServer(workspaceId: string): Promise<SwitchServer> {
  const workspace = await requireWorkspace(workspaceId);
  return requireServer(workspace.serverId);
}

/**
 * Run `fn` against the server hosting `workspaceId`, with that workspace's
 * tenant selected on the session.
 *
 * This is the seam every call that reads or writes tenant-owned data goes
 * through — rooms, agents, bridges, identities. Without it the renderer showing
 * one workspace while the session still selects another is invisible: every
 * call succeeds and answers with the other workspace's data. Making the
 * selection part of resolving the workspace makes that impossible rather than
 * something a bug report eventually surfaces.
 *
 * A workspace that has not been matched to a tenant yet asserts nothing — there
 * is no id to select, and the call goes out against whatever the session
 * resolves. That is the right answer only while the server holds one workspace,
 * which is why the rest are refused; see `requireAddressableWorkspace`. It still
 * takes a lease, so it cannot straddle another workspace's switch.
 */
export async function withWorkspaceSession<T>(
  workspaceId: string,
  fn: (server: SwitchServer) => Promise<T>
): Promise<T> {
  const workspace = await requireAddressableWorkspace(workspaceId);
  const server = await requireServer(workspace.serverId);
  const session = await acquire(server, workspace.tenantId);
  try {
    return await fn(server);
  } finally {
    release(server.id, session);
  }
}

/**
 * {@link withWorkspaceSession}, refusing to touch the gateway while the host
 * the server is managed on is unreachable (CHOO-1780).
 *
 * Checked before the session is acquired, so an unreachable host costs no
 * switch and starts no side effect it cannot finish.
 */
export async function withReachableWorkspaceSession<T>(
  workspaceId: string,
  fn: (server: SwitchServer) => Promise<T>
): Promise<T> {
  const workspace = await requireAddressableWorkspace(workspaceId);
  const server = await requireServer(workspace.serverId);
  const unreachable = hostUnreachable(server);
  if (unreachable) throw unreachable;
  const session = await acquire(server, workspace.tenantId);
  try {
    return await fn(server);
  } finally {
    release(server.id, session);
  }
}

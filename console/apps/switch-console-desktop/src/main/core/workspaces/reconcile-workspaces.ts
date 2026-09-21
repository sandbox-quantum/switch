import { isManagedServerRunning } from '@main/core/managed-switch-server/managed-server-status';
import {
  decodeJwtTenantId,
  fetchTenants,
  type RemoteTenant,
} from '@main/core/switch-servers/gateway-client';
import { requireServer } from '@main/core/switch-servers/require-server';
import { getSessionCookie, listServers } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import type { Workspace } from '@shared/core/workspaces/workspaces';
import {
  clearWorkspaceRole,
  createTenantWorkspace,
  discardEmptyWorkspace,
  listWorkspacesForServer,
  setWorkspaceTenant,
  workspaceHasAgents,
} from './workspaces-store';

/**
 * The tenant this server's session resolves to — the one whose data every call
 * made against it so far has actually reached.
 *
 * The gateway resolves a session to the tenant its cookie selects, or to the
 * sole membership when nothing is selected; with several memberships and no
 * selection it refuses the request instead of guessing. So a server that has
 * ever answered has exactly one answer here, and when there is none nothing has
 * been attached to a workspace yet and there is nothing to get wrong.
 */
async function resolvedTenant(
  server: SwitchServer,
  tenants: RemoteTenant[]
): Promise<RemoteTenant | null> {
  const cookie = await getSessionCookie(server.id);
  const selected = cookie ? decodeJwtTenantId(cookie) : null;
  // A claim naming a membership the account no longer holds answers nothing, so
  // it falls through rather than standing in the way of the sole-membership
  // answer below — which is what the gateway itself would resolve the next call
  // to.
  const claimed = selected ? tenants.find((tenant) => tenant.id === selected) : undefined;
  if (claimed) return claimed;
  return tenants.length === 1 ? tenants[0]! : null;
}

/**
 * The membership to give the tenant-less row a server is registered with, or
 * null when it cannot be told and must not be guessed.
 *
 * Every server starts with one such row, and until it is matched it belongs to
 * nothing: a call scoped to it selects no tenant, so the gateway answers under
 * whatever the session last selected — another workspace's rooms and agents,
 * under this one's name, with no error anywhere. Leaving one behind while
 * creating a row per membership is how that used to happen on every
 * multi-membership sign-in.
 */
async function tenantToAdopt(
  server: SwitchServer,
  unclaimed: Workspace,
  tenants: RemoteTenant[],
  unmatched: RemoteTenant[]
): Promise<RemoteTenant | null> {
  // The one this row's calls have been reaching all along, when no other row
  // holds it already.
  const resolved = await resolvedTenant(server, tenants);
  if (resolved && unmatched.some((tenant) => tenant.id === resolved.id)) return resolved;
  // Nothing was ever registered through it, so there is no data to put
  // anywhere: a membership the user can see and switch away from beats a row
  // belonging to none of them.
  if (unmatched.length > 0 && !(await workspaceHasAgents(unclaimed.id))) return unmatched[0]!;
  return null;
}

/**
 * Mark the workspaces still held locally for a membership that has gone.
 *
 * The row is kept — deleting it would silently detach its agents — so the mark
 * is what stops it reading as a workspace the user can still open. A log line
 * alone would leave the switcher listing it exactly like the others, and the
 * only sign would be the gateway refusing the call after the click.
 */
async function markWithdrawnMemberships(
  serverId: string,
  local: Workspace[],
  tenants: RemoteTenant[]
): Promise<void> {
  for (const workspace of local) {
    if (!workspace.tenantId) continue;
    if (tenants.some((tenant) => tenant.id === workspace.tenantId)) continue;
    log.warn(
      'workspaces: this account is no longer a member of a workspace held locally; calls scoped to it will be refused',
      { server: serverId, workspace: workspace.id }
    );
    if (workspace.role !== null) await clearWorkspaceRole(workspace.id);
  }
}

/**
 * Match this install's workspaces for a server against the memberships the
 * gateway reports.
 *
 * A server registers before anyone asks which workspaces its account belongs
 * to, so its first row is created tenant-less and named after the server. This
 * is what later gives that row its tenant — claiming it rather than replacing
 * it, so the agents registered through it stay where they are — and adds a row
 * for every other membership.
 *
 * A row whose membership has been withdrawn is kept, not deleted. Deleting it
 * would silently detach that workspace's agents; leaving it means the next call
 * scoped to it fails and says why.
 */
export async function reconcileServerWorkspaces(serverId: string): Promise<void> {
  // The boot sweep is not awaited and a sign-in can land in the middle of it.
  // Two passes that both read the rows before either writes create the same
  // tenant twice, and the unique index turns the loser into an error that
  // abandons the rest of its pass — so they run one after the other instead.
  const queued = (inFlight.get(serverId) ?? Promise.resolve()).then(
    () => reconcileOneServer(serverId),
    () => reconcileOneServer(serverId)
  );
  inFlight.set(
    serverId,
    queued.then(
      () => {},
      () => {}
    )
  );
  return queued;
}

const inFlight = new Map<string, Promise<void>>();

async function reconcileOneServer(serverId: string): Promise<void> {
  const server = await requireServer(serverId);
  const tenants = await fetchTenants(server);
  if (tenants.length === 0) {
    log.warn('workspaces: the gateway reports no workspace membership for this account', {
      server: serverId,
    });
    return;
  }

  const local = await listWorkspacesForServer(serverId);
  await markWithdrawnMemberships(serverId, local, tenants);

  const claimed = new Map(
    local
      .filter((workspace) => workspace.tenantId)
      .map((workspace) => [workspace.tenantId!, workspace])
  );
  for (const tenant of tenants) {
    const workspace = claimed.get(tenant.id);
    if (workspace) await setWorkspaceTenant(workspace.id, tenant);
  }

  const unmatched = tenants.filter((tenant) => !claimed.has(tenant.id));
  const unclaimed = local.find((workspace) => !workspace.tenantId) ?? null;
  const adopting = unclaimed ? await tenantToAdopt(server, unclaimed, tenants, unmatched) : null;
  if (unclaimed && adopting) await setWorkspaceTenant(unclaimed.id, adopting);

  for (const tenant of unmatched) {
    if (tenant.id === adopting?.id) continue;
    await createTenantWorkspace(serverId, tenant);
  }

  if (!unclaimed || adopting) return;

  // Reached when every membership is held by another row and this one is left
  // over. Empty, it is a placeholder the reconcile has overtaken and dropping
  // it is the whole repair; holding agents, it is the only record of where they
  // live and is kept, unmatched, so the next call scoped to it is refused and
  // says why rather than answering as some other workspace.
  if (await workspaceHasAgents(unclaimed.id)) {
    log.warn(
      'workspaces: cannot tell which workspace this server’s existing agents belong to; leaving it unmatched, and calls scoped to it will be refused',
      { server: serverId, workspace: unclaimed.id, memberships: tenants.length }
    );
    return;
  }
  await discardEmptyWorkspace(unclaimed.id);
}

/**
 * Reconcile every server this install holds a session for.
 *
 * Run at boot and left unawaited: a workspace list that is one launch stale is
 * cosmetic, and a server that is slow or down must not hold up the window. A
 * managed server whose stack is not running is skipped rather than probed —
 * its gateway port is not listening, so the attempt only produces a network
 * error in the log (CHOO-1657).
 */
export async function reconcileAllWorkspaces(): Promise<void> {
  for (const server of await listServers()) {
    // The cookie read is inside the guard with everything else: it opens the
    // keychain, and a machine that refuses to unlock it would otherwise take
    // the whole sweep down on the first server and skip the rest in silence.
    try {
      if (server.managed && !isManagedServerRunning(server)) continue;
      if (!(await getSessionCookie(server.id))) continue;
      await reconcileServerWorkspaces(server.id);
    } catch (error: unknown) {
      log.warn('workspaces: could not reconcile a server’s workspaces', {
        server: server.id,
        error: String(error),
      });
    }
  }
}

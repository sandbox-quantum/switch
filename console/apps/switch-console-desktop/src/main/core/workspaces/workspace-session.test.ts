/**
 * The seam every tenant-owned gateway call goes through.
 *
 * What it has to get right is not visible in any one call: a Switch session
 * selects one tenant at a time, so the guarantee is about what happens when
 * calls for two workspaces on the same server overlap. If a switch can land
 * between another call reading the cookie and sending it, that call quietly
 * answers with the wrong workspace's data and nothing anywhere reports an
 * error. These tests drive that overlap deliberately, since it is not a state
 * the app reaches on demand.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const decodeJwtTenantId = vi.hoisted(() => vi.fn<(jwt: string) => string | null>());
const switchTenant = vi.hoisted(() =>
  vi.fn<(server: unknown, tenantId: string) => Promise<void>>()
);
const getSessionCookie = vi.hoisted(() => vi.fn<(serverId: string) => Promise<string | null>>());
const requireWorkspace = vi.hoisted(() => vi.fn());
const listWorkspacesForServer = vi.hoisted(() => vi.fn());
const hostUnreachable = vi.hoisted(() => vi.fn((): unknown => null));

vi.mock('@main/core/switch-servers/gateway-client', () => ({ decodeJwtTenantId, switchTenant }));
vi.mock('@main/core/switch-servers/servers-store', () => ({ getSessionCookie }));
vi.mock('@main/core/switch-servers/require-server', () => ({
  hostUnreachable,
  requireServer: async (serverId: string) => ({ id: serverId, name: serverId }),
}));
vi.mock('./workspaces-store', () => ({ requireWorkspace, listWorkspacesForServer }));

import { assertedTenant } from './asserted-tenant';
import {
  forgetServerSession,
  withReachableWorkspaceSession,
  withWorkspaceSession,
} from './workspace-session';

const SERVER = 'srv-1';

/**
 * The tenant the server's session currently selects, as the cookie would carry
 * it.
 *
 * Modelled rather than stubbed away: the seam decides whether to switch by
 * reading the cookie back, so a `switchTenant` that left it unchanged would
 * make every call look like a switch and hide the very interleaving these tests
 * are about.
 */
let selected: string | null = null;

/** The rows the seam resolves, keyed by workspace id. */
const rows = new Map<string, { id: string; serverId: string; tenantId: string | null }>();

function workspace(id: string, tenantId: string | null) {
  const row = { id, serverId: SERVER, tenantId };
  rows.set(id, row);
  return row;
}

/** A promise plus the handles to settle it, so a call can be held mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Let everything that can proceed proceed, so "still pending" means blocked
 * rather than merely not got to yet. A macrotask boundary, since the admission
 * queue is several promise hops deep.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  rows.clear();
  forgetServerSession(SERVER);
  // A session that has selected nothing, as it is straight after signing in.
  selected = null;
  switchTenant.mockReset().mockImplementation(async (_server: unknown, tenantId: string) => {
    selected = tenantId;
  });
  hostUnreachable.mockReset().mockReturnValue(null);
  getSessionCookie.mockReset().mockImplementation(async () => `cookie:${selected ?? 'none'}`);
  decodeJwtTenantId.mockReset().mockImplementation((jwt: string) => {
    const tenant = jwt.slice('cookie:'.length);
    return tenant === 'none' ? null : tenant;
  });
  requireWorkspace.mockReset().mockImplementation(async (id: string) => {
    const row = rows.get(id);
    if (!row) throw new Error(`no workspace ${id}`);
    return row;
  });
  listWorkspacesForServer.mockReset().mockImplementation(async () => [...rows.values()]);
});

describe('withWorkspaceSession', () => {
  it('selects the workspace’s tenant before the call goes out', async () => {
    workspace('ws-a', 'tenant-a');
    const order: string[] = [];
    switchTenant.mockImplementation(async () => void order.push('switch'));

    await withWorkspaceSession('ws-a', async (server) => {
      order.push(`call:${server.id}`);
    });

    expect(order).toEqual(['switch', `call:${SERVER}`]);
    expect(switchTenant).toHaveBeenCalledWith(expect.objectContaining({ id: SERVER }), 'tenant-a');
  });

  it('does not switch when the session already selects that tenant', async () => {
    workspace('ws-a', 'tenant-a');
    selected = 'tenant-a';

    await withWorkspaceSession('ws-a', async () => {});

    expect(switchTenant).not.toHaveBeenCalled();
  });

  /**
   * The row a server is registered with, before any gateway has been asked.
   * There is no id to select and nothing to confuse it with, so the call goes
   * out as it did before workspaces existed.
   */
  it('asks a tenant-less workspace’s server without selecting anything', async () => {
    workspace('ws-only', null);

    await withWorkspaceSession('ws-only', async () => {});

    expect(switchTenant).not.toHaveBeenCalled();
  });

  it('runs calls on the same tenant at the same time', async () => {
    workspace('ws-a', 'tenant-a');
    const first = deferred<void>();
    const inFlight: string[] = [];

    const a = withWorkspaceSession('ws-a', async () => {
      inFlight.push('a');
      await first.promise;
    });
    const b = withWorkspaceSession('ws-a', async () => void inFlight.push('b'));
    await settle();

    // Serialising here would be a correctness-free cost: they name one tenant,
    // so there is no switch between them to be straddled.
    expect(inFlight).toEqual(['a', 'b']);
    expect(switchTenant).toHaveBeenCalledTimes(1);

    first.resolve();
    await Promise.all([a, b]);
  });

  /**
   * The whole point of the lease. `switchTenant` replaces the selection for
   * every call on that server at once, so letting it run while another
   * workspace's call is outstanding would answer that call from the new tenant
   * — the exact silent wrong answer the seam exists to make impossible.
   */
  it('holds a switch back until the calls it would disturb are done', async () => {
    workspace('ws-a', 'tenant-a');
    workspace('ws-b', 'tenant-b');
    const holding = deferred<void>();
    const ranB = vi.fn();

    const a = withWorkspaceSession('ws-a', async () => {
      await holding.promise;
    });
    await settle();
    const b = withWorkspaceSession('ws-b', ranB);
    await settle();

    expect(switchTenant).toHaveBeenCalledTimes(1);
    expect(ranB).not.toHaveBeenCalled();

    holding.resolve();
    await a;
    await b;

    expect(switchTenant).toHaveBeenNthCalledWith(2, expect.anything(), 'tenant-b');
    expect(ranB).toHaveBeenCalled();
  });

  it('gives the lease up when the call throws, so the next switch is not stuck', async () => {
    workspace('ws-a', 'tenant-a');
    workspace('ws-b', 'tenant-b');

    await expect(
      withWorkspaceSession('ws-a', async () => {
        throw new Error('the gateway said no');
      })
    ).rejects.toThrow('the gateway said no');

    await withWorkspaceSession('ws-b', async () => {});

    expect(switchTenant).toHaveBeenNthCalledWith(2, expect.anything(), 'tenant-b');
  });

  /**
   * Read by anything that replaces the cookie underneath a call in flight: a
   * cookie minted by a fresh login selects no tenant, and handing it back
   * unchanged would finish the lease against the account's default workspace.
   */
  it('publishes the tenant the calls in flight are relying on, and forgets it after', async () => {
    workspace('ws-a', 'tenant-a');
    const holding = deferred<void>();

    const call = withWorkspaceSession('ws-a', async () => {
      await holding.promise;
    });
    await settle();

    expect(assertedTenant(SERVER)).toBe('tenant-a');

    holding.resolve();
    await call;

    expect(assertedTenant(SERVER)).toBeNull();
  });

  it('wakes a switch queued behind a server that has been removed', async () => {
    workspace('ws-a', 'tenant-a');
    workspace('ws-b', 'tenant-b');
    const holding = deferred<void>();

    const a = withWorkspaceSession('ws-a', async () => {
      await holding.promise;
    });
    await settle();
    const b = withWorkspaceSession('ws-b', async () => {});
    await settle();

    // The lease is never given up: the call belongs to a server that is gone.
    forgetServerSession(SERVER);
    await expect(b).resolves.toBeUndefined();

    holding.resolve();
    await a;
  });
});

describe('withReachableWorkspaceSession', () => {
  it('refuses before touching the session when the managed host is down', async () => {
    workspace('ws-a', 'tenant-a');
    hostUnreachable.mockReturnValue(new Error('build-box is not reachable'));
    const ran = vi.fn();

    await expect(withReachableWorkspaceSession('ws-a', ran)).rejects.toThrow('not reachable');

    // No switch means no side effect to undo, and the next call to a reachable
    // server does not find the session selecting a tenant nobody asked for.
    expect(switchTenant).not.toHaveBeenCalled();
    expect(ran).not.toHaveBeenCalled();
    expect(assertedTenant(SERVER)).toBeNull();
  });

  it('selects the tenant and runs while the host is up', async () => {
    workspace('ws-a', 'tenant-a');

    await expect(withReachableWorkspaceSession('ws-a', async () => 'answered')).resolves.toBe(
      'answered'
    );
    expect(switchTenant).toHaveBeenCalledWith(expect.anything(), 'tenant-a');
  });
});

import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { agents, locations, switchServers } from '@main/db/schema';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

const fetchTenants = vi.hoisted(() => vi.fn());
const decodeJwtTenantId = vi.hoisted(() => vi.fn((_jwt: string): string | null => null));
const getSessionCookie = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null));
const listServers = vi.hoisted(() => vi.fn(async (): Promise<{ id: string }[]> => []));
const warn = vi.hoisted(() => vi.fn());

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/core/managed-switch-server/managed-server-status', () => ({
  isManagedServerRunning: () => true,
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({ decodeJwtTenantId, fetchTenants }));
vi.mock('@main/core/switch-servers/require-server', () => ({
  requireServer: async (id: string) => ({ id, name: id }),
}));
vi.mock('@main/lib/logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: () => logger };
  return { log: logger };
});

// Mocked whole rather than in part: the module builds the encrypted secrets
// store at import, which a test has no key for.
vi.mock('@main/core/switch-servers/servers-store', () => ({ getSessionCookie, listServers }));

const { reconcileAllWorkspaces, reconcileServerWorkspaces } =
  await import('./reconcile-workspaces');
const { createTenantWorkspace, ensureServerWorkspace, listWorkspacesForServer } =
  await import('./workspaces-store');

function tenant(id: string, name: string, role = 'member') {
  return { id, slug: id, name, role };
}

describe('reconcile-workspaces', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    decodeJwtTenantId.mockReturnValue(null);
    getSessionCookie.mockResolvedValue(null);
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.pragma('foreign_keys = ON');
    await fixture.db.insert(switchServers).values({
      id: 'srv-1',
      name: 'Local dev',
      gatewayUrl: 'https://srv-1.example.com',
      apiUrl: 'https://api-srv-1.example.com',
    });
    listServers.mockResolvedValue([{ id: 'srv-1' }]);
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  /** An agent in a workspace, which is the one thing that makes it unguessable. */
  async function attachAgent(workspaceId: string): Promise<void> {
    await fixture.db
      .insert(locations)
      .values({ id: 'loc-1', name: 'repo', dir: '/repo' })
      .onConflictDoNothing();
    await fixture.db.insert(agents).values({
      id: `agent-${workspaceId}`,
      locationId: 'loc-1',
      name: 'a',
      providerId: 'claude',
      workspaceId,
    });
  }

  /**
   * The case every install upgrading into tenancy is in: one workspace carrying
   * every agent, and one membership it turns out to be.
   */
  it('claims the server’s existing workspace for its sole membership', async () => {
    const before = await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });
    fetchTenants.mockResolvedValue([tenant('t-1', 'Default', 'owner')]);

    await reconcileServerWorkspaces('srv-1');

    const found = await listWorkspacesForServer('srv-1');
    expect(found).toHaveLength(1);
    // Same row: the agents, the active selection and the saved navigation all
    // name this id, and a replacement would detach every one of them.
    expect(found[0]!.id).toBe(before.id);
    expect(found[0]!.tenantId).toBe('t-1');
    expect(found[0]!.role).toBe('owner');
  });

  // Every gateway's first workspace is called "Default", so taking the remote
  // name would rename the only workspace of every install to that.
  it('keeps the name the user already sees rather than the gateway’s', async () => {
    await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });
    fetchTenants.mockResolvedValue([tenant('t-1', 'Default')]);

    await reconcileServerWorkspaces('srv-1');

    expect((await listWorkspacesForServer('srv-1'))[0]!.name).toBe('Local dev');
  });

  it('adds a workspace for a membership this install has no row for', async () => {
    await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });
    getSessionCookie.mockResolvedValue('cookie');
    decodeJwtTenantId.mockReturnValue('t-1');
    fetchTenants.mockResolvedValue([tenant('t-1', 'Default'), tenant('t-2', 'Research')]);

    await reconcileServerWorkspaces('srv-1');

    const found = await listWorkspacesForServer('srv-1');
    expect(found).toHaveLength(2);
    expect(found.find((w) => w.tenantId === 't-1')!.name).toBe('Local dev');
    // Nothing local ever named this one, so it is the gateway's to name.
    expect(found.find((w) => w.tenantId === 't-2')!.name).toBe('Research');
  });

  /**
   * What every multi-membership sign-in used to produce: the gateway refuses a
   * scoped call from a session with several memberships and no selection, so
   * this server has never answered one and its row holds nothing. Left behind
   * while a row was added per membership, it appeared in the switcher as a
   * workspace belonging to no membership at all.
   */
  it('gives the registration row a membership rather than leaving it belonging to none', async () => {
    const before = await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });
    fetchTenants.mockResolvedValue([tenant('t-1', 'Default'), tenant('t-2', 'Research')]);

    await reconcileServerWorkspaces('srv-1');

    const found = await listWorkspacesForServer('srv-1');
    expect(found).toHaveLength(2);
    expect(found.every((w) => w.tenantId !== null)).toBe(true);
    // The same row, so the active selection and the saved navigation still name
    // something that exists.
    expect(found.some((w) => w.id === before.id)).toBe(true);
    expect(found.some((w) => w.tenantId === 't-1')).toBe(true);
    expect(found.some((w) => w.tenantId === 't-2')).toBe(true);
  });

  /**
   * The one case that cannot be answered: agents were registered through this
   * row, so it stands for wherever they live, and naming it the wrong
   * membership would move them somewhere the user cannot see.
   */
  it('refuses to guess which membership a workspace with agents holds', async () => {
    const before = await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });
    await attachAgent(before.id);
    fetchTenants.mockResolvedValue([tenant('t-1', 'Default'), tenant('t-2', 'Research')]);

    await reconcileServerWorkspaces('srv-1');

    const found = await listWorkspacesForServer('srv-1');
    expect(found.find((w) => w.id === before.id)!.tenantId).toBeNull();
    // Both memberships are still recorded — only the question of which one the
    // existing row holds is left open.
    expect(found).toHaveLength(3);
    expect(found.some((w) => w.tenantId === 't-1')).toBe(true);
    expect(found.some((w) => w.tenantId === 't-2')).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  /**
   * The repair the short-circuit used to make impossible: once every membership
   * has a row, the leftover registration row could never be revisited, and no
   * later boot or sign-in could clear it.
   */
  it('drops an empty registration row left over once every membership has one', async () => {
    const before = await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });
    await createTenantWorkspace('srv-1', {
      id: 't-1',
      slug: 't-1',
      name: 'Default',
      role: 'owner',
    });
    await createTenantWorkspace('srv-1', {
      id: 't-2',
      slug: 't-2',
      name: 'Research',
      role: 'member',
    });
    fetchTenants.mockResolvedValue([tenant('t-1', 'Default'), tenant('t-2', 'Research')]);

    await reconcileServerWorkspaces('srv-1');

    const found = await listWorkspacesForServer('srv-1');
    expect(found).toHaveLength(2);
    expect(found.some((w) => w.id === before.id)).toBe(false);
  });

  /**
   * The boot sweep is not awaited, so a sign-in lands in the middle of it. Read
   * together, both passes see a membership with no row and both create one; the
   * unique index then turns the loser into an error that abandons the rest of
   * its pass, leaving the tenants it had not reached yet unmatched.
   */
  it('runs two passes on one server one after the other', async () => {
    await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });
    getSessionCookie.mockResolvedValue('cookie');
    decodeJwtTenantId.mockReturnValue('t-1');
    fetchTenants.mockResolvedValue([
      tenant('t-1', 'Default'),
      tenant('t-2', 'Research'),
      tenant('t-3', 'Ops'),
    ]);

    await Promise.all([reconcileServerWorkspaces('srv-1'), reconcileServerWorkspaces('srv-1')]);

    const found = await listWorkspacesForServer('srv-1');
    expect(found).toHaveLength(3);
    expect(found.map((w) => w.tenantId).toSorted((a, b) => a!.localeCompare(b!))).toEqual([
      't-1',
      't-2',
      't-3',
    ]);
  });

  it('carries a role change on a workspace it already matched', async () => {
    const existing = await createTenantWorkspace('srv-1', {
      id: 't-1',
      slug: 't-1',
      name: 'Research',
      role: 'member',
    });
    fetchTenants.mockResolvedValue([tenant('t-1', 'Research', 'admin')]);

    await reconcileServerWorkspaces('srv-1');

    const found = await listWorkspacesForServer('srv-1');
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(existing.id);
    expect(found[0]!.role).toBe('admin');
  });

  /**
   * Deleting it would silently detach that workspace's agents. Kept, so the
   * next call scoped to it fails and says why — and said out loud now.
   */
  it('keeps a workspace whose membership has been withdrawn, and says so', async () => {
    await createTenantWorkspace('srv-1', {
      id: 't-gone',
      slug: 't-gone',
      name: 'Research',
      role: 'member',
    });
    fetchTenants.mockResolvedValue([tenant('t-1', 'Default')]);

    await reconcileServerWorkspaces('srv-1');

    const found = await listWorkspacesForServer('srv-1');
    expect(found.some((w) => w.tenantId === 't-gone')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no longer a member'), {
      server: 'srv-1',
      workspace: expect.any(String),
    });
  });

  // An account in no workspace at all is a server the user cannot use; saying
  // nothing and deleting the local row would look like it had never been set up.
  it('leaves the rows alone when the gateway reports no membership', async () => {
    const before = await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });
    fetchTenants.mockResolvedValue([]);

    await reconcileServerWorkspaces('srv-1');

    const found = await listWorkspacesForServer('srv-1');
    expect(found).toEqual([before]);
    expect(warn).toHaveBeenCalled();
  });

  it('is idempotent across launches', async () => {
    const before = await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });
    fetchTenants.mockResolvedValue([tenant('t-1', 'Default')]);

    await reconcileServerWorkspaces('srv-1');
    await reconcileServerWorkspaces('srv-1');

    const found = await listWorkspacesForServer('srv-1');
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(before.id);
  });

  describe('the boot sweep', () => {
    // Asking costs a round trip that can only be refused, and the answer would
    // be thrown away.
    it('skips a server this install is not signed in to', async () => {
      await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });

      await reconcileAllWorkspaces();

      expect(fetchTenants).not.toHaveBeenCalled();
    });

    // One server being down must not stop the rest from being reconciled.
    it('carries on past a server that cannot be reached', async () => {
      await fixture.db.insert(switchServers).values({
        id: 'srv-2',
        name: 'Staging',
        gatewayUrl: 'https://srv-2.example.com',
        apiUrl: 'https://api-srv-2.example.com',
      });
      await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });
      await ensureServerWorkspace({ id: 'srv-2', name: 'Staging' });
      listServers.mockResolvedValue([{ id: 'srv-1' }, { id: 'srv-2' }]);
      getSessionCookie.mockResolvedValue('cookie');
      fetchTenants
        .mockRejectedValueOnce(new Error('no route to host'))
        .mockResolvedValue([tenant('t-2', 'Default')]);

      await reconcileAllWorkspaces();

      expect((await listWorkspacesForServer('srv-1'))[0]!.tenantId).toBeNull();
      expect((await listWorkspacesForServer('srv-2'))[0]!.tenantId).toBe('t-2');
      expect(warn).toHaveBeenCalled();
    });
  });
});

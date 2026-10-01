import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { kv, switchServers, workspaces } from '@main/db/schema';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

const {
  clearActiveWorkspaceOnServer,
  ensureServerWorkspace,
  getActiveWorkspaceId,
  listWorkspacesForServer,
  renameServerWorkspaces,
  requireWorkspaceForServer,
  requireWorkspace,
  serverIdForWorkspace,
  setActiveWorkspaceId,
} = await import('./workspaces-store');

describe('workspaces-store', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  async function seedServer(id: string, name: string): Promise<void> {
    await fixture.db.insert(switchServers).values({
      id,
      name,
      gatewayUrl: `https://${id}.example.com`,
      apiUrl: `https://api-${id}.example.com`,
    });
  }

  describe('ensureServerWorkspace', () => {
    it('gives a newly registered server one workspace, named after it', async () => {
      await seedServer('srv-1', 'Local dev');

      const workspace = await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });

      expect(workspace.serverId).toBe('srv-1');
      expect(workspace.name).toBe('Local dev');
      expect(workspace.tenantId).toBeNull();
      expect(workspace.slug).toBeNull();
      expect(workspace.role).toBeNull();
    });

    // The managed-server paths run again on every restart of a stack that
    // already exists, and a second workspace would silently split its agents.
    it('returns the existing workspace instead of adding a second', async () => {
      await seedServer('srv-1', 'Local dev');
      const first = await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });

      const again = await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });

      expect(again.id).toBe(first.id);
      expect(await listWorkspacesForServer('srv-1')).toHaveLength(1);
    });

    /**
     * The table's other unique index is on (server_id, tenant_id), and SQLite
     * treats NULLs as distinct, so it lets a second tenant-less row through.
     * Reconcile repairs the one unmatched row it finds; a second would be left
     * behind belonging to no membership, and every call scoped to it refused.
     */
    it('refuses a second tenant-less workspace on the same server', async () => {
      await seedServer('srv-1', 'Local dev');
      await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });

      await expect(
        fixture.db.insert(workspaces).values({ id: 'ws-2', serverId: 'srv-1', name: 'Local dev' })
      ).rejects.toThrow(/UNIQUE/);
    });
  });

  describe('requireWorkspaceForServer', () => {
    it('returns the one workspace a server has', async () => {
      await seedServer('srv-1', 'Local dev');
      const created = await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });

      expect((await requireWorkspaceForServer('srv-1')).id).toBe(created.id);
    });

    it('raises for a server whose registration left it with none', async () => {
      await seedServer('srv-1', 'Local dev');

      await expect(requireWorkspaceForServer('srv-1')).rejects.toThrow('has no workspace');
    });

    // These callers run from screens showing the active workspace, so acting
    // anywhere else would act somewhere the user is not looking.
    it('takes the active one when a server has several', async () => {
      await seedServer('srv-1', 'Cloud');
      await fixture.db.insert(workspaces).values([
        { id: 'ws-a', serverId: 'srv-1', name: 'A', tenantId: 'tenant-a' },
        { id: 'ws-b', serverId: 'srv-1', name: 'B', tenantId: 'tenant-b' },
      ]);
      await setActiveWorkspaceId('ws-b');

      expect((await requireWorkspaceForServer('srv-1')).id).toBe('ws-b');
    });

    // Picking one would attach the agent to a workspace the user never chose,
    // and nothing would show them until it had already happened.
    it('raises when a server has several and the active one is elsewhere', async () => {
      await seedServer('srv-1', 'Cloud');
      await seedServer('srv-2', 'Local dev');
      await fixture.db.insert(workspaces).values([
        { id: 'ws-a', serverId: 'srv-1', name: 'A', tenantId: 'tenant-a' },
        { id: 'ws-b', serverId: 'srv-1', name: 'B', tenantId: 'tenant-b' },
        { id: 'ws-c', serverId: 'srv-2', name: 'C', tenantId: 'tenant-c' },
      ]);
      await setActiveWorkspaceId('ws-c');

      await expect(requireWorkspaceForServer('srv-1')).rejects.toThrow('must name one');
    });
  });

  describe('renameServerWorkspaces', () => {
    it('carries the new server name onto the workspace that took its name from it', async () => {
      await seedServer('srv-1', 'Old name');
      await ensureServerWorkspace({ id: 'srv-1', name: 'Old name' });

      await renameServerWorkspaces('srv-1', 'New name');

      expect((await listWorkspacesForServer('srv-1'))[0]!.name).toBe('New name');
    });

    // Once matched to a tenant the name is the gateway's, not the server's.
    it('leaves a tenant-bound workspace’s own name alone', async () => {
      await seedServer('srv-1', 'Old name');
      await fixture.db
        .insert(workspaces)
        .values({ id: 'ws-a', serverId: 'srv-1', name: 'Platform', tenantId: 'tenant-a' });

      await renameServerWorkspaces('srv-1', 'New name');

      expect((await listWorkspacesForServer('srv-1'))[0]!.name).toBe('Platform');
    });
  });

  describe('serverIdForWorkspace', () => {
    it('finds the server hosting a workspace', async () => {
      await seedServer('srv-1', 'Local dev');
      const created = await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });

      expect(await serverIdForWorkspace(created.id)).toBe('srv-1');
    });

    it('answers null for an agent with no workspace', async () => {
      expect(await serverIdForWorkspace(null)).toBeNull();
    });
  });

  describe('the active selection', () => {
    it('round-trips a workspace id', async () => {
      await seedServer('srv-1', 'Local dev');
      const created = await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });

      await setActiveWorkspaceId(created.id);

      expect(await getActiveWorkspaceId()).toBe(created.id);
    });

    it('refuses to select a workspace that does not exist', async () => {
      await expect(setActiveWorkspaceId('ws-missing')).rejects.toThrow('No workspace with id');
    });

    // The selection is a plain kv value; nothing cascades to it when the
    // server, and with it the workspace, is deleted.
    it('is cleared when the server holding the selected workspace goes', async () => {
      await seedServer('srv-1', 'Local dev');
      const created = await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });
      await setActiveWorkspaceId(created.id);

      await clearActiveWorkspaceOnServer('srv-1');

      expect(await getActiveWorkspaceId()).toBeNull();
      expect(await fixture.db.select().from(kv).where(eq(kv.key, 'activeWorkspaceId'))).toEqual([]);
    });

    it('survives another server being removed', async () => {
      await seedServer('srv-1', 'Local dev');
      await seedServer('srv-2', 'Cloud');
      const created = await ensureServerWorkspace({ id: 'srv-1', name: 'Local dev' });
      await ensureServerWorkspace({ id: 'srv-2', name: 'Cloud' });
      await setActiveWorkspaceId(created.id);

      await clearActiveWorkspaceOnServer('srv-2');

      expect(await getActiveWorkspaceId()).toBe(created.id);
    });
  });

  describe('requireWorkspace', () => {
    it('names the id it could not find', async () => {
      await expect(requireWorkspace('ws-missing')).rejects.toThrow(
        'No workspace with id ws-missing'
      );
    });
  });
});

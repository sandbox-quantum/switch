import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { agents, kv, locations, switchServers, workspaces } from '@main/db/schema';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

// removeServer deletes the encrypted session cookie; the servers-store module
// also constructs the encrypted-secrets singleton at import (which touches the
// real db). Stub it so these tests stay on the DB-row path.
const secretMocks = vi.hoisted(() => ({
  deleteSecret: vi.fn(),
}));
vi.mock('@main/core/secrets/encrypted-app-secrets-store', () => ({
  encryptedAppSecretsStore: {
    getSecret: vi.fn(),
    setSecret: vi.fn(),
    deleteSecret: secretMocks.deleteSecret,
  },
}));

const telemetryMocks = vi.hoisted(() => ({
  trackEvent: vi.fn(),
}));
vi.mock('@main/core/telemetry/telemetry-service', () => ({
  trackEvent: telemetryMocks.trackEvent,
}));

// Imported after the mocks so the module binds to the mocked db + secrets store.
const {
  addServer,
  assertManagedServerUrlFree,
  clearDashboardUrl,
  DuplicateServerUrlError,
  ensureManagedServer,
  findServerByUrl,
  findServerByWebAddress,
  getServer,
  removeServer,
  renameServer,
  setActiveServerId,
  updateServer,
} = await import('./servers-store');
const { getActiveWorkspaceId } = await import('@main/core/workspaces/workspaces-store');

describe('servers-store: rename & delete', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.pragma('foreign_keys = OFF');
    secretMocks.deleteSecret.mockReset();
    telemetryMocks.trackEvent.mockReset();
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  describe('renameServer', () => {
    it('updates only the name, leaving addresses and managed metadata untouched', async () => {
      await fixture.db.insert(switchServers).values({
        id: 'remote-1',
        name: 'Old name',
        url: 'https://switch.example.com',
        dashboardUrl: 'https://switch-dashboard.example.com',
        managed: true,
        managementKind: 'remote',
        sshHost: 'host-a',
      });

      const renamed = await renameServer({ id: 'remote-1', name: '  New name  ' });

      expect(renamed.name).toBe('New name');
      expect(renamed.url).toBe('https://switch.example.com');
      expect(renamed.dashboardUrl).toBe('https://switch-dashboard.example.com');
      expect(renamed.managed).toBe(true);
      expect(renamed.managementKind).toBe('remote');
      expect(renamed.sshHost).toBe('host-a');
    });

    it('throws for an unknown server id', async () => {
      await expect(renameServer({ id: 'nope', name: 'x' })).rejects.toThrow('No Switch server');
    });
  });

  describe('ensureManagedServer name preservation', () => {
    it('keeps a renamed managed server name across a restart (only addresses refresh)', async () => {
      // First start: registers the local managed row under the default name.
      const created = await ensureManagedServer(
        {
          name: 'Local Switch server',
          url: 'http://localhost:8080',
          dashboardUrl: 'http://localhost:8081',
        },
        { kind: 'local' }
      );
      // User renames it.
      await renameServer({ id: created.id, name: 'My box' });

      // Restart repicks ports (new addresses) and passes the hardcoded default name.
      const restarted = await ensureManagedServer(
        {
          name: 'Local Switch server',
          url: 'http://localhost:9090',
          dashboardUrl: 'http://localhost:9091',
        },
        { kind: 'local' }
      );

      expect(restarted.id).toBe(created.id);
      // The rename survives; the addresses still refresh to the new ports.
      expect(restarted.name).toBe('My box');
      expect(restarted.url).toBe('http://localhost:9090');
      expect(restarted.dashboardUrl).toBe('http://localhost:9091');
    });
  });

  describe('ensureManagedServer URL clashes', () => {
    async function insertServer(values: Partial<typeof switchServers.$inferInsert>) {
      await fixture.db.insert(switchServers).values({
        id: 'x',
        name: 'x',
        url: 'http://localhost:1',
        ...values,
      });
    }

    it('never takes over another managed server’s row by URL', async () => {
      await insertServer({
        id: 'local-1',
        name: 'My local server',
        url: 'http://localhost:41000',
        dashboardUrl: 'http://localhost:41001',
        managed: true,
        managementKind: 'local',
      });

      await expect(
        ensureManagedServer(
          {
            name: 'Team server',
            url: 'http://localhost:41000',
            dashboardUrl: 'http://localhost:41001',
          },
          { kind: 'remote', sshHost: 'vm-1' }
        )
      ).rejects.toThrow(
        /http:\/\/localhost:41000 is already the address of “My local server” \(the server Switch Console runs on this computer\).*on vm-1/
      );
      const [local] = await fixture.db
        .select()
        .from(switchServers)
        .where(eq(switchServers.id, 'local-1'));
      expect(local).toMatchObject({ managementKind: 'local', sshHost: null });
    });

    it('says a start would clash before it runs, writing nothing', async () => {
      await insertServer({
        id: 'local-1',
        name: 'My local server',
        url: 'http://localhost:41000',
        dashboardUrl: 'http://localhost:41001',
        managed: true,
        managementKind: 'local',
      });

      await expect(
        assertManagedServerUrlFree('http://localhost:41000/', { kind: 'remote', sshHost: 'vm-1' })
      ).rejects.toThrow(/already the address of “My local server”/);
      await expect(
        assertManagedServerUrlFree('http://localhost:42000', { kind: 'remote', sshHost: 'vm-1' })
      ).resolves.toBeUndefined();
      expect(await fixture.db.select().from(switchServers)).toHaveLength(1);
    });

    it('never gives the local server a remote server’s row by URL either', async () => {
      await insertServer({
        id: 'remote-1',
        name: 'Team server',
        url: 'http://localhost:41000',
        managed: true,
        managementKind: 'remote',
        sshHost: 'vm-1',
      });

      await expect(
        ensureManagedServer(
          { name: 'Local', url: 'http://localhost:41000', dashboardUrl: 'http://localhost:41001' },
          { kind: 'local' }
        )
      ).rejects.toThrow(/on this computer/);
    });

    it('never takes over the row of a server on another host', async () => {
      await insertServer({
        id: 'remote-2',
        name: 'Other VM',
        url: 'http://localhost:41000',
        managed: true,
        managementKind: 'remote',
        sshHost: 'vm-2',
      });

      await expect(
        ensureManagedServer(
          { name: 'Team', url: 'http://localhost:41000', dashboardUrl: 'http://localhost:41001' },
          { kind: 'remote', sshHost: 'vm-1' }
        )
      ).rejects.toThrow(/runs on vm-2/);
    });

    it('still adopts a server someone registered by hand at the same address', async () => {
      await insertServer({
        id: 'external-1',
        name: 'Tunnel to the VM',
        url: 'http://localhost:41000',
        dashboardUrl: 'http://localhost:41001',
      });

      const adopted = await ensureManagedServer(
        { name: 'Team', url: 'http://localhost:41000', dashboardUrl: 'http://localhost:41001' },
        { kind: 'remote', sshHost: 'vm-1' }
      );

      expect(adopted).toMatchObject({
        id: 'external-1',
        managed: true,
        managementKind: 'remote',
        sshHost: 'vm-1',
      });
    });

    it('refuses to move a server onto an address another record holds, in words', async () => {
      await insertServer({
        id: 'remote-1',
        name: 'Team',
        url: 'http://localhost:3300',
        dashboardUrl: 'http://localhost:8000',
        managed: true,
        managementKind: 'remote',
        sshHost: 'vm-1',
      });
      await insertServer({
        id: 'external-1',
        name: 'Company server',
        url: 'http://localhost:41000',
        dashboardUrl: 'http://localhost:41001',
      });

      await expect(
        ensureManagedServer(
          { name: 'Team', url: 'http://localhost:41000', dashboardUrl: 'http://localhost:41001' },
          { kind: 'remote', sshHost: 'vm-1' }
        )
      ).rejects.toThrow(/already the address of “Company server”/);
    });

    it('follows a server to new ports when nothing else holds them', async () => {
      await insertServer({
        id: 'remote-1',
        name: 'Team',
        url: 'http://localhost:3300',
        dashboardUrl: 'http://localhost:8000',
        managed: true,
        managementKind: 'remote',
        sshHost: 'vm-1',
      });

      const moved = await ensureManagedServer(
        { name: 'ignored', url: 'http://localhost:41000', dashboardUrl: 'http://localhost:41001' },
        { kind: 'remote', sshHost: 'vm-1' }
      );

      expect(moved).toMatchObject({
        id: 'remote-1',
        name: 'Team',
        url: 'http://localhost:41000',
      });
    });
  });

  describe('ensureManagedServer telemetry', () => {
    it('reports a new local managed server once', async () => {
      await ensureManagedServer(
        {
          name: 'Local Switch server',
          url: 'http://localhost:8080',
          dashboardUrl: 'http://localhost:8081',
        },
        { kind: 'local' }
      );

      expect(telemetryMocks.trackEvent).toHaveBeenCalledTimes(1);
      expect(telemetryMocks.trackEvent).toHaveBeenCalledWith('server_added', {
        server_kind: 'local',
        outcome: 'success',
      });
    });

    it('reports a new remote managed server with the remote_managed kind', async () => {
      await ensureManagedServer(
        {
          name: 'Remote Switch server',
          url: 'http://localhost:8080',
          dashboardUrl: 'http://localhost:8081',
        },
        { kind: 'remote', sshHost: 'host-a' }
      );

      expect(telemetryMocks.trackEvent).toHaveBeenCalledTimes(1);
      expect(telemetryMocks.trackEvent).toHaveBeenCalledWith('server_added', {
        server_kind: 'remote_managed',
        outcome: 'success',
      });
    });

    it('reports nothing when a managed server restarts (updates the existing row)', async () => {
      const ref = { kind: 'local' } as const;
      const params = {
        name: 'Local Switch server',
        url: 'http://localhost:8080',
        dashboardUrl: 'http://localhost:8081',
      };
      await ensureManagedServer(params, ref);
      telemetryMocks.trackEvent.mockClear();

      await ensureManagedServer(
        { ...params, url: 'http://localhost:9090', dashboardUrl: 'http://localhost:9091' },
        ref
      );

      expect(telemetryMocks.trackEvent).not.toHaveBeenCalled();
    });
  });

  describe('addServer telemetry', () => {
    it('leaves an externally-hosted server for its one caller to report', async () => {
      // The controller owns both outcomes of that add, so that one press of Add
      // cannot produce a success here and a failure there.
      await addServer({ name: 'External server', url: 'https://switch.example.com' });

      expect(telemetryMocks.trackEvent).not.toHaveBeenCalled();
    });
  });

  describe('removeServer', () => {
    it('reports the kind of server that was removed', async () => {
      await fixture.db.insert(switchServers).values({
        id: 'srv-ext',
        name: 'External',
        url: 'https://switch.example.com',
        dashboardUrl: 'https://switch-dashboard.example.com',
      });

      await removeServer('srv-ext');

      expect(telemetryMocks.trackEvent).toHaveBeenCalledWith('server_removed', {
        server_kind: 'external',
      });
    });

    it('reports a managed server by the kind it was managed as', async () => {
      await fixture.db.insert(switchServers).values({
        id: 'srv-rm',
        name: 'Remote',
        url: 'https://switch2.example.com',
        managed: true,
        managementKind: 'remote',
        sshHost: 'build-box',
      });

      await removeServer('srv-rm');

      expect(telemetryMocks.trackEvent).toHaveBeenCalledWith('server_removed', {
        server_kind: 'remote_managed',
      });
    });

    it('reports nothing for a server that was already gone', async () => {
      // A no-op remove is not a server being removed.
      await removeServer('srv-missing');

      expect(telemetryMocks.trackEvent).not.toHaveBeenCalled();
    });

    it('unlinks the server’s agents (keeps them), deletes the row, and clears the active pointer', async () => {
      // The unlink is two foreign keys deep — the server's workspaces cascade,
      // and their agents are set null — so this one test needs the engine to be
      // enforcing them.
      fixture.sqlite.pragma('foreign_keys = ON');
      await fixture.db
        .insert(locations)
        .values({ id: 'loc-1', name: 'Loc', sshHost: '', dir: '/repo/loc-1' });
      await fixture.db.insert(switchServers).values({
        id: 'srv-1',
        name: 'Server',
        url: 'https://switch.example.com',
        dashboardUrl: 'https://switch-dashboard.example.com',
      });
      await fixture.db.insert(workspaces).values({ id: 'ws-1', serverId: 'srv-1', name: 'Server' });
      await fixture.db.insert(agents).values([
        {
          id: 'agent-1',
          locationId: 'loc-1',
          name: 'A',
          providerId: 'claude',
          workspaceId: 'ws-1',
        },
        {
          id: 'agent-2',
          locationId: 'loc-1',
          name: 'B',
          providerId: 'claude',
          workspaceId: 'ws-1',
        },
      ]);
      await fixture.db.insert(kv).values({ key: 'activeWorkspaceId', value: 'ws-1' });

      await removeServer('srv-1');

      const remainingServers = await fixture.db.select().from(switchServers);
      expect(remainingServers).toHaveLength(0);

      const remainingWorkspaces = await fixture.db.select().from(workspaces);
      expect(remainingWorkspaces).toHaveLength(0);

      const remainingAgents = await fixture.db.select().from(agents);
      expect(remainingAgents).toHaveLength(2);
      expect(remainingAgents.every((a) => a.workspaceId === null)).toBe(true);

      const [activePointer] = await fixture.db
        .select()
        .from(kv)
        .where(eq(kv.key, 'activeWorkspaceId'));
      expect(activePointer).toBeUndefined();

      expect(secretMocks.deleteSecret).toHaveBeenCalledWith('switch-server-cookie:srv-1');
    });
  });
});

describe('selecting a server', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.pragma('foreign_keys = OFF');
    await fixture.db.insert(switchServers).values({
      id: 'srv-1',
      name: 'Local dev',
      url: 'https://srv-1.example.com',
    });
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  async function seedWorkspace(
    id: string,
    tenantId: string | null,
    role: 'owner' | 'member' | null = 'member'
  ): Promise<void> {
    await fixture.db.insert(workspaces).values({ id, serverId: 'srv-1', name: id, tenantId, role });
  }

  it('selects the one workspace a server has', async () => {
    await seedWorkspace('ws-1', 't-1');

    await setActiveServerId('srv-1');

    expect(await getActiveWorkspaceId()).toBe('ws-1');
  });

  /**
   * Refusing would fail the managed stack start this runs inside, taking a
   * healthy server down over a question about which of its workspaces to show.
   */
  it('picks one rather than refusing when the account has several there', async () => {
    await seedWorkspace('ws-1', 't-1');
    await seedWorkspace('ws-2', 't-2');

    await setActiveServerId('srv-1');

    expect(await getActiveWorkspaceId()).toBe('ws-1');
  });

  // Re-selecting the server the user is already in must not move them to
  // another of its workspaces; a managed stack start does exactly that.
  it('leaves the selection alone when it is already on that server', async () => {
    await seedWorkspace('ws-1', 't-1');
    await seedWorkspace('ws-2', 't-2');
    await setActiveServerId('srv-1');
    await fixture.db.update(kv).set({ value: 'ws-2' }).where(eq(kv.key, 'activeWorkspaceId'));

    await setActiveServerId('srv-1');

    const [pointer] = await fixture.db.select().from(kv).where(eq(kv.key, 'activeWorkspaceId'));
    expect(pointer!.value).toBe('ws-2');
  });

  /**
   * The oldest row is the one a withdrawn membership is most likely to be —
   * the server's original workspace, whose membership was the first to be
   * given up. Landing on it would scope the window to something the gateway
   * refuses every call for.
   */
  it('skips a workspace this account is no longer a member of', async () => {
    await seedWorkspace('ws-1', 't-gone', null);
    await seedWorkspace('ws-2', 't-2');

    await setActiveServerId('srv-1');

    expect(await getActiveWorkspaceId()).toBe('ws-2');
  });

  /**
   * The row the server was registered with, before the gateway was asked which
   * workspaces the account has. It names no tenant, so a call scoped to it
   * selects none and the gateway answers with whichever workspace the session
   * last selected — under this one's name. On an upgraded install it is also
   * the oldest row, and holds every agent.
   */
  it('skips a placeholder the reconcile could not match', async () => {
    await seedWorkspace('ws-1', null, null);
    await seedWorkspace('ws-2', 't-2');

    await setActiveServerId('srv-1');

    expect(await getActiveWorkspaceId()).toBe('ws-2');
  });

  // Every server's first workspace starts out like this and is matched to a
  // membership afterwards; on its own there is nothing to confuse it with.
  it('selects a lone workspace that has no tenant yet', async () => {
    await seedWorkspace('ws-1', null, null);

    await setActiveServerId('srv-1');

    expect(await getActiveWorkspaceId()).toBe('ws-1');
  });

  // Nothing else to fall back to, and refusing here takes a healthy managed
  // stack start down; the seam says why on the first call instead.
  it('still picks one when every workspace on the server is withdrawn', async () => {
    await seedWorkspace('ws-1', 't-gone', null);

    await setActiveServerId('srv-1');

    expect(await getActiveWorkspaceId()).toBe('ws-1');
  });

  it('refuses a server with no workspace at all', async () => {
    await expect(setActiveServerId('srv-1')).rejects.toThrow('no workspace');
  });
});

describe('servers-store: one address per server', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.pragma('foreign_keys = OFF');
    telemetryMocks.trackEvent.mockReset();
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  async function insertServer(values: Partial<typeof switchServers.$inferInsert>) {
    await fixture.db.insert(switchServers).values({ id: 'x', name: 'x', url: 'x', ...values });
  }

  describe('addServer', () => {
    it('stores the address without a trailing slash and with no separate dashboard', async () => {
      const added = await addServer({ name: '  Team  ', url: ' https://switch.example.com/ ' });

      expect(added).toMatchObject({
        name: 'Team',
        url: 'https://switch.example.com',
        dashboardUrl: null,
        managed: false,
      });
    });

    it('refuses an address another server already has, naming it', async () => {
      await insertServer({ id: 'a', name: 'Company server', url: 'https://switch.example.com' });

      const adding = addServer({ name: 'Again', url: 'https://switch.example.com/' });

      await expect(adding).rejects.toBeInstanceOf(DuplicateServerUrlError);
      await expect(adding).rejects.toThrow(
        'https://switch.example.com is already the address of “Company server”.'
      );
      expect(await fixture.db.select().from(switchServers)).toHaveLength(1);
    });
  });

  describe('updateServer', () => {
    it('drops a separate dashboard address when the server’s address changes', async () => {
      await insertServer({
        id: 'a',
        name: 'Split',
        url: 'https://switch-api.example.com',
        dashboardUrl: 'https://switch-gateway.example.com',
      });

      const saved = await updateServer({ id: 'a', name: 'Split', url: 'https://new.example.com' });

      expect(saved).toMatchObject({ url: 'https://new.example.com', dashboardUrl: null });
    });

    it('keeps a separate dashboard address when only the name changes', async () => {
      await insertServer({
        id: 'a',
        name: 'Split',
        url: 'https://switch-api.example.com',
        dashboardUrl: 'https://switch-gateway.example.com',
      });

      const saved = await updateServer({
        id: 'a',
        name: 'Renamed',
        url: 'https://switch-api.example.com/',
      });

      expect(saved).toMatchObject({
        name: 'Renamed',
        url: 'https://switch-api.example.com',
        dashboardUrl: 'https://switch-gateway.example.com',
      });
    });

    it('refuses to move a server onto another server’s address', async () => {
      await insertServer({ id: 'a', name: 'First', url: 'https://one.example.com' });
      await insertServer({ id: 'b', name: 'Second', url: 'https://two.example.com' });

      await expect(
        updateServer({ id: 'b', name: 'Second', url: 'https://one.example.com' })
      ).rejects.toThrow('already the address of “First”');
      expect((await getServer('b'))?.url).toBe('https://two.example.com');
    });

    it('throws for an unknown server id', async () => {
      await expect(
        updateServer({ id: 'nope', name: 'x', url: 'https://x.example.com' })
      ).rejects.toThrow('No Switch server with id nope');
    });
  });

  describe('finding a server by address', () => {
    it('finds a server by its address, however the slash is written', async () => {
      await insertServer({ id: 'a', name: 'Team', url: 'https://switch.example.com' });

      expect((await findServerByUrl('https://switch.example.com/'))?.id).toBe('a');
      expect(await findServerByUrl('https://other.example.com')).toBeNull();
    });

    it('finds a server by its own address or by the dashboard address it keeps', async () => {
      await insertServer({
        id: 'split',
        name: 'Split',
        url: 'https://switch-api.example.com',
        dashboardUrl: 'https://switch-gateway.example.com',
      });

      expect((await findServerByWebAddress('https://switch-api.example.com'))?.id).toBe('split');
      expect((await findServerByWebAddress('https://SWITCH-GATEWAY.example.com/'))?.id).toBe(
        'split'
      );
      expect(await findServerByWebAddress('https://elsewhere.example.com')).toBeNull();
      expect(await findServerByWebAddress('not an address')).toBeNull();
    });

    it('prefers a server whose own address it is over one that keeps it for its dashboard', async () => {
      await insertServer({
        id: 'old',
        name: 'Old',
        url: 'https://old-api.example.com',
        dashboardUrl: 'https://switch.example.com',
      });
      await insertServer({ id: 'new', name: 'New', url: 'https://switch.example.com' });

      expect((await findServerByWebAddress('https://switch.example.com'))?.id).toBe('new');
    });
  });

  describe('clearDashboardUrl', () => {
    it('forgets the separate dashboard address of the address that was checked', async () => {
      await insertServer({
        id: 'a',
        url: 'https://switch-api.example.com',
        dashboardUrl: 'https://switch-gateway.example.com',
      });

      await clearDashboardUrl('a', 'https://switch-api.example.com');

      expect((await getServer('a'))?.dashboardUrl).toBeNull();
    });

    it('leaves it alone when the server has moved since the check', async () => {
      await insertServer({
        id: 'a',
        url: 'https://moved.example.com',
        dashboardUrl: 'https://switch-gateway.example.com',
      });

      await clearDashboardUrl('a', 'https://switch-api.example.com');

      expect((await getServer('a'))?.dashboardUrl).toBe('https://switch-gateway.example.com');
    });
  });

  describe('managed servers', () => {
    it('registers a managed stack with its dashboard container’s address', async () => {
      const server = await ensureManagedServer(
        { name: 'Local', url: 'http://localhost:8010/', dashboardUrl: 'http://localhost:3010/' },
        { kind: 'local' }
      );

      expect(server).toMatchObject({
        url: 'http://localhost:8010',
        dashboardUrl: 'http://localhost:3010',
      });
    });

    it('registers one with no dashboard address when its stack has none', async () => {
      const server = await ensureManagedServer(
        { name: 'Local', url: 'http://localhost:8010', dashboardUrl: null },
        { kind: 'local' }
      );

      expect(server.dashboardUrl).toBeNull();
    });
  });
});

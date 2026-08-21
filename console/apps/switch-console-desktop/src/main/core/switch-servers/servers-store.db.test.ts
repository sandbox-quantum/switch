import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { agents, kv, locations, switchServers } from '@main/db/schema';

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
const { addServer, ensureManagedServer, removeServer, renameServer } =
  await import('./servers-store');

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
    it('updates only the name, leaving URLs and managed metadata untouched', async () => {
      await fixture.db.insert(switchServers).values({
        id: 'remote-1',
        name: 'Old name',
        gatewayUrl: 'https://gw.example.com',
        apiUrl: 'https://api.example.com',
        managed: true,
        managementKind: 'remote',
        sshHost: 'host-a',
      });

      const renamed = await renameServer({ id: 'remote-1', name: '  New name  ' });

      expect(renamed.name).toBe('New name');
      expect(renamed.gatewayUrl).toBe('https://gw.example.com');
      expect(renamed.apiUrl).toBe('https://api.example.com');
      expect(renamed.managed).toBe(true);
      expect(renamed.managementKind).toBe('remote');
      expect(renamed.sshHost).toBe('host-a');
    });

    it('throws for an unknown server id', async () => {
      await expect(renameServer({ id: 'nope', name: 'x' })).rejects.toThrow('No Switch server');
    });
  });

  describe('ensureManagedServer name preservation', () => {
    it('keeps a renamed managed server name across a restart (only URLs refresh)', async () => {
      // First start: registers the local managed row under the default name.
      const created = await ensureManagedServer(
        {
          name: 'Local Switch server',
          gatewayUrl: 'http://localhost:8080',
          apiUrl: 'http://localhost:8081',
        },
        { kind: 'local' }
      );
      // User renames it.
      await renameServer({ id: created.id, name: 'My box' });

      // Restart repicks ports (new URLs) and passes the hardcoded default name.
      const restarted = await ensureManagedServer(
        {
          name: 'Local Switch server',
          gatewayUrl: 'http://localhost:9090',
          apiUrl: 'http://localhost:9091',
        },
        { kind: 'local' }
      );

      expect(restarted.id).toBe(created.id);
      // The rename survives; the URLs still refresh to the new ports.
      expect(restarted.name).toBe('My box');
      expect(restarted.gatewayUrl).toBe('http://localhost:9090');
      expect(restarted.apiUrl).toBe('http://localhost:9091');
    });
  });

  describe('ensureManagedServer telemetry', () => {
    it('reports a new local managed server once', async () => {
      await ensureManagedServer(
        {
          name: 'Local Switch server',
          gatewayUrl: 'http://localhost:8080',
          apiUrl: 'http://localhost:8081',
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
          gatewayUrl: 'http://localhost:8080',
          apiUrl: 'http://localhost:8081',
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
        gatewayUrl: 'http://localhost:8080',
        apiUrl: 'http://localhost:8081',
      };
      await ensureManagedServer(params, ref);
      telemetryMocks.trackEvent.mockClear();

      await ensureManagedServer(
        { ...params, gatewayUrl: 'http://localhost:9090', apiUrl: 'http://localhost:9091' },
        ref
      );

      expect(telemetryMocks.trackEvent).not.toHaveBeenCalled();
    });
  });

  describe('addServer telemetry', () => {
    it('reports an externally-hosted server', async () => {
      await addServer({
        name: 'External server',
        gatewayUrl: 'https://gw.example.com',
        apiUrl: 'https://api.example.com',
      });

      expect(telemetryMocks.trackEvent).toHaveBeenCalledTimes(1);
      expect(telemetryMocks.trackEvent).toHaveBeenCalledWith('server_added', {
        server_kind: 'external',
        outcome: 'success',
      });
    });
  });

  describe('removeServer', () => {
    it('reports the kind of server that was removed', async () => {
      await fixture.db.insert(switchServers).values({
        id: 'srv-ext',
        name: 'External',
        gatewayUrl: 'https://gw.example.com',
        apiUrl: 'https://api.example.com',
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
        gatewayUrl: 'https://gw2.example.com',
        apiUrl: 'https://api2.example.com',
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
      await fixture.db
        .insert(locations)
        .values({ id: 'loc-1', name: 'Loc', sshHost: '', dir: '/repo/loc-1' });
      await fixture.db.insert(switchServers).values({
        id: 'srv-1',
        name: 'Server',
        gatewayUrl: 'https://gw.example.com',
        apiUrl: 'https://api.example.com',
      });
      await fixture.db.insert(agents).values([
        { id: 'agent-1', locationId: 'loc-1', name: 'A', providerId: 'claude', serverId: 'srv-1' },
        { id: 'agent-2', locationId: 'loc-1', name: 'B', providerId: 'claude', serverId: 'srv-1' },
      ]);
      await fixture.db.insert(kv).values({ key: 'activeSwitchServerId', value: 'srv-1' });

      await removeServer('srv-1');

      const remainingServers = await fixture.db.select().from(switchServers);
      expect(remainingServers).toHaveLength(0);

      const remainingAgents = await fixture.db.select().from(agents);
      expect(remainingAgents).toHaveLength(2);
      expect(remainingAgents.every((a) => a.serverId === null)).toBe(true);

      const [activePointer] = await fixture.db
        .select()
        .from(kv)
        .where(eq(kv.key, 'activeSwitchServerId'));
      expect(activePointer).toBeUndefined();

      expect(secretMocks.deleteSecret).toHaveBeenCalledWith('switch-server-cookie:srv-1');
    });
  });
});

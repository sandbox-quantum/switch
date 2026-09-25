import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { agents, locations, switchServers } from '@main/db/schema';
import { resolveAgentServers } from './resolve-servers';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

// servers-store transitively constructs the encrypted-secrets singleton (which
// touches the real db at import). resolveAgentServers never reads cookies, so
// stub it out to keep this test to the agent↔server reconciliation path.
vi.mock('@main/core/secrets/encrypted-app-secrets-store', () => ({
  encryptedAppSecretsStore: {
    getSecret: vi.fn(),
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
  },
}));

async function serverIdOf(db: AppDb, agentId: string): Promise<string | null> {
  const [row] = await db
    .select({ serverId: agents.serverId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return row?.serverId ?? null;
}

describe('resolveAgentServers', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    // Mirror production: the app's main connection does not enforce foreign
    // keys, so an agent can reference a server that has since been removed —
    // exactly the dangling state resolveAgentServers cleans up.
    fixture.sqlite.pragma('foreign_keys = OFF');

    await fixture.db
      .insert(locations)
      .values({ id: 'location-1', name: 'Location', sshHost: '', dir: '/repo/location-1' });
    await fixture.db.insert(switchServers).values([
      {
        id: 'pilot',
        name: 'Pilot',
        gatewayUrl: 'https://pilot-gateway.example.com',
        apiUrl: 'https://pilot-api.example.com',
      },
      {
        id: 'local',
        name: 'Local',
        gatewayUrl: 'http://localhost:8080',
        apiUrl: 'http://localhost:8081',
      },
    ]);
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('keeps links to registered servers, unlinks dangling, leaves unassigned alone', async () => {
    await fixture.db.insert(agents).values([
      // Explicitly linked to a registered server -> kept (not re-derived).
      {
        id: 'agent-pilot',
        locationId: 'location-1',
        name: 'pilot',
        providerId: 'claude',
        apiEndpoint: 'https://pilot.example.com/agent-bridge',
        serverId: 'pilot',
      },
      // Linked to a server that is no longer registered -> unlinked.
      {
        id: 'agent-dangling',
        locationId: 'location-1',
        name: 'dangling',
        providerId: 'claude',
        apiEndpoint: 'https://gone.example.com',
        serverId: 'removed-server',
      },
      // Never assigned -> stays null.
      {
        id: 'agent-none',
        locationId: 'location-1',
        name: 'none',
        providerId: 'claude',
        apiEndpoint: null,
        serverId: null,
      },
    ]);

    await resolveAgentServers();

    expect(await serverIdOf(fixture.db, 'agent-pilot')).toBe('pilot');
    expect(await serverIdOf(fixture.db, 'agent-dangling')).toBeNull();
    expect(await serverIdOf(fixture.db, 'agent-none')).toBeNull();
  });

  it('does not re-link by endpoint origin (links are explicit, never inferred)', async () => {
    // Endpoint origin matches the local server, but serverId is null: the old
    // behavior would auto-link; the new behavior must leave it unassigned.
    await fixture.db.insert(agents).values({
      id: 'agent-origin-match',
      locationId: 'location-1',
      name: 'origin-match',
      providerId: 'claude',
      apiEndpoint: 'http://localhost:8080',
      serverId: null,
    });

    await resolveAgentServers();

    expect(await serverIdOf(fixture.db, 'agent-origin-match')).toBeNull();
  });
});

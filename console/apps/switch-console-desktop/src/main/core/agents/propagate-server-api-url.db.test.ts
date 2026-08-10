import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { agents, locations, switchServers } from '@main/db/schema';
import { propagateServerApiUrl } from './propagate-server-api-url';
import { SWITCH_SETTINGS_RELATIVE_PATH } from './switch-settings-paths';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

// The propagation module imports the SSH stack for the remote path. This test
// exercises only local agents, so stub those out to keep it from loading (and
// to fail loud if a remote write is attempted unexpectedly).
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({
  ensureSshConnected: vi.fn(() => {
    throw new Error('remote path not expected in this test');
  }),
}));
vi.mock('@main/core/fs/impl/ssh-fs', () => ({
  SshFileSystem: class {},
}));
vi.mock('@main/core/locations/location-transport', () => ({
  sshConnectionIdForHost: (host: string) => host,
}));

async function writeSettings(dir: string, contents: Record<string, unknown>): Promise<void> {
  const file = path.join(dir, SWITCH_SETTINGS_RELATIVE_PATH);
  await nodeFs.mkdir(path.dirname(file), { recursive: true });
  await nodeFs.writeFile(file, JSON.stringify(contents, null, 2), 'utf8');
}

async function readEnv(dir: string): Promise<Record<string, unknown>> {
  const raw = await nodeFs.readFile(path.join(dir, SWITCH_SETTINGS_RELATIVE_PATH), 'utf8');
  return (JSON.parse(raw) as { env: Record<string, unknown> }).env;
}

describe('propagateServerApiUrl', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let tmpRoot: string;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    tmpRoot = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'switch-console-propagate-'));

    await fixture.db.insert(switchServers).values([
      {
        id: 'pilot',
        name: 'Pilot',
        gatewayUrl: 'https://pilot-gateway.example.com',
        apiUrl: 'https://old-api.example.com',
      },
      {
        id: 'other',
        name: 'Other',
        gatewayUrl: 'https://other-gateway.example.com',
        apiUrl: 'https://other-api.example.com',
      },
    ]);
  });

  afterEach(async () => {
    fixture.close();
    mocks.db = undefined;
    await nodeFs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('rewrites the endpoint for provisioned member agents, preserves the token, and updates the DB mirror', async () => {
    const dir = path.join(tmpRoot, 'provisioned');
    await writeSettings(dir, {
      permissions: { allow: ['Bash'] },
      env: {
        EXISTING_KEY: 'keep-me',
        SWITCH_API_ENDPOINT: 'https://old-api.example.com',
        SWITCH_API_TOKEN: 'secret-token',
        SWITCH_AGENT_ID: 'switch-agent-1',
      },
    });
    await fixture.db.insert(locations).values({ id: 'loc-1', name: 'Local', sshHost: '', dir });
    await fixture.db.insert(agents).values({
      id: 'agent-1',
      locationId: 'loc-1',
      name: 'provisioned-agent',
      providerId: 'claude',
      apiEndpoint: 'https://old-api.example.com',
      serverId: 'pilot',
    });

    const results = await propagateServerApiUrl('pilot', 'https://new-api.example.com');

    expect(results).toEqual([
      {
        agentId: 'agent-1',
        agentName: 'provisioned-agent',
        location: 'local',
        outcome: 'updated',
      },
    ]);

    // On disk: only the endpoint changed; token, id, other keys preserved.
    expect(await readEnv(dir)).toEqual({
      EXISTING_KEY: 'keep-me',
      SWITCH_API_ENDPOINT: 'https://new-api.example.com',
      SWITCH_API_TOKEN: 'secret-token',
      SWITCH_AGENT_ID: 'switch-agent-1',
    });

    // DB mirror follows the file.
    const [row] = await fixture.db
      .select({ apiEndpoint: agents.apiEndpoint })
      .from(agents)
      .where(eq(agents.id, 'agent-1'));
    expect(row?.apiEndpoint).toBe('https://new-api.example.com');
  });

  it('reports an unprovisioned agent as not-provisioned without writing a file', async () => {
    const dir = path.join(tmpRoot, 'unprovisioned');
    await nodeFs.mkdir(dir, { recursive: true });
    await fixture.db.insert(locations).values({ id: 'loc-2', name: 'Local2', sshHost: '', dir });
    await fixture.db.insert(agents).values({
      id: 'agent-2',
      locationId: 'loc-2',
      name: 'bare-agent',
      providerId: 'claude',
      apiEndpoint: null,
      serverId: 'pilot',
    });

    const results = await propagateServerApiUrl('pilot', 'https://new-api.example.com');

    expect(results).toEqual([
      {
        agentId: 'agent-2',
        agentName: 'bare-agent',
        location: 'local',
        outcome: 'not-provisioned',
      },
    ]);
    // No settings file was created.
    await expect(nodeFs.access(path.join(dir, SWITCH_SETTINGS_RELATIVE_PATH))).rejects.toThrow();
  });

  it('only touches agents linked to the edited server', async () => {
    const dir = path.join(tmpRoot, 'other-server');
    await writeSettings(dir, {
      env: {
        SWITCH_API_ENDPOINT: 'https://other-api.example.com',
        SWITCH_API_TOKEN: 'other-token',
        SWITCH_AGENT_ID: 'switch-agent-other',
      },
    });
    await fixture.db.insert(locations).values({ id: 'loc-3', name: 'Local3', sshHost: '', dir });
    await fixture.db.insert(agents).values({
      id: 'agent-3',
      locationId: 'loc-3',
      name: 'other-agent',
      providerId: 'claude',
      apiEndpoint: 'https://other-api.example.com',
      serverId: 'other',
    });

    const results = await propagateServerApiUrl('pilot', 'https://new-api.example.com');

    // 'pilot' has no agents -> empty result, and the 'other' agent's file is untouched.
    expect(results).toEqual([]);
    expect((await readEnv(dir)).SWITCH_API_ENDPOINT).toBe('https://other-api.example.com');
  });
});

import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { agents, locations, switchServers, workspaces } from '@main/db/schema';
import { propagateServerApiUrl } from './propagate-server-api-url';
import { agentSettingsRelativePath, SWITCH_SETTINGS_RELATIVE_PATH } from './switch-settings-paths';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  /** An SSH host's files, set by a test of the remote path; null fails it loud. */
  remote: null as { files: Map<string, string>; calls: unknown[][] } | null,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

// The propagation module imports the SSH stack for the remote path. Stub it so
// it does not load: a test of the remote path sets `mocks.remote` to the host's
// files, and any other test fails loud if a remote write is attempted.
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({
  ensureSshConnected: vi.fn(async () => {
    if (!mocks.remote) throw new Error('remote path not expected in this test');
    return {};
  }),
}));
vi.mock('@main/core/fs/impl/ssh-fs', async () => {
  const { FileSystemError, FileSystemErrorCodes } =
    await vi.importActual<typeof import('@main/core/fs/types')>('@main/core/fs/types');
  const host = () => {
    if (!mocks.remote) throw new Error('remote path not expected in this test');
    return mocks.remote;
  };
  return {
    SshFileSystem: class {
      async read(p: string) {
        const content = host().files.get(p);
        if (content === undefined) {
          throw new FileSystemError(`File not found: ${p}`, FileSystemErrorCodes.NOT_FOUND);
        }
        return { content, truncated: false, totalSize: content.length };
      }
      async write(p: string, content: string) {
        host().calls.push(['write', p]);
        host().files.set(p, content);
        return { success: true, bytesWritten: content.length };
      }
      async writeSecret(p: string, content: string) {
        host().calls.push(['writeSecret', p]);
        host().files.set(p, content);
      }
      async protectSecret(p: string, options?: { fileOnly?: boolean }) {
        host().calls.push(['protectSecret', p, options]);
        return host().files.has(p);
      }
      close() {}
    },
  };
});
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
        url: 'https://old-api.example.com',
        dashboardUrl: 'https://pilot-gateway.example.com',
      },
      {
        id: 'other',
        name: 'Other',
        url: 'https://other-api.example.com',
        dashboardUrl: 'https://other-gateway.example.com',
      },
    ]);

    // Deliberately not the servers' ids: the cascade has to find agents through
    // their workspace, and identical ids would hide it not doing so.
    await fixture.db.insert(workspaces).values([
      { id: 'ws-pilot', serverId: 'pilot', name: 'Pilot' },
      { id: 'ws-other', serverId: 'other', name: 'Other' },
    ]);
  });

  afterEach(async () => {
    fixture.close();
    mocks.db = undefined;
    mocks.remote = null;
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
    const claudeDir = path.dirname(path.join(dir, SWITCH_SETTINGS_RELATIVE_PATH));
    const claudeDirMode = (await nodeFs.stat(claudeDir)).mode & 0o777;
    await fixture.db.insert(locations).values({ id: 'loc-1', name: 'Local', sshHost: '', dir });
    await fixture.db.insert(agents).values({
      id: 'agent-1',
      locationId: 'loc-1',
      name: 'provisioned-agent',
      switchAgentId: 'switch-agent-1',
      providerId: 'claude',
      apiEndpoint: 'https://old-api.example.com',
      workspaceId: 'ws-pilot',
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
    // It still holds a token, so it is the owner's alone; `.claude/` is Claude
    // Code's and keeps its mode.
    if (process.platform !== 'win32') {
      const file = path.join(dir, SWITCH_SETTINGS_RELATIVE_PATH);
      expect((await nodeFs.stat(file)).mode & 0o777).toBe(0o600);
      expect((await nodeFs.stat(claudeDir)).mode & 0o777).toBe(claudeDirMode);
    }

    // DB mirror follows the file.
    const [row] = await fixture.db
      .select({ apiEndpoint: agents.apiEndpoint })
      .from(agents)
      .where(eq(agents.id, 'agent-1'));
    expect(row?.apiEndpoint).toBe('https://new-api.example.com');
  });

  it.each(['claude', 'codex', 'opencode', 'antigravity', 'cursor', 'kiro', 'junie'] as const)(
    'updates named %s credentials without changing another agent',
    async (providerId) => {
      const dir = path.join(tmpRoot, 'named');
      const file = path.join(dir, agentSettingsRelativePath('named-agent'));
      await nodeFs.mkdir(path.dirname(file), { recursive: true });
      const env = {
        SWITCH_API_ENDPOINT: 'https://old-api.example.com',
        SWITCH_AGENT_ID: 'named-identity',
        EXISTING_KEY: 'preserved',
      };
      await nodeFs.writeFile(file, JSON.stringify({ env }));
      await writeSettings(dir, {
        env: {
          SWITCH_API_ENDPOINT: 'https://other-api.example.com',
          SWITCH_AGENT_ID: 'other-identity',
        },
      });
      await fixture.db
        .insert(locations)
        .values({ id: 'named-location', name: 'Local', sshHost: '', dir });
      await fixture.db.insert(agents).values({
        id: 'named-agent',
        locationId: 'named-location',
        name: 'named-agent',
        providerId,
        workspaceId: 'ws-pilot',
        apiEndpoint: env.SWITCH_API_ENDPOINT,
      });
      expect(await propagateServerApiUrl('pilot', 'https://new-api.example.com')).toMatchObject([
        { agentId: 'named-agent', outcome: 'updated' },
      ]);
      expect(JSON.parse(await nodeFs.readFile(file, 'utf8')).env).toEqual({
        ...env,
        SWITCH_API_ENDPOINT: 'https://new-api.example.com',
      });
      // Seeded with the default umask; the rewrite leaves it the owner's alone.
      if (process.platform !== 'win32') {
        expect((await nodeFs.stat(file)).mode & 0o777).toBe(0o600);
      }
      expect((await readEnv(dir)).SWITCH_API_ENDPOINT).toBe('https://other-api.example.com');
    }
  );

  it('reports malformed named credentials without changing the legacy file', async () => {
    const dir = path.join(tmpRoot, 'malformed');
    const file = path.join(dir, agentSettingsRelativePath('broken-agent'));
    await nodeFs.mkdir(path.dirname(file), { recursive: true });
    await nodeFs.writeFile(file, '{');
    await writeSettings(dir, {
      env: {
        SWITCH_API_ENDPOINT: 'https://old-api.example.com',
        SWITCH_AGENT_ID: 'legacy-identity',
      },
    });
    await fixture.db
      .insert(locations)
      .values({ id: 'broken-location', name: 'Local', sshHost: '', dir });
    await fixture.db.insert(agents).values({
      id: 'broken-agent',
      locationId: 'broken-location',
      name: 'broken-agent',
      providerId: 'codex',
      workspaceId: 'ws-pilot',
    });
    expect(await propagateServerApiUrl('pilot', 'https://new-api.example.com')).toMatchObject([
      { agentId: 'broken-agent', outcome: 'failed', error: expect.stringContaining('invalid') },
    ]);
    expect(await nodeFs.readFile(file, 'utf8')).toBe('{');
    expect((await readEnv(dir)).SWITCH_API_ENDPOINT).toBe('https://old-api.example.com');
  });

  it('does not rewrite a legacy file owned by another agent in the same directory', async () => {
    const dir = path.join(tmpRoot, 'shared-location');
    await writeSettings(dir, {
      env: {
        SWITCH_API_ENDPOINT: 'https://other-api.example.com',
        SWITCH_AGENT_ID: 'agent-b-identity',
      },
    });
    await fixture.db
      .insert(locations)
      .values({ id: 'shared-location', name: 'Local', sshHost: '', dir });
    await fixture.db.insert(agents).values([
      {
        id: 'agent-a',
        locationId: 'shared-location',
        name: 'agent-a',
        providerId: 'codex',
        workspaceId: 'ws-pilot',
        switchAgentId: 'agent-a-identity',
      },
      {
        id: 'agent-b',
        locationId: 'shared-location',
        name: 'agent-b',
        providerId: 'claude',
        workspaceId: 'ws-other',
        switchAgentId: 'agent-b-identity',
      },
    ]);
    expect(await propagateServerApiUrl('pilot', 'https://new-api.example.com')).toMatchObject([
      { agentId: 'agent-a', outcome: 'not-provisioned' },
    ]);
    expect((await readEnv(dir)).SWITCH_API_ENDPOINT).toBe('https://other-api.example.com');
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
      workspaceId: 'ws-pilot',
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
      workspaceId: 'ws-other',
    });

    const results = await propagateServerApiUrl('pilot', 'https://new-api.example.com');

    // 'pilot' has no agents -> empty result, and the 'other' agent's file is untouched.
    expect(results).toEqual([]);
    expect((await readEnv(dir)).SWITCH_API_ENDPOINT).toBe('https://other-api.example.com');
  });
  async function remoteAgent(id: string, switchAgentId: string): Promise<void> {
    await fixture.db
      .insert(locations)
      .values({ id: `loc-${id}`, name: 'VM', sshHost: 'vm', dir: '/srv/repo' });
    await fixture.db.insert(agents).values({
      id,
      locationId: `loc-${id}`,
      name: id,
      switchAgentId,
      providerId: 'claude',
      apiEndpoint: 'https://old-api.example.com',
      workspaceId: 'ws-pilot',
    });
  }

  it('rewrites a remote agent’s credentials through a secret write', async () => {
    const relPath = agentSettingsRelativePath('remote-agent');
    mocks.remote = {
      files: new Map([
        [
          relPath,
          JSON.stringify({
            env: {
              SWITCH_API_ENDPOINT: 'https://old-api.example.com',
              SWITCH_API_TOKEN: 'secret-token',
              SWITCH_AGENT_ID: 'sw-remote',
            },
          }),
        ],
      ]),
      calls: [],
    };
    await remoteAgent('remote-agent', 'sw-remote');

    expect(await propagateServerApiUrl('pilot', 'https://new-api.example.com')).toMatchObject([
      { agentId: 'remote-agent', location: 'remote', outcome: 'updated' },
    ]);

    expect(mocks.remote.calls).toEqual([['writeSecret', relPath]]);
    expect(JSON.parse(mocks.remote.files.get(relPath) as string).env).toMatchObject({
      SWITCH_API_ENDPOINT: 'https://new-api.example.com',
      SWITCH_API_TOKEN: 'secret-token',
    });
  });

  it('restricts a remote legacy settings file that holds a token, file only, before rewriting it', async () => {
    mocks.remote = {
      files: new Map([
        [
          SWITCH_SETTINGS_RELATIVE_PATH,
          JSON.stringify({
            env: {
              SWITCH_API_ENDPOINT: 'https://old-api.example.com',
              SWITCH_API_TOKEN: 'secret-token',
              SWITCH_AGENT_ID: 'sw-legacy',
            },
          }),
        ],
      ]),
      calls: [],
    };
    await remoteAgent('legacy-agent', 'sw-legacy');

    expect(await propagateServerApiUrl('pilot', 'https://new-api.example.com')).toMatchObject([
      { agentId: 'legacy-agent', location: 'remote', outcome: 'updated' },
    ]);

    expect(mocks.remote.calls).toEqual([
      ['protectSecret', SWITCH_SETTINGS_RELATIVE_PATH, { fileOnly: true }],
      ['write', SWITCH_SETTINGS_RELATIVE_PATH],
    ]);
  });
});

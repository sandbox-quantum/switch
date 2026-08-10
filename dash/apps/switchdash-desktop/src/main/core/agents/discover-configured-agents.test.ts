import type { PluginFs } from '@switchdash/core/agents/plugins';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * In-memory {@link PluginFs} with the real `list` semantics discovery depends on:
 * basenames of one directory's entries, and `[]` for a directory that does not
 * exist (never a throw).
 */
function fakeFs(seed: Record<string, string> = {}): PluginFs {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    read: (p) => Promise.resolve(files.get(p) ?? null),
    write: (p, c) => {
      files.set(p, c);
      return Promise.resolve();
    },
    delete: (p) => {
      files.delete(p);
      return Promise.resolve();
    },
    exists: (p) => Promise.resolve(files.has(p)),
    list: (dir) => {
      const prefix = `${dir}/`;
      const entries = new Set<string>();
      for (const p of files.keys()) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf('/');
        entries.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      return Promise.resolve([...entries]);
    },
  };
}

function creds(agentId: string, endpoint = 'https://switch.example.com', token = 'tok-secret') {
  return `${JSON.stringify({
    permissions: { allow: ['mcp__plugin_switch-connector_switch'] },
    env: {
      SWITCH_API_ENDPOINT: endpoint,
      SWITCH_API_TOKEN: token,
      SWITCH_AGENT_ID: agentId,
    },
  })}\n`;
}

function launchSpec(providerId: string) {
  return JSON.stringify({ command: 'codex', args: [], env: {}, cwd: '/repo', providerId });
}

const h = vi.hoisted(() => {
  const state: {
    workspace: PluginFs | null;
    location: { id: string } | undefined;
    /** Agent-row names already in the directory, per Switch server. */
    agentNamesByServer: Record<string, string[]>;
    claudeDefinitions: Array<{ name: string; description: string | null }>;
  } = { workspace: null, location: { id: 'loc-1' }, agentNamesByServer: {}, claudeDefinitions: [] };
  return { state, warn: vi.fn() };
});

vi.mock('@main/core/locations/store', () => ({
  getLocationByHostDir: vi.fn(async () => h.state.location),
}));
vi.mock('./getAgents', () => ({
  getLocationAgentsOnServer: vi.fn(async (_locationId: string, serverId: string) =>
    (h.state.agentNamesByServer[serverId] ?? []).map((name) => ({ name }))
  ),
}));
vi.mock('./agent-workspace-fs', () => ({
  resolveWorkspaceFsFor: vi.fn(async () => ({
    fs: h.state.workspace as PluginFs,
    homeFs: null,
    close: vi.fn(),
  })),
}));
vi.mock('@main/core/providers/plugin-registry', () => ({
  listPlugins: () => [
    { metadata: { id: 'codex' }, behavior: {} },
    {
      metadata: { id: 'claude' },
      behavior: {
        repoAgents: { discoverDefinitions: async () => h.state.claudeDefinitions },
      },
    },
  ],
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: h.warn, error: vi.fn() } }));

const { discoverConfiguredAgents } = await import('./discover-configured-agents');

const scan = (serverId = 'srv-a') =>
  discoverConfiguredAgents({ sshHost: 'vm-1', dir: '/repo', serverId });

describe('discoverConfiguredAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.location = { id: 'loc-1' };
    h.state.agentNamesByServer = {};
    h.state.claudeDefinitions = [];
    h.state.workspace = fakeFs();
  });

  it('finds a Codex agent from credentials alone', async () => {
    // The gap this feature closes: Codex has no repo-agent definitions, so the
    // definition-based scan sees nothing. The provider-neutral credentials file
    // is written for every provider, so it finds the agent anyway.
    h.state.workspace = fakeFs({
      '.switch/agents/.gitignore': '*\n',
      '.switch/agents/codex-hoot.json': creds('sw-codex'),
      '.switchdash/agents/codex-hoot/agent-launch-spec.json': launchSpec('codex'),
    });

    expect(await scan()).toEqual([
      {
        name: 'codex-hoot',
        switchAgentId: 'sw-codex',
        apiEndpoint: 'https://switch.example.com',
        providerId: 'codex',
        providerSource: 'launch-spec',
        alreadyAgent: false,
      },
    ]);
  });

  it('never surfaces the API token', async () => {
    // Attaching must not need the secret: it stays on disk for the launch path.
    h.state.workspace = fakeFs({
      '.switch/agents/hoot.json': creds('sw-1', 'https://switch.example.com', 'tok-do-not-leak'),
    });

    expect(JSON.stringify(await scan())).not.toContain('tok-do-not-leak');
  });

  it('falls back to the owning provider definition, then to unknown', async () => {
    h.state.claudeDefinitions = [{ name: 'cc-hoot', description: null }];
    h.state.workspace = fakeFs({
      '.switch/agents/cc-hoot.json': creds('sw-cc'),
      '.switch/agents/mystery.json': creds('sw-my'),
    });

    const byName = new Map((await scan()).map((a) => [a.name, a]));
    expect(byName.get('cc-hoot')).toMatchObject({
      providerId: 'claude',
      providerSource: 'definition',
    });
    expect(byName.get('mystery')).toMatchObject({
      providerId: null,
      providerSource: 'unknown',
    });
  });

  it('prefers the launch spec over a definition, since it is what actually spawns', async () => {
    h.state.claudeDefinitions = [{ name: 'hoot', description: null }];
    h.state.workspace = fakeFs({
      '.switch/agents/hoot.json': creds('sw-1'),
      '.switchdash/agents/hoot/agent-launch-spec.json': launchSpec('codex'),
    });

    expect((await scan())[0]).toMatchObject({ providerId: 'codex', providerSource: 'launch-spec' });
  });

  it('marks agents this switchdash already has a row for', async () => {
    h.state.agentNamesByServer = { 'srv-a': ['mine'] };
    h.state.workspace = fakeFs({
      '.switch/agents/mine.json': creds('sw-mine'),
      '.switch/agents/theirs.json': creds('sw-theirs'),
    });

    const byName = new Map((await scan()).map((a) => [a.name, a.alreadyAgent]));
    expect(byName.get('mine')).toBe(true);
    expect(byName.get('theirs')).toBe(false);
  });

  it('still offers an agent already attached to another server (CHOO-2044)', async () => {
    // The directory is a place on disk, not one server's territory. An agent row
    // for server A says nothing about server B, and treating it as "already got
    // this" is what silently emptied the onboarding list.
    h.state.agentNamesByServer = { 'srv-a': ['shared'] };
    h.state.workspace = fakeFs({ '.switch/agents/shared.json': creds('sw-shared') });

    expect((await scan('srv-a'))[0]).toMatchObject({ name: 'shared', alreadyAgent: true });
    expect((await scan('srv-b'))[0]).toMatchObject({ name: 'shared', alreadyAgent: false });
  });

  it('treats a directory with no credentials dir as having no agents', async () => {
    expect(await scan()).toEqual([]);
  });

  it('reports nothing for an unknown location rather than failing', async () => {
    h.state.location = undefined;
    h.state.workspace = fakeFs({ '.switch/agents/hoot.json': creds('sw-1') });

    expect((await scan())[0]).toMatchObject({ name: 'hoot', alreadyAgent: false });
  });

  it('skips unusable credentials files instead of inventing an identity', async () => {
    h.state.workspace = fakeFs({
      '.switch/agents/broken.json': '{ not json',
      '.switch/agents/no-id.json': JSON.stringify({ env: { SWITCH_API_ENDPOINT: 'https://x' } }),
      '.switch/agents/good.json': creds('sw-good'),
    });

    expect((await scan()).map((a) => a.name)).toEqual(['good']);
    expect(h.warn).toHaveBeenCalled();
  });

  it('ignores non-JSON entries such as the .gitignore', async () => {
    h.state.workspace = fakeFs({
      '.switch/agents/.gitignore': '*\n',
      '.switch/agents/hoot.json': creds('sw-1'),
    });

    expect((await scan()).map((a) => a.name)).toEqual(['hoot']);
  });
});

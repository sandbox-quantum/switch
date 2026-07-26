import type { PluginFs } from '@switchdash/core/agents/plugins';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An in-memory {@link PluginFs} keyed by the exact relative paths the migration
 * uses, so path helpers (`agentSettingsRelativePath`, `SWITCH_SETTINGS_RELATIVE_PATH`)
 * resolve against real content.
 */
function fakeFs(seed: Record<string, string>): PluginFs {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    read: (p) => Promise.resolve(files.has(p) ? (files.get(p) as string) : null),
    write: (p, c) => {
      files.set(p, c);
      return Promise.resolve();
    },
    delete: (p) => {
      files.delete(p);
      return Promise.resolve();
    },
    exists: (p) => Promise.resolve(files.has(p)),
    list: (dir) =>
      Promise.resolve(
        [...files.keys()]
          .filter((k) => k.startsWith(`${dir}/`))
          .map((k) => k.slice(dir.length + 1))
          .filter((k) => !k.includes('/'))
      ),
  };
}

function credsJson(agentId: string): string {
  return JSON.stringify({
    env: {
      SWITCH_API_ENDPOINT: 'http://switch.example',
      SWITCH_API_TOKEN: 'tok-123',
      SWITCH_AGENT_ID: agentId,
    },
  });
}

// Shared mock state + spies. Hoisted so the vi.mock factories (which are lifted
// above imports) can reference them. `agents`/`workspace` are set per test.
const h = vi.hoisted(() => {
  const state: { agents: Array<Record<string, unknown>>; workspace: PluginFs | null } = {
    agents: [],
    workspace: null,
  };
  return {
    state,
    writeCredentials: vi.fn((fs: PluginFs, creds: { agentName: string }) =>
      fs.write(
        `.switch/agents/${creds.agentName}.json`,
        JSON.stringify({
          env: { SWITCH_API_ENDPOINT: 'x', SWITCH_API_TOKEN: 'x', SWITCH_AGENT_ID: 'x' },
        })
      )
    ),
    readLaunchEnv: vi.fn(async (fs: PluginFs, name: string) => {
      const raw =
        (await fs.read(`.switch/agents/${name}.json`)) ??
        (await fs.read(`.claude/switch-subagents/${name}.settings.json`));
      return raw ? ((JSON.parse(raw).env ?? {}) as Record<string, string>) : {};
    }),
    readDefinition: vi.fn((fs: PluginFs, name: string) =>
      fs.read(`.claude/agents/${name}.md`).then((c) => (c === null ? null : { name }))
    ),
    writeDefinition: vi.fn((fs: PluginFs, attrs: { name: string }) =>
      fs.write(`.claude/agents/${attrs.name}.md`, `# ${attrs.name}`)
    ),
    discoverLocal: vi.fn(async () => []),
    updateAgent: vi.fn(async () => undefined),
  };
});

vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: () => ({
    behavior: {
      repoAgents: {
        writeCredentials: h.writeCredentials,
        readLaunchEnv: h.readLaunchEnv,
        readDefinition: h.readDefinition,
        writeDefinition: h.writeDefinition,
        discoverLocal: h.discoverLocal,
      },
    },
  }),
}));
vi.mock('@main/core/locations/store', () => ({
  getLocationById: vi.fn(async () => ({ id: 'loc', sshHost: null, dir: '/repo' })),
}));
vi.mock('./agent-workspace-fs', () => ({
  resolveWorkspaceFsFor: vi.fn(async () => ({
    fs: h.state.workspace,
    homeFs: h.state.workspace,
    close: () => {},
  })),
}));
vi.mock('./getAgents', () => ({ getAgents: vi.fn(async () => h.state.agents) }));
vi.mock('./updateAgent', () => ({ updateAgent: h.updateAgent }));
vi.mock('@main/core/switch-servers/gateway-client', () => ({ fetchAgentDetail: vi.fn() }));
vi.mock('@main/core/switch-servers/servers-store', () => ({ getServer: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { migrateAgentStorage } from './migrate-agent-storage';

const baseAgent = {
  id: 'agent-id-1',
  providerId: 'claude',
  locationId: 'loc',
  name: 'hoot-main',
  definitionName: 'cc-hoot-main',
  switchAgentId: 'sw-1',
  serverId: 'srv-1',
};

describe('migrateAgentStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.agents = [{ ...baseAgent }];
  });

  it('recovers creds from a stale id-keyed neutral file, writes the name-keyed file, and removes the stale one', async () => {
    const ws = fakeFs({
      '.switch/agents/agent-id-1.json': credsJson('sw-1'),
      '.claude/agents/cc-hoot-main.md': '# def',
    });
    h.state.workspace = ws;

    await migrateAgentStorage();

    expect(h.writeCredentials).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({ agentName: 'cc-hoot-main', apiToken: 'tok-123', agentId: 'sw-1' })
    );
    expect(await ws.exists('.switch/agents/cc-hoot-main.json')).toBe(true);
    expect(await ws.exists('.switch/agents/agent-id-1.json')).toBe(false);
  });

  it('falls back to .claude/settings.local.json when no neutral file exists', async () => {
    const ws = fakeFs({
      '.claude/settings.local.json': credsJson('sw-1'),
      '.claude/agents/cc-hoot-main.md': '# def',
    });
    h.state.workspace = ws;

    await migrateAgentStorage();

    expect(h.writeCredentials).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({ agentName: 'cc-hoot-main', agentId: 'sw-1' })
    );
  });

  it('does nothing when the name-keyed file already exists and the definition is present', async () => {
    h.state.workspace = fakeFs({
      '.switch/agents/cc-hoot-main.json': credsJson('sw-1'),
      '.claude/agents/cc-hoot-main.md': '# def',
    });

    await migrateAgentStorage();

    expect(h.writeCredentials).not.toHaveBeenCalled();
    expect(h.writeDefinition).not.toHaveBeenCalled();
    expect(h.updateAgent).not.toHaveBeenCalled();
  });

  it('writes no credentials when none exist anywhere (unrecoverable token)', async () => {
    const ws = fakeFs({ '.claude/agents/cc-hoot-main.md': '# def' });
    h.state.workspace = ws;

    await migrateAgentStorage();

    expect(h.writeCredentials).not.toHaveBeenCalled();
    expect(await ws.exists('.switch/agents/cc-hoot-main.json')).toBe(false);
  });
});

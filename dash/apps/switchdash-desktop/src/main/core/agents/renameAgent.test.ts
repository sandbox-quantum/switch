import type { PluginFs } from '@switchdash/core/agents/plugins';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSettingsRelativePath } from './switch-settings-paths';

function fakeFs(seed: Record<string, string> = {}): PluginFs {
  const files = new Map(Object.entries(seed));
  return {
    read: async (p) => files.get(p) ?? null,
    write: async (p, c) => void files.set(p, c),
    delete: async (p) => void files.delete(p),
    exists: async (p) => files.has(p),
    list: async () => [...files.keys()],
  };
}

const h = vi.hoisted(() => {
  const readDefinition = vi.fn(async (fs: PluginFs, name: string) =>
    (await fs.read(`.claude/agents/${name}.md`)) === null ? null : { name, description: 'd' }
  );
  const writeDefinition = vi.fn(async (fs: PluginFs, attrs: { name: string }) => {
    await fs.write(`.claude/agents/${attrs.name}.md`, `# ${attrs.name}`);
  });
  const removeLocal = vi.fn(async (fs: PluginFs, name: string) => {
    await fs.delete(`.claude/agents/${name}.md`);
  });
  const state: {
    row: Record<string, unknown> | undefined;
    fs: PluginFs;
    repoAgents: object | null;
  } = {
    row: undefined,
    fs: fakeFs(),
    repoAgents: { readDefinition, writeDefinition, removeLocal },
  };
  return { state, readDefinition, writeDefinition, removeLocal };
});

vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: () => ({ behavior: { repoAgents: h.state.repoAgents } }),
}));
vi.mock('./agent-location', () => ({
  getAgentLocation: vi.fn(async () => ({ sshHost: null, dir: '/repo' })),
  getRemoteAgentLocation: vi.fn(async () => null),
}));
vi.mock('./agent-workspace-fs', () => ({
  resolveWorkspaceFsFor: vi.fn(async () => ({ fs: h.state.fs, close: vi.fn() })),
}));
vi.mock('./getAgentById', () => ({
  getAgentById: vi.fn(async () => ({ id: 'agent-1', name: 'old-name', providerId: 'claude' })),
}));
vi.mock('./connect-remote-agent', () => ({ connectRemoteAgent: vi.fn() }));
vi.mock('./remote-watcher', () => ({ ensureRemoteWatcher: vi.fn(async () => {}) }));
vi.mock('@main/core/agent-runtime/impl/remote-sidecar-launcher', () => ({
  agentSidecarTmuxName: vi.fn(() => 'tmux'),
  killSidecarSession: vi.fn(async () => {}),
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@main/db/client', () => ({
  db: {
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => (h.state.row ? [h.state.row] : []) }) }),
    }),
  },
}));
vi.mock('@main/db/schema', () => ({ agents: {} }));
vi.mock('./utils', () => ({
  mapAgentRowToAgent: (row: Record<string, unknown>) => row,
}));

const { renameAgent } = await import('./renameAgent');

const CREDS = JSON.stringify({
  env: { SWITCH_API_ENDPOINT: 'https://s', SWITCH_API_TOKEN: 'tok-123', SWITCH_AGENT_ID: 'sw-1' },
});

describe('renameAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.row = { id: 'agent-1', name: 'new-name', providerId: 'claude' };
    h.state.repoAgents = {
      readDefinition: h.readDefinition,
      writeDefinition: h.writeDefinition,
      removeLocal: h.removeLocal,
    };
  });

  it('moves the credentials onto the new name so the minted token is not lost', async () => {
    // The token is minted once and lives only in this file; every reader resolves
    // it from the agent's current name.
    const fs = fakeFs({ [agentSettingsRelativePath('old-name')]: CREDS });
    h.state.fs = fs;

    await renameAgent({ agentId: 'agent-1', newName: 'new-name' });

    expect(await fs.read(agentSettingsRelativePath('new-name'))).toBe(CREDS);
    expect(await fs.exists(agentSettingsRelativePath('old-name'))).toBe(false);
  });

  it('moves the credentials for a provider with no repo-agent definitions', async () => {
    h.state.repoAgents = null;
    const fs = fakeFs({ [agentSettingsRelativePath('old-name')]: CREDS });
    h.state.fs = fs;

    await renameAgent({ agentId: 'agent-1', newName: 'new-name' });

    expect(await fs.read(agentSettingsRelativePath('new-name'))).toBe(CREDS);
    expect(await fs.exists(agentSettingsRelativePath('old-name'))).toBe(false);
  });

  it('moves the definition too, so the CLI can still launch as --agent <new name>', async () => {
    const fs = fakeFs({
      [agentSettingsRelativePath('old-name')]: CREDS,
      '.claude/agents/old-name.md': '# old-name',
    });
    h.state.fs = fs;

    await renameAgent({ agentId: 'agent-1', newName: 'new-name' });

    expect(await fs.exists('.claude/agents/new-name.md')).toBe(true);
    expect(await fs.exists('.claude/agents/old-name.md')).toBe(false);
  });

  it('writes the new files before removing the old ones', async () => {
    const order: string[] = [];
    const fs = fakeFs({
      [agentSettingsRelativePath('old-name')]: CREDS,
      '.claude/agents/old-name.md': '# old-name',
    });
    const write = fs.write.bind(fs);
    const del = fs.delete.bind(fs);
    fs.write = async (p, c) => {
      order.push(`write ${p}`);
      return write(p, c);
    };
    fs.delete = async (p) => {
      order.push(`delete ${p}`);
      return del(p);
    };
    h.state.fs = fs;

    await renameAgent({ agentId: 'agent-1', newName: 'new-name' });

    // An interruption must leave a recoverable duplicate, never nothing.
    const firstDelete = order.findIndex((o) => o.startsWith('delete'));
    const lastWrite = order.map((o) => o.startsWith('write')).lastIndexOf(true);
    expect(firstDelete).toBeGreaterThan(lastWrite);
  });

  it('does not touch the filesystem when the name is unchanged', async () => {
    h.state.row = { id: 'agent-1', name: 'old-name', providerId: 'claude' };
    const fs = fakeFs({ [agentSettingsRelativePath('old-name')]: CREDS });
    h.state.fs = fs;

    await renameAgent({ agentId: 'agent-1', newName: 'old-name' });

    expect(await fs.read(agentSettingsRelativePath('old-name'))).toBe(CREDS);
    expect(h.removeLocal).not.toHaveBeenCalled();
  });
});

import type { PluginFs } from '@switch-console/core/agents/plugins';
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
  const removeLocal = vi.fn(async (fs: PluginFs, name: string) => {
    await fs.delete(`.claude/agents/${name}.md`);
  });
  const state: { fs: PluginFs; repoAgents: object | null; agent: Record<string, unknown> | null } =
    {
      fs: fakeFs(),
      repoAgents: { removeLocal },
      agent: null,
    };
  return { state, removeLocal, removeSwitchCredentials: vi.fn(async () => {}) };
});

vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: () => ({ behavior: { repoAgents: h.state.repoAgents } }),
}));
vi.mock('./agent-workspace-fs', () => ({
  resolveWorkspaceFsFor: vi.fn(async () => ({ fs: h.state.fs, close: vi.fn() })),
}));
vi.mock('./agent-location', () => ({
  getAgentLocation: vi.fn(async () => ({ sshHost: null, dir: '/repo' })),
}));
vi.mock('./getAgentById', () => ({ getAgentById: vi.fn(async () => h.state.agent) }));
vi.mock('./remove-switch-settings', () => ({
  removeSwitchCredentials: h.removeSwitchCredentials,
}));
vi.mock('./agent-events', () => ({ agentEvents: { _emit: vi.fn() } }));
vi.mock('./remote-watcher', () => ({ stopRemoteWatcher: vi.fn(async () => {}) }));
vi.mock('./connect-remote-agent', () => ({ connectRemoteAgent: vi.fn() }));
vi.mock('@main/core/agent-runtime/impl/remote-sidecar-launcher', () => ({
  agentSidecarTmuxName: vi.fn(() => 'tmux'),
  killSidecarSession: vi.fn(async () => {}),
}));
vi.mock('@main/core/switch-rooms/auto-session-store', () => ({
  setAutoSessionAgent: vi.fn(async () => {}),
}));
vi.mock('@main/core/switch-rooms/auto-session-watcher', () => ({
  autoSessionWatcher: { stopForAgent: vi.fn() },
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({ deleteAgent: vi.fn() }));
vi.mock('@main/core/switch-servers/servers-store', () => ({ getServer: vi.fn() }));
vi.mock('@main/core/view-state/view-state-service', () => ({
  viewStateService: { del: vi.fn(async () => {}) },
}));
vi.mock('../sessions/session-runtime-manager', () => ({
  sessionRuntimeManager: { teardownSession: vi.fn(async () => {}) },
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@main/db/schema', () => ({ agents: {}, sessions: {} }));
vi.mock('@main/db/client', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    delete: () => ({ where: async () => undefined }),
  },
}));

const { deleteAgent } = await import('./deleteAgent');

const CREDS = JSON.stringify({
  env: { SWITCH_API_ENDPOINT: 'https://s', SWITCH_API_TOKEN: 'tok-123', SWITCH_AGENT_ID: 'sw-1' },
});

describe('deleteAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.repoAgents = { removeLocal: h.removeLocal };
    h.state.agent = { id: 'agent-1', name: 'cc-hoot', providerId: 'claude', locationId: 'loc' };
  });

  it('removes the per-agent credentials for a provider with no repo-agent definitions', async () => {
    // The write is unconditional for every provider, so the teardown must be too:
    // a provider without `removeLocal` would otherwise leave a live token on disk
    // with no UI path left to revoke it.
    h.state.repoAgents = null;
    h.state.agent = { id: 'agent-1', name: 'codex-hoot', providerId: 'codex', locationId: 'loc' };
    const fs = fakeFs({ [agentSettingsRelativePath('codex-hoot')]: CREDS });
    h.state.fs = fs;

    await deleteAgent('agent-1', { deleteInSwitch: false });

    expect(await fs.exists(agentSettingsRelativePath('codex-hoot'))).toBe(false);
  });

  it('removes both the credentials and the definition for a repo-agents provider', async () => {
    const fs = fakeFs({
      [agentSettingsRelativePath('cc-hoot')]: CREDS,
      '.claude/agents/cc-hoot.md': '# cc-hoot',
    });
    h.state.fs = fs;

    await deleteAgent('agent-1', { deleteInSwitch: false });

    expect(await fs.exists(agentSettingsRelativePath('cc-hoot'))).toBe(false);
    expect(await fs.exists('.claude/agents/cc-hoot.md')).toBe(false);
  });

  it('leaves a sibling agent sharing the directory untouched', async () => {
    const fs = fakeFs({
      [agentSettingsRelativePath('cc-hoot')]: CREDS,
      [agentSettingsRelativePath('cc-sibling')]: CREDS,
    });
    h.state.fs = fs;

    await deleteAgent('agent-1', { deleteInSwitch: false });

    expect(await fs.exists(agentSettingsRelativePath('cc-sibling'))).toBe(true);
  });
});

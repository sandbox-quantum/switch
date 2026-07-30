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
// `repoAgents` is the behavior `getPlugin` returns — set it to null in a test to
// simulate a provider without repo-agent definitions (e.g. Codex).
const h = vi.hoisted(() => {
  const readLaunchEnv = vi.fn(async (fs: PluginFs, name: string) => {
    const raw =
      (await fs.read(`.switch/agents/${name}.json`)) ??
      (await fs.read(`.claude/switch-subagents/${name}.settings.json`));
    return raw ? ((JSON.parse(raw).env ?? {}) as Record<string, string>) : {};
  });
  const readDefinition = vi.fn((fs: PluginFs, name: string) =>
    fs.read(`.claude/agents/${name}.md`).then((c) => (c === null ? null : { name }))
  );
  const writeDefinition = vi.fn((fs: PluginFs, attrs: { name: string }) =>
    fs.write(`.claude/agents/${attrs.name}.md`, `# ${attrs.name}`)
  );
  const discoverLocal = vi.fn(async () => []);
  const defaultRepoAgents = {
    readLaunchEnv,
    readDefinition,
    writeDefinition,
    discoverLocal,
  };
  const state: {
    agents: Array<Record<string, unknown>>;
    workspace: PluginFs | null;
    repoAgents: object | null;
  } = {
    agents: [],
    workspace: null,
    repoAgents: defaultRepoAgents,
  };
  return {
    state,
    defaultRepoAgents,
    readLaunchEnv,
    readDefinition,
    writeDefinition,
    discoverLocal,
    updateAgent: vi.fn(async () => undefined),
    isComplete: vi.fn(async () => false),
    markComplete: vi.fn(async () => undefined),
  };
});

vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: () => ({ behavior: { repoAgents: h.state.repoAgents } }),
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
vi.mock('./agent-storage-migration-marker', () => ({
  isAgentStorageMigrationComplete: h.isComplete,
  markAgentStorageMigrationComplete: h.markComplete,
}));

import { migrateAgentStorage } from './migrate-agent-storage';

const baseAgent = {
  id: 'agent-id-1',
  providerId: 'claude',
  locationId: 'loc',
  // The agent's single identity — the creds/definition stem on disk (CHOO-1440).
  name: 'cc-hoot-main',
  switchAgentId: 'sw-1',
  serverId: 'srv-1',
};

describe('migrateAgentStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.agents = [{ ...baseAgent }];
    h.state.repoAgents = h.defaultRepoAgents;
  });

  it('recovers creds from a stale id-keyed neutral file, writes the name-keyed file, and removes the stale one', async () => {
    const ws = fakeFs({
      '.switch/agents/agent-id-1.json': credsJson('sw-1'),
      '.claude/agents/cc-hoot-main.md': '# def',
    });
    h.state.workspace = ws;

    await migrateAgentStorage();

    expect(await ws.exists('.switch/agents/cc-hoot-main.json')).toBe(true);
    const written = JSON.parse((await ws.read('.switch/agents/cc-hoot-main.json')) as string);
    expect(written.env.SWITCH_API_TOKEN).toBe('tok-123');
    expect(written.env.SWITCH_AGENT_ID).toBe('sw-1');
    expect(await ws.exists('.switch/agents/agent-id-1.json')).toBe(false);
  });

  it('migrates a provider without repo-agents (Codex): id-keyed creds → name-keyed, id file removed, no definition written', async () => {
    // Codex has no repoAgents behavior; the pre-rework scheme keyed its neutral
    // creds file by agent id. The migration must still collapse it onto the
    // name-keyed key-space, or the agent silently loses its (unrecoverable) token.
    h.state.agents = [{ ...baseAgent, providerId: 'codex', name: 'codex-hoot' }];
    h.state.repoAgents = null;
    const ws = fakeFs({ '.switch/agents/agent-id-1.json': credsJson('sw-1') });
    h.state.workspace = ws;

    await migrateAgentStorage();

    // Name-keyed file written via the unconditional neutral writer (not the
    // behavior hook, which does not exist for Codex), token preserved.
    expect(await ws.exists('.switch/agents/codex-hoot.json')).toBe(true);
    const written = JSON.parse((await ws.read('.switch/agents/codex-hoot.json')) as string);
    expect(written.env.SWITCH_API_TOKEN).toBe('tok-123');
    expect(written.env.SWITCH_AGENT_ID).toBe('sw-1');
    // Stale id-keyed file removed; no definition written (no behavior).
    expect(await ws.exists('.switch/agents/agent-id-1.json')).toBe(false);
    expect(h.writeDefinition).not.toHaveBeenCalled();
  });

  it('falls back to .claude/settings.local.json when no neutral file exists', async () => {
    const ws = fakeFs({
      '.claude/settings.local.json': credsJson('sw-1'),
      '.claude/agents/cc-hoot-main.md': '# def',
    });
    h.state.workspace = ws;

    await migrateAgentStorage();

    const written = JSON.parse((await ws.read('.switch/agents/cc-hoot-main.json')) as string);
    expect(written.env.SWITCH_AGENT_ID).toBe('sw-1');
  });

  it('does nothing when the name-keyed file already exists and the definition is present', async () => {
    // Observe the files themselves, not spies: the credential step goes through
    // the real `writeNeutralAgentSettingsFs`, so a spy on the behavior hook
    // cannot see it re-derive and rewrite the token on every boot.
    const seed = {
      '.switch/agents/cc-hoot-main.json': credsJson('sw-1'),
      '.claude/agents/cc-hoot-main.md': '# def',
    };
    const ws = fakeFs({ ...seed });
    h.state.workspace = ws;

    await migrateAgentStorage();

    for (const [path, content] of Object.entries(seed)) {
      expect(await ws.read(path)).toBe(content);
    }
    expect(h.writeDefinition).not.toHaveBeenCalled();
  });

  it('writes no credentials when none exist anywhere (unrecoverable token)', async () => {
    const ws = fakeFs({ '.claude/agents/cc-hoot-main.md': '# def' });
    h.state.workspace = ws;

    await migrateAgentStorage();

    expect(await ws.exists('.switch/agents/cc-hoot-main.json')).toBe(false);
  });

  it('skips the whole pass (no workspace opened) once the marker is set', async () => {
    h.isComplete.mockResolvedValueOnce(true);
    const resolveWorkspaceFsFor = (await import('./agent-workspace-fs')).resolveWorkspaceFsFor;

    await migrateAgentStorage();

    expect(resolveWorkspaceFsFor).not.toHaveBeenCalled();
    expect(h.markComplete).not.toHaveBeenCalled();
  });

  it('latches the marker after a clean pass', async () => {
    h.state.workspace = fakeFs({
      '.switch/agents/cc-hoot-main.json': credsJson('sw-1'),
      '.claude/agents/cc-hoot-main.md': '# def',
    });

    await migrateAgentStorage();

    expect(h.markComplete).toHaveBeenCalledTimes(1);
  });

  it('does not latch the marker when an agent migration throws', async () => {
    h.state.workspace = fakeFs({
      '.switch/agents/cc-hoot-main.json': credsJson('sw-1'),
      '.claude/agents/cc-hoot-main.md': '# def',
    });
    h.readDefinition.mockRejectedValueOnce(new Error('host unreachable'));

    await migrateAgentStorage();

    expect(h.markComplete).not.toHaveBeenCalled();
  });
});

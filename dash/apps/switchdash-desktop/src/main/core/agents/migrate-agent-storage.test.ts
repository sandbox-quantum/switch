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

/** The same file after the token has moved to the home-side store. */
function splitCredsJson(agentId: string): string {
  return JSON.stringify({
    env: {
      SWITCH_API_ENDPOINT: 'http://switch.example',
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
  const secretTokens = new Map<string, string>();
  const secrets = {
    tokens: secretTokens,
    read: (agentId: string) => Promise.resolve(secretTokens.get(agentId) ?? null),
    write: (agentId: string, token: string) => {
      secretTokens.set(agentId, token);
      return Promise.resolve();
    },
    delete: (agentId: string) => {
      secretTokens.delete(agentId);
      return Promise.resolve();
    },
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
    secrets,
    defaultRepoAgents,
    readLaunchEnv,
    readDefinition,
    writeDefinition,
    discoverLocal,
    updateAgent: vi.fn(async () => undefined),
    completedGeneration: vi.fn(async () => 0),
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
    secrets: h.secrets,
    close: () => {},
  })),
}));
vi.mock('./getAgents', () => ({ getAgents: vi.fn(async () => h.state.agents) }));
vi.mock('./updateAgent', () => ({ updateAgent: h.updateAgent }));
vi.mock('@main/core/switch-servers/gateway-client', () => ({ fetchAgentDetail: vi.fn() }));
vi.mock('@main/core/switch-servers/servers-store', () => ({ getServer: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./agent-storage-migration-marker', () => ({
  AGENT_STORAGE_MIGRATION_GENERATION: 3,
  completedAgentStorageMigrationGeneration: h.completedGeneration,
  markAgentStorageMigrationComplete: h.markComplete,
}));

import { log } from '@main/lib/logger';
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
    h.secrets.tokens.clear();
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
    // The token is recovered and relocated, not copied: it lands in the home
    // store and leaves the working tree behind it.
    expect(written.env.SWITCH_API_TOKEN).toBeUndefined();
    expect(h.secrets.tokens.get('sw-1')).toBe('tok-123');
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
    // behavior hook, which does not exist for Codex), token relocated.
    expect(await ws.exists('.switch/agents/codex-hoot.json')).toBe(true);
    const written = JSON.parse((await ws.read('.switch/agents/codex-hoot.json')) as string);
    expect(written.env.SWITCH_API_TOKEN).toBeUndefined();
    expect(h.secrets.tokens.get('sw-1')).toBe('tok-123');
    expect(written.env.SWITCH_AGENT_ID).toBe('sw-1');
    // Stale id-keyed file removed; no definition written (no behavior).
    expect(await ws.exists('.switch/agents/agent-id-1.json')).toBe(false);
    expect(h.writeDefinition).not.toHaveBeenCalled();
  });

  it('falls back to .claude/settings.local.json when its identity matches the Claude row', async () => {
    const ws = fakeFs({
      '.claude/settings.local.json': credsJson('sw-1'),
      '.claude/agents/cc-hoot-main.md': '# def',
    });
    h.state.workspace = ws;

    await migrateAgentStorage();

    const written = JSON.parse((await ws.read('.switch/agents/cc-hoot-main.json')) as string);
    expect(written.env.SWITCH_AGENT_ID).toBe('sw-1');
    expect(written.env.SWITCH_API_TOKEN).toBeUndefined();
    expect(h.secrets.tokens.get('sw-1')).toBe('tok-123');
    expect(written.env.SWITCH_API_ENDPOINT).toBe('http://switch.example');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('never reads .claude/settings.local.json for a provider without repo-agents', async () => {
    // The shared settings file is written only by provisionAgent /
    // provisionRemoteAgent, always as the Claude "main" agent, so for any other
    // provider it is a different agent's identity and token. Adopting it would
    // make the session launch AS that agent — a silent success where launching
    // unidentified is a visible failure.
    h.state.agents = [
      { ...baseAgent, providerId: 'codex', name: 'codex-hoot', switchAgentId: 'sw-codex' },
    ];
    h.state.repoAgents = null;
    const ws = fakeFs({ '.claude/settings.local.json': credsJson('sw-CLAUDE-MAIN') });
    const read = vi.spyOn(ws, 'read');
    h.state.workspace = ws;

    await migrateAgentStorage();

    expect(read).not.toHaveBeenCalledWith('.claude/settings.local.json');
    expect(await ws.exists('.switch/agents/codex-hoot.json')).toBe(false);
  });

  it('does not adopt .claude/settings.local.json for a provider without repo-agents when the row has no identity to compare', async () => {
    // A row with no `switchAgentId` has nothing to compare against, so the
    // behavior gate — not the identity cross-check — is what keeps the Claude
    // main agent's credentials out of this agent's file.
    h.state.agents = [
      { ...baseAgent, providerId: 'codex', name: 'codex-hoot', switchAgentId: null },
    ];
    h.state.repoAgents = null;
    const ws = fakeFs({ '.claude/settings.local.json': credsJson('sw-CLAUDE-MAIN') });
    h.state.workspace = ws;

    await migrateAgentStorage();

    expect(await ws.exists('.switch/agents/codex-hoot.json')).toBe(false);
  });

  it('skips visibly when .claude/settings.local.json names a different agent than the Claude row', async () => {
    // Multiple Claude agents can share a location; only one of them owns the
    // shared settings file. Adopting a mismatched identity is never right.
    const ws = fakeFs({
      '.claude/settings.local.json': credsJson('sw-other'),
      '.claude/agents/cc-hoot-main.md': '# def',
    });
    h.state.workspace = ws;

    await migrateAgentStorage();

    expect(await ws.exists('.switch/agents/cc-hoot-main.json')).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('different Switch agent'),
      expect.objectContaining({
        agentId: 'agent-id-1',
        agentName: 'cc-hoot-main',
        expectedSwitchAgentId: 'sw-1',
        foundSwitchAgentId: 'sw-other',
      })
    );
  });

  it('keeps a mismatched id-keyed neutral file instead of adopting or deleting it', async () => {
    // The token exists nowhere else, so a skip must not take the only copy with
    // it: without a name-keyed file the stale-file cleanup has to stay its hand.
    h.state.agents = [{ ...baseAgent, providerId: 'codex', name: 'codex-hoot' }];
    h.state.repoAgents = null;
    const ws = fakeFs({ '.switch/agents/agent-id-1.json': credsJson('sw-other') });
    h.state.workspace = ws;

    await migrateAgentStorage();

    expect(await ws.exists('.switch/agents/codex-hoot.json')).toBe(false);
    expect(await ws.read('.switch/agents/agent-id-1.json')).toBe(credsJson('sw-other'));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('different Switch agent'),
      expect.objectContaining({ foundSwitchAgentId: 'sw-other', providerId: 'codex' })
    );
  });

  it('does nothing when the name-keyed file is already split and the definition is present', async () => {
    // Observe the files themselves, not spies: the credential step goes through
    // the real `writeNeutralAgentSettingsFs`, so a spy on the behavior hook
    // cannot see it re-derive and rewrite the token on every boot.
    const seed = {
      '.switch/agents/cc-hoot-main.json': splitCredsJson('sw-1'),
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

  it('skips the whole pass (no workspace opened) once the current generation is latched', async () => {
    h.completedGeneration.mockResolvedValueOnce(3);
    const resolveWorkspaceFsFor = (await import('./agent-workspace-fs')).resolveWorkspaceFsFor;

    await migrateAgentStorage();

    expect(resolveWorkspaceFsFor).not.toHaveBeenCalled();
    expect(h.markComplete).not.toHaveBeenCalled();
  });

  it("opens a behavior provider's workspace on generation 3, which earlier generations skipped", async () => {
    // Generation 2 could skip a Claude agent, because it only broadened the
    // credential step to providers WITHOUT a behavior. Generation 3 cannot: the
    // token it relocates may be sitting in any agent's file, whatever its
    // provider, and nothing but the file itself can say whether it is.
    h.completedGeneration.mockResolvedValueOnce(1);
    const ws = fakeFs({
      '.switch/agents/cc-hoot-main.json': credsJson('sw-1'),
      '.claude/agents/cc-hoot-main.md': '# def',
    });
    h.state.workspace = ws;
    const resolveWorkspaceFsFor = (await import('./agent-workspace-fs')).resolveWorkspaceFsFor;

    await migrateAgentStorage();

    expect(resolveWorkspaceFsFor).toHaveBeenCalled();
    const written = JSON.parse((await ws.read('.switch/agents/cc-hoot-main.json')) as string);
    expect(written.env.SWITCH_API_TOKEN).toBeUndefined();
    expect(h.secrets.tokens.get('sw-1')).toBe('tok-123');
    expect(h.markComplete).toHaveBeenCalledTimes(1);
  });

  it('re-running for generation 2 still migrates a provider generation 1 skipped', async () => {
    h.completedGeneration.mockResolvedValueOnce(1);
    h.state.agents = [{ ...baseAgent, providerId: 'codex', name: 'codex-hoot' }];
    h.state.repoAgents = null;
    const ws = fakeFs({ '.switch/agents/agent-id-1.json': credsJson('sw-1') });
    h.state.workspace = ws;

    await migrateAgentStorage();

    expect(await ws.exists('.switch/agents/codex-hoot.json')).toBe(true);
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

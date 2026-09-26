import type { PluginFs } from '@switch-console/core/agents/plugins';
/**
 * An agent's configuration is its config file and nothing else (CHOO-2228):
 * reading it never writes, a missing file is an error rather than a blank
 * agent, and a change reaches whatever launches the agent's next session —
 * which, for an automatic session, is a launch spec built earlier.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setAgentProviderConfig = vi.hoisted(() => vi.fn(async (_params: unknown) => {}));
const ensureRemoteWatcher = vi.hoisted(() => vi.fn(async (_agentId: string) => {}));
const state = vi.hoisted(() => ({
  providerId: 'codex',
  providerConfig: null as unknown,
  autoSession: [] as string[],
  files: new Map<string, string>(),
  writes: [] as string[],
}));

const fakeFs = vi.hoisted(
  () => (): PluginFs => ({
    read: async (path: string) => state.files.get(path) ?? null,
    write: async (path: string, content: string) => {
      state.writes.push(path);
      state.files.set(path, content);
    },
    delete: async (path: string) => {
      state.files.delete(path);
    },
    exists: async (path: string) => state.files.has(path),
    list: async () => [],
  })
);

vi.mock('./getAgentById', () => ({
  getAgentById: async (agentId: string) => ({
    id: agentId,
    name: 'agent-one',
    providerId: state.providerId,
    providerConfig: state.providerConfig,
    locationId: 'loc-1',
  }),
}));
vi.mock('./agent-location', () => ({
  getAgentLocation: async () => ({ id: 'loc-1', dir: '/repo', sshHost: 'vm-1' }),
}));
vi.mock('./agent-workdir-fs', () => ({
  resolveWorkdirFsFor: async () => ({ fs: fakeFs(), close: () => {} }),
}));
vi.mock('./setAgentProviderConfig', () => ({
  setAgentProviderConfig: (params: unknown) => setAgentProviderConfig(params),
}));
vi.mock('./remote-watcher', () => ({
  ensureRemoteWatcher: (agentId: string) => ensureRemoteWatcher(agentId),
}));
vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@main/core/switch-rooms/auto-session-store', () => ({
  listAutoSessionAgentIds: async () => state.autoSession,
}));
vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: (id: string) => ({
    behavior:
      id === 'claude'
        ? { repoAgents: { launchDefinition: () => ({}) } }
        : { mcp: { launchProfileFields: () => [] } },
  }),
}));

import { readAgentInstructions, setAgentInstructions, setAgentSettings } from './agent-config';
import { AgentConfigMissingError, agentLaunchConfig } from './agent-launch-config';
import {
  isAgentUnmigrated,
  markAgentUnmigrated,
  setAgentStorageMigrationReady,
} from './agent-storage-migration-ready';

const CONFIG_PATH = '.switch/config/agent-one.json';

beforeEach(() => {
  setAgentProviderConfig.mockClear();
  ensureRemoteWatcher.mockClear();
  state.files.clear();
  state.writes = [];
  state.autoSession = [];
  state.providerId = 'codex';
  state.providerConfig = null;
  state.files.set(CONFIG_PATH, '{}\n');
  setAgentStorageMigrationReady(Promise.resolve());
});

describe('reading', () => {
  it('never writes', async () => {
    state.providerId = 'claude';
    state.files.set(CONFIG_PATH, JSON.stringify({ instructions: 'Be careful.' }));
    state.files.set('.claude/agents/agent-one.md', '---\nname: agent-one\n---\n\nStale.\n');

    expect(await readAgentInstructions('agent-1')).toBe('Be careful.');
    expect(state.writes).toEqual([]);
  });

  it('treats a missing config file as an error, not a blank agent', async () => {
    state.files.delete(CONFIG_PATH);

    await expect(readAgentInstructions('agent-1')).rejects.toBeInstanceOf(AgentConfigMissingError);
    expect(state.writes).toEqual([]);
  });

  it('waits for the boot migration before calling the file missing', async () => {
    state.files.delete(CONFIG_PATH);
    let finish = () => {};
    setAgentStorageMigrationReady(
      new Promise<void>((resolve) => {
        finish = () => {
          state.files.set(CONFIG_PATH, JSON.stringify({ instructions: 'Migrated.' }));
          resolve();
        };
      })
    );

    const read = readAgentInstructions('agent-1');
    finish();

    expect(await read).toBe('Migrated.');
  });
  it('reads after the boot migration, not before it', async () => {
    // The migration may be about to take over a hand edit to the old definition
    // file; reading first would show, and a save would keep, the value before it.
    state.files.set(CONFIG_PATH, JSON.stringify({ instructions: 'Old.' }));
    let finish = () => {};
    setAgentStorageMigrationReady(
      new Promise<void>((resolve) => {
        finish = () => {
          state.files.set(CONFIG_PATH, JSON.stringify({ instructions: 'Taken over.' }));
          resolve();
        };
      })
    );

    const read = readAgentInstructions('agent-1');
    finish();

    expect(await read).toBe('Taken over.');
  });

  it('migrates an agent the boot migration could not reach', async () => {
    // Its host was down at boot; it is reachable now, since this read got here.
    state.files.delete(CONFIG_PATH);
    state.providerConfig = {
      version: '2',
      providerId: 'codex',
      values: { instructions: 'From the row.' },
    };
    markAgentUnmigrated('agent-1');

    expect(await readAgentInstructions('agent-1')).toBe('From the row.');
    expect(isAgentUnmigrated('agent-1')).toBe(false);
  });
});

describe('saving', () => {
  it('refuses to save into an agent whose config file is missing', async () => {
    state.files.delete(CONFIG_PATH);

    await expect(
      setAgentInstructions({ agentId: 'agent-1', instructions: 'Be careful.' })
    ).rejects.toBeInstanceOf(AgentConfigMissingError);
    expect(state.writes).toEqual([]);
  });

  it('changes only what was saved', async () => {
    state.files.set(
      CONFIG_PATH,
      JSON.stringify({ description: 'Reviews', instructions: 'Old.', settings: { model: 'opus' } })
    );

    await setAgentInstructions({ agentId: 'agent-1', instructions: 'New.' });

    expect(JSON.parse(state.files.get(CONFIG_PATH) ?? '')).toEqual({
      description: 'Reviews',
      instructions: 'New.',
      settings: { model: 'opus' },
    });
    expect(state.writes).toEqual([CONFIG_PATH]);
  });

  it('rebuilds the launch profile for a provider that reads one', async () => {
    // Codex takes its instructions as a generated profile file, baked into the
    // remote launch spec. Without this the VM keeps the old prompt.
    await setAgentInstructions({ agentId: 'agent-1', instructions: 'Be careful.' });

    expect(setAgentProviderConfig).toHaveBeenCalledTimes(1);
    expect(setAgentProviderConfig.mock.calls[0]?.[0]).toMatchObject({
      agentId: 'agent-1',
      config: { values: { instructions: 'Be careful.' } },
    });
  });

  it('carries a cleared prompt through too, not just a set one', async () => {
    await setAgentInstructions({ agentId: 'agent-1', instructions: 'Be careful.' });
    setAgentProviderConfig.mockClear();

    await setAgentInstructions({ agentId: 'agent-1', instructions: '' });

    expect(setAgentProviderConfig).toHaveBeenCalledTimes(1);
    expect(setAgentProviderConfig.mock.calls[0]?.[0]).toMatchObject({
      agentId: 'agent-1',
      config: null,
    });
  });

  it('rebuilds the automatic-session spec for an agent that runs as a definition', async () => {
    // Claude Code gets its definition in the launch spec now, so an automatic
    // session would otherwise start on the previous one.
    state.providerId = 'claude';
    state.autoSession = ['agent-1'];

    await setAgentSettings({ agentId: 'agent-1', settings: { model: 'opus' } });

    expect(ensureRemoteWatcher).toHaveBeenCalledWith('agent-1');
    expect(setAgentProviderConfig).not.toHaveBeenCalled();
  });

  it('leaves the controller alone when automatic sessions are off', async () => {
    state.providerId = 'claude';

    await setAgentSettings({ agentId: 'agent-1', settings: { model: 'opus' } });

    expect(ensureRemoteWatcher).not.toHaveBeenCalled();
  });
});

describe('launching', () => {
  it('runs as a definition when the config describes the agent', async () => {
    state.providerId = 'claude';
    state.files.set(CONFIG_PATH, JSON.stringify({ description: 'Reviews diffs' }));

    expect((await agentLaunchConfig('agent-1')).definition).toBeDefined();
  });

  it('runs the provider as it is when the config says nothing', async () => {
    // As an agent with no definition file on disk always did, rather than as a
    // definition whose prompt is its own name.
    state.providerId = 'claude';

    expect((await agentLaunchConfig('agent-1')).definition).toBeUndefined();
  });
});

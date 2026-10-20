import type { PluginFs } from '@switch-console/core/agents/plugins';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentConfigRelativePath, agentSettingsRelativePath } from './switch-settings-paths';

function fakeFs(seed: Record<string, string> = {}): PluginFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    read: async (p) => files.get(p) ?? null,
    write: async (p, c) => void files.set(p, c),
    delete: async (p) => void files.delete(p),
    exists: async (p) => files.has(p),
    list: async () => [...files.keys()],
  };
}

const h = vi.hoisted(() => ({
  state: {
    fs: null as unknown as PluginFs,
    agent: null as Record<string, unknown> | null,
    nameTaken: false,
    repoAgents: null as object | null,
  },
  updatedRows: [] as Record<string, unknown>[],
  emit: vi.fn(),
  ensureRemoteWatcher: vi.fn(async () => {}),
  removeAgentLaunchProfile: vi.fn(async () => {}),
}));

vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: () => ({ behavior: { repoAgents: h.state.repoAgents } }),
}));
vi.mock('./agent-workdir-fs', () => ({
  resolveWorkdirFsFor: vi.fn(async () => ({ fs: h.state.fs, close: vi.fn() })),
}));
vi.mock('./agent-location', () => ({
  getAgentLocation: vi.fn(async () => ({ sshHost: null, dir: '/repo' })),
}));
vi.mock('./getAgentById', () => ({ getAgentById: vi.fn(async () => h.state.agent) }));
vi.mock('./agent-name-taken', () => ({ agentNameTaken: vi.fn(async () => h.state.nameTaken) }));
vi.mock('./agent-events', () => ({ agentEvents: { _emit: h.emit } }));
vi.mock('./remote-watcher', () => ({ ensureRemoteWatcher: h.ensureRemoteWatcher }));
vi.mock('./remove-launch-profile', () => ({
  removeAgentLaunchProfile: h.removeAgentLaunchProfile,
}));
vi.mock('./utils', () => ({ mapAgentRow: vi.fn(async (row: unknown) => row) }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@main/db/schema', () => ({ agents: { id: 'id' } }));
vi.mock('@main/db/client', () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            const row = { ...h.state.agent, ...values };
            h.updatedRows.push(row);
            return [row];
          },
        }),
      }),
    }),
  },
}));

const { renameLocalAgent, RenameLocalAgentFailed } = await import('./renameAgent');

const OURS = JSON.stringify({
  env: { SWITCH_API_ENDPOINT: 'https://ours', SWITCH_API_TOKEN: 'tok-1', SWITCH_AGENT_ID: 'sw-1' },
});
const THEIRS = JSON.stringify({
  env: {
    SWITCH_API_ENDPOINT: 'https://theirs',
    SWITCH_API_TOKEN: 'tok-2',
    SWITCH_AGENT_ID: 'sw-2',
  },
});

describe('renameLocalAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.updatedRows.length = 0;
    h.state.agent = { id: 'agent-1', name: 'notes-taker', providerId: 'claude', locationId: 'loc' };
    h.state.nameTaken = false;
    h.state.repoAgents = null;
  });

  it('moves the credentials and config to the new name and renames the row', async () => {
    const fs = fakeFs({
      [agentSettingsRelativePath('notes-taker')]: OURS,
      [agentConfigRelativePath('notes-taker')]: '{"instructions":"Take notes"}',
    });
    h.state.fs = fs;

    const renamed = await renameLocalAgent({ agentId: 'agent-1', newName: 'meeting-scribe' });

    expect(renamed.name).toBe('meeting-scribe');
    expect(fs.files.get(agentSettingsRelativePath('meeting-scribe'))).toBe(OURS);
    expect(fs.files.get(agentConfigRelativePath('meeting-scribe'))).toBe(
      '{"instructions":"Take notes"}'
    );
    expect(fs.files.has(agentSettingsRelativePath('notes-taker'))).toBe(false);
    expect(fs.files.has(agentConfigRelativePath('notes-taker'))).toBe(false);
    expect(h.removeAgentLaunchProfile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'notes-taker' }),
      expect.anything(),
      'notes-taker'
    );
    expect(h.ensureRemoteWatcher).toHaveBeenCalledWith('agent-1');
    expect(h.emit).toHaveBeenCalledWith(
      'agent:updated',
      expect.objectContaining({ name: 'meeting-scribe' })
    );
  });

  it('moves a provider definition to the new name', async () => {
    const definitions = new Map<string, Record<string, unknown>>([
      ['notes-taker', { name: 'notes-taker', model: 'opus' }],
    ]);
    h.state.repoAgents = {
      readDefinition: async (_fs: PluginFs, name: string) => definitions.get(name) ?? null,
      writeDefinition: async (_fs: PluginFs, def: { name: string }) =>
        void definitions.set(def.name, def),
      removeLocal: async (_fs: PluginFs, name: string) => void definitions.delete(name),
    };
    h.state.fs = fakeFs({ [agentSettingsRelativePath('notes-taker')]: OURS });

    await renameLocalAgent({ agentId: 'agent-1', newName: 'meeting-scribe' });

    expect([...definitions.keys()]).toEqual(['meeting-scribe']);
    expect(definitions.get('meeting-scribe')).toEqual({ name: 'meeting-scribe', model: 'opus' });
  });

  it('refuses a name another agent here already has, before changing anything', async () => {
    h.state.nameTaken = true;
    const fs = fakeFs({ [agentSettingsRelativePath('notes-taker')]: OURS });
    h.state.fs = fs;

    await expect(
      renameLocalAgent({ agentId: 'agent-1', newName: 'meeting-scribe' })
    ).rejects.toBeInstanceOf(RenameLocalAgentFailed);

    expect(h.updatedRows).toEqual([]);
    expect(fs.files.has(agentSettingsRelativePath('notes-taker'))).toBe(true);
  });

  it('refuses when the new name’s credentials belong to another Switch server', async () => {
    const fs = fakeFs({
      [agentSettingsRelativePath('notes-taker')]: OURS,
      [agentSettingsRelativePath('meeting-scribe')]: THEIRS,
    });
    h.state.fs = fs;

    await expect(
      renameLocalAgent({ agentId: 'agent-1', newName: 'meeting-scribe' })
    ).rejects.toThrow(/https:\/\/theirs/);

    expect(h.updatedRows).toEqual([]);
    expect(fs.files.get(agentSettingsRelativePath('meeting-scribe'))).toBe(THEIRS);
  });

  it('does nothing for the same name', async () => {
    h.state.fs = fakeFs();

    const same = await renameLocalAgent({ agentId: 'agent-1', newName: 'notes-taker' });

    expect(same.name).toBe('notes-taker');
    expect(h.updatedRows).toEqual([]);
  });

  it('says the agent is gone when it no longer exists', async () => {
    h.state.agent = null;
    h.state.fs = fakeFs();

    await expect(
      renameLocalAgent({ agentId: 'agent-1', newName: 'meeting-scribe' })
    ).rejects.toThrow(/no longer exists/);
  });
});

import type { PluginFs } from '@switchdash/core/agents/plugins';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSettingsRelativePath } from '@main/core/agents/switch-settings-paths';
import { parseSwitchAgentCredentials, readAgentSwitchEnvFromFs } from './switch-credentials';

const log = { warn: vi.fn() };

function credsJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    env: {
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_API_TOKEN: 'tok-123',
      SWITCH_AGENT_ID: 'sw-1',
      ...overrides,
    },
  });
}

function memoryFs(files: Record<string, string> = {}): PluginFs {
  const store = new Map(Object.entries(files));
  return {
    read: async (p) => store.get(p) ?? null,
    write: async (p, c) => void store.set(p, c),
    delete: async (p) => void store.delete(p),
    exists: async (p) => store.has(p),
    list: async () => [...store.keys()],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseSwitchAgentCredentials', () => {
  it('parses a complete env block', () => {
    expect(parseSwitchAgentCredentials(credsJson(), log)).toEqual({
      apiEndpoint: 'https://switch.example.com',
      token: 'tok-123',
      agentId: 'sw-1',
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('treats an absent file as "not provisioned here", without warning', () => {
    // The migration probes several candidate paths per agent; a missing one is
    // the ordinary answer, not a malformed file.
    expect(parseSwitchAgentCredentials(null, log)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns and returns null for text it cannot parse', () => {
    expect(parseSwitchAgentCredentials('{', log)).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('returns null without warning when a value is missing or blank', () => {
    expect(parseSwitchAgentCredentials(credsJson({ SWITCH_API_TOKEN: '  ' }), log)).toBeNull();
    expect(parseSwitchAgentCredentials(JSON.stringify({}), log)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('readAgentSwitchEnvFromFs', () => {
  it('reads the slug-keyed neutral file and returns it as launch env', async () => {
    const fs = memoryFs({ [agentSettingsRelativePath('codex-hoot')]: credsJson() });

    expect(await readAgentSwitchEnvFromFs(fs, 'codex-hoot', log)).toEqual({
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_API_TOKEN: 'tok-123',
      SWITCH_AGENT_ID: 'sw-1',
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns when the agent has no neutral file, rather than launching quietly unidentified', async () => {
    // Only Claude recovers from an empty env (it reads settings.local.json
    // natively); every other provider silently authenticates as nobody, so the
    // miss has to be visible in the log.
    expect(await readAgentSwitchEnvFromFs(memoryFs(), 'codex-hoot', log)).toEqual({});
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('no Switch identity'),
      expect.objectContaining({ slug: 'codex-hoot', path: '.switch/agents/codex-hoot.json' })
    );
  });

  it('warns when the file exists but its credential block is incomplete', async () => {
    const fs = memoryFs({ [agentSettingsRelativePath('codex-hoot')]: JSON.stringify({ env: {} }) });

    expect(await readAgentSwitchEnvFromFs(fs, 'codex-hoot', log)).toEqual({});
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('no Switch identity'),
      expect.objectContaining({ slug: 'codex-hoot' })
    );
  });
});

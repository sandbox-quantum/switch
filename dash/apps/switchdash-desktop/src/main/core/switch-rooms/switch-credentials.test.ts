import type { PluginFs } from '@switchdash/core/agents/plugins';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSettingsRelativePath } from '@main/core/agents/switch-settings-paths';
import {
  parseSwitchAgentCredentials,
  parseSwitchAgentIdentity,
  readAgentSwitchEnvFromFs,
  withAgentSecret,
} from './switch-credentials';

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

describe('the split credential file', () => {
  /** The neutral file as written since CHOO-1962: identity, no token. */
  const splitJson = JSON.stringify({
    env: { SWITCH_API_ENDPOINT: 'https://switch.example.com', SWITCH_AGENT_ID: 'sw-1' },
  });

  function fakeSecrets(seed: Record<string, string> = {}) {
    const tokens = new Map(Object.entries(seed));
    return {
      read: async (agentId: string) => tokens.get(agentId) ?? null,
      write: async (agentId: string, token: string) => void tokens.set(agentId, token),
      delete: async (agentId: string) => void tokens.delete(agentId),
    };
  }

  it('reads as a complete identity, not as an incomplete credential set', async () => {
    // `parseSwitchAgentCredentials` demands a token and so reads this file as
    // nothing at all — which is why the callers that only need an endpoint, like
    // the remote preflight, had to move off it.
    expect(parseSwitchAgentCredentials(splitJson, log)).toBeNull();
    expect(parseSwitchAgentIdentity(splitJson, log)).toEqual({
      agentId: 'sw-1',
      apiEndpoint: 'https://switch.example.com',
      token: null,
    });
  });

  it('yields launch env without a token, which withAgentSecret then supplies', async () => {
    const fs = memoryFs({ [agentSettingsRelativePath('codex-hoot')]: splitJson });

    const env = await readAgentSwitchEnvFromFs(fs, 'codex-hoot', log);
    expect(env).toEqual({
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_AGENT_ID: 'sw-1',
    });
    expect(log.warn).not.toHaveBeenCalled();

    expect(await withAgentSecret(env, fakeSecrets({ 'sw-1': 'tok-abc' }), log)).toEqual({
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_AGENT_ID: 'sw-1',
      SWITCH_API_TOKEN: 'tok-abc',
    });
  });

  it('leaves a token already in the env alone, so a pre-migration file still works', async () => {
    const env = {
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_AGENT_ID: 'sw-1',
      SWITCH_API_TOKEN: 'tok-inline',
    };

    expect(await withAgentSecret(env, fakeSecrets({ 'sw-1': 'tok-stored' }), log)).toEqual(env);
  });

  it('warns rather than launching unidentified when no secret is stored', async () => {
    const env = {
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_AGENT_ID: 'sw-1',
    };

    expect(await withAgentSecret(env, fakeSecrets(), log)).toEqual(env);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('no stored secret'),
      expect.objectContaining({ agentId: 'sw-1' })
    );
  });
});

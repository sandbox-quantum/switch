import type { PluginFs } from '@switch-console/core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { removeSwitchCredentials } from './remove-switch-settings';
import { mergeSwitchSettings } from './write-switch-settings';

const SETTINGS_PATH = '.claude/settings.local.json';

/** An in-memory PluginFs backed by a Map, enough for the default teardown path. */
function fakeFs(initial: Record<string, string>): PluginFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    read: (p: string) => Promise.resolve(files.get(p) ?? null),
    write: (p: string, content: string) => {
      files.set(p, content);
      return Promise.resolve();
    },
    delete: (p: string) => {
      files.delete(p);
      return Promise.resolve();
    },
    exists: (p: string) => Promise.resolve(files.has(p)),
    list: () => Promise.resolve([]),
  };
}

// The claude provider declares no switchSetup behavior, so it exercises the
// default `.claude/settings.local.json` reverse-merge path.
describe('removeSwitchCredentials (default .claude teardown)', () => {
  it('deletes a settings file that held only provisioned Switch credentials', async () => {
    const fs = fakeFs({
      [SETTINGS_PATH]: mergeSwitchSettings(null, {
        apiEndpoint: 'https://switch.example.com',
        agentId: 'agent-123',
      }),
    });

    await removeSwitchCredentials('claude', fs);

    expect(fs.files.has(SETTINGS_PATH)).toBe(false);
  });

  it('preserves the user’s own keys, stripping only the Switch block', async () => {
    const fs = fakeFs({
      [SETTINGS_PATH]: JSON.stringify({
        permissions: { allow: ['Bash', 'mcp__plugin_switch-connector_switch'] },
        env: {
          EDITOR: 'vim',
          SWITCH_API_ENDPOINT: 'e',
          SWITCH_API_TOKEN: 't',
          SWITCH_AGENT_ID: 'a',
        },
      }),
    });

    await removeSwitchCredentials('claude', fs);

    const parsed = JSON.parse(fs.files.get(SETTINGS_PATH)!) as Record<string, unknown>;
    expect(parsed.env).toEqual({ EDITOR: 'vim' });
    expect(parsed.permissions).toEqual({ allow: ['Bash'] });
  });

  it('leaves a file that is not a provisioned Switch agent untouched', async () => {
    const original = JSON.stringify({ env: { EDITOR: 'vim' } });
    const fs = fakeFs({ [SETTINGS_PATH]: original });

    await removeSwitchCredentials('claude', fs);

    expect(fs.files.get(SETTINGS_PATH)).toBe(original);
  });

  it('is a no-op when there is no settings file', async () => {
    const fs = fakeFs({});
    await expect(removeSwitchCredentials('claude', fs)).resolves.toBeUndefined();
    expect(fs.files.size).toBe(0);
  });
});

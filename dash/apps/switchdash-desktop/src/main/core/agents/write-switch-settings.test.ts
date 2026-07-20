import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectSwitchAgent } from './detect';
import { SWITCH_SETTINGS_RELATIVE_PATH } from './switch-settings-paths';
import { mergeSwitchApiEndpoint, writeSwitchSettings } from './write-switch-settings';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'switchdash-settings-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function readSettings(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(dir, SWITCH_SETTINGS_RELATIVE_PATH), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('writeSwitchSettings', () => {
  it('creates .claude/settings.local.json with the SWITCH_* env block', async () => {
    await writeSwitchSettings({
      dir,
      apiEndpoint: 'https://switch.example.com',
      apiToken: 'secret-token',
      agentId: 'agent-123',
    });

    const settings = await readSettings();
    expect(settings.env).toEqual({
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_API_TOKEN: 'secret-token',
      SWITCH_AGENT_ID: 'agent-123',
    });
    // The Switch connector tools are auto-approved ("don't ask").
    expect(settings.permissions).toEqual({
      allow: ['mcp__plugin_switch-connector_switch', 'mcp__plugin_switch-connector_switch-channel'],
    });

    // The detector should now recognise the directory as a configured agent.
    const detected = await detectSwitchAgent(dir);
    expect(detected).toEqual({
      agentId: 'agent-123',
      apiEndpoint: 'https://switch.example.com',
      dir,
    });
  });

  it('merges into an existing file, preserving unrelated keys and env entries', async () => {
    const claudeDir = path.join(dir, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(dir, SWITCH_SETTINGS_RELATIVE_PATH),
      JSON.stringify({
        permissions: { allow: ['Bash'] },
        env: { EXISTING_KEY: 'keep-me', SWITCH_API_TOKEN: 'old' },
      }),
      'utf8'
    );

    await writeSwitchSettings({
      dir,
      apiEndpoint: 'https://switch.example.com',
      apiToken: 'new-token',
      agentId: 'agent-999',
    });

    const settings = await readSettings();
    // Existing allow rules are preserved; the Switch rules are unioned in.
    expect(settings.permissions).toEqual({
      allow: [
        'Bash',
        'mcp__plugin_switch-connector_switch',
        'mcp__plugin_switch-connector_switch-channel',
      ],
    });
    expect(settings.env).toEqual({
      EXISTING_KEY: 'keep-me',
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_API_TOKEN: 'new-token',
      SWITCH_AGENT_ID: 'agent-999',
    });
  });
});

describe('mergeSwitchApiEndpoint', () => {
  it('rewrites only SWITCH_API_ENDPOINT, preserving token, id, and other keys', () => {
    const existing = JSON.stringify({
      permissions: { allow: ['Bash'] },
      hooks: { PostToolUse: [{ command: 'x' }] },
      env: {
        EXISTING_KEY: 'keep-me',
        SWITCH_API_ENDPOINT: 'https://old.example.com',
        SWITCH_API_TOKEN: 'secret-token',
        SWITCH_AGENT_ID: 'agent-123',
      },
    });

    const merged = mergeSwitchApiEndpoint(existing, 'https://new.example.com');
    expect(merged).not.toBeNull();
    const parsed = JSON.parse(merged as string) as Record<string, unknown>;

    // Endpoint changed; token, id, and every other key untouched.
    expect(parsed.env).toEqual({
      EXISTING_KEY: 'keep-me',
      SWITCH_API_ENDPOINT: 'https://new.example.com',
      SWITCH_API_TOKEN: 'secret-token',
      SWITCH_AGENT_ID: 'agent-123',
    });
    expect(parsed.permissions).toEqual({ allow: ['Bash'] });
    expect(parsed.hooks).toEqual({ PostToolUse: [{ command: 'x' }] });
  });

  it('returns null for a file that is not a provisioned Switch agent', () => {
    // Absent file.
    expect(mergeSwitchApiEndpoint(null, 'https://new.example.com')).toBeNull();
    // Unparseable.
    expect(mergeSwitchApiEndpoint('{not json', 'https://new.example.com')).toBeNull();
    // No env block.
    expect(mergeSwitchApiEndpoint('{}', 'https://new.example.com')).toBeNull();
    // Partial creds (no token) -> not provisioned, skip rather than half-write.
    expect(
      mergeSwitchApiEndpoint(
        JSON.stringify({ env: { SWITCH_API_ENDPOINT: 'https://old', SWITCH_AGENT_ID: 'a' } }),
        'https://new.example.com'
      )
    ).toBeNull();
  });
});

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import { detectSwitchAgent } from './detect';
import {
  agentSettingsRelativePath,
  SWITCH_AGENTS_GITIGNORE_RELATIVE,
  SWITCH_SETTINGS_RELATIVE_PATH,
} from './switch-settings-paths';
import {
  mergeSwitchApiEndpoint,
  mergeSwitchSettings,
  removeSwitchSettings,
  writeAgentNeutralSettings,
  writeNeutralAgentSettingsFs,
  writeSwitchSettings,
} from './write-switch-settings';

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
      allow: ['mcp__plugin_switch-connector_switch'],
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
      allow: ['Bash', 'mcp__plugin_switch-connector_switch'],
    });
    expect(settings.env).toEqual({
      EXISTING_KEY: 'keep-me',
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_API_TOKEN: 'new-token',
      SWITCH_AGENT_ID: 'agent-999',
    });
  });
});

/** An in-memory stand-in for the home-side secret store. */
function fakeSecrets() {
  const tokens = new Map<string, string>();
  return {
    tokens,
    store: {
      read: async (agentId: string) => tokens.get(agentId) ?? null,
      write: async (agentId: string, token: string) => void tokens.set(agentId, token),
      delete: async (agentId: string) => void tokens.delete(agentId),
    },
  };
}

describe('writeNeutralAgentSettingsFs', () => {
  it('keeps the identity in the working tree and puts the token in the home store', async () => {
    const secrets = fakeSecrets();
    await writeNeutralAgentSettingsFs(createPluginFs(dir), secrets.store, {
      slug: 'agent-abc',
      apiEndpoint: 'https://switch.example.com',
      apiToken: 'secret-token',
      agentId: 'switch-agent-1',
    });

    const raw = await fs.readFile(path.join(dir, agentSettingsRelativePath('agent-abc')), 'utf8');
    const settings = JSON.parse(raw) as Record<string, unknown>;
    // Endpoint and id are not secrets and stay: the file doubles as the settings
    // file Claude Code is launched with.
    expect(settings.env).toEqual({
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_AGENT_ID: 'switch-agent-1',
    });
    expect(raw).not.toContain('secret-token');
    expect(secrets.tokens.get('switch-agent-1')).toBe('secret-token');

    const ignore = await fs.readFile(path.join(dir, SWITCH_AGENTS_GITIGNORE_RELATIVE), 'utf8');
    expect(ignore).toBe('*\n');
  });

  it('strips a token left in a file written before the split', async () => {
    const relPath = agentSettingsRelativePath('agent-abc');
    await fs.mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
    await fs.writeFile(
      path.join(dir, relPath),
      JSON.stringify({
        permissions: { allow: ['Bash'] },
        env: { EXISTING: 'keep', SWITCH_API_TOKEN: 'old' },
      }),
      'utf8'
    );

    const secrets = fakeSecrets();
    await writeNeutralAgentSettingsFs(createPluginFs(dir), secrets.store, {
      slug: 'agent-abc',
      apiEndpoint: 'https://switch.example.com',
      apiToken: 'new-token',
      agentId: 'switch-agent-1',
    });

    const settings = JSON.parse(await fs.readFile(path.join(dir, relPath), 'utf8')) as Record<
      string,
      unknown
    >;
    // A merge would carry `SWITCH_API_TOKEN: 'old'` forward and defeat the split.
    expect(settings.env).toEqual({
      EXISTING: 'keep',
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_AGENT_ID: 'switch-agent-1',
    });
    // The connector's MCP tools are auto-approved on top of whatever the agent
    // already allowed, so a Switch agent never has to ask to reach its room.
    expect(settings.permissions).toEqual({
      allow: ['Bash', 'mcp__plugin_switch-connector_switch'],
    });
  });

  it('writes the secret before the file that names it', async () => {
    // The reverse order would leave a file claiming an identity whose token
    // never landed; this way a failure leaves an unreferenced secret, which is
    // inert.
    const order: string[] = [];
    const recordingFs = createPluginFs(dir);
    const write = recordingFs.write.bind(recordingFs);
    recordingFs.write = async (p, c) => {
      order.push(p);
      return write(p, c);
    };
    const secrets = fakeSecrets();
    const recordingSecrets = {
      ...secrets.store,
      write: async (agentId: string, token: string) => {
        order.push('secret');
        return secrets.store.write(agentId, token);
      },
    };

    await writeNeutralAgentSettingsFs(recordingFs, recordingSecrets, {
      slug: 'agent-abc',
      apiEndpoint: 'https://switch.example.com',
      apiToken: 'secret-token',
      agentId: 'switch-agent-1',
    });

    expect(order).toEqual([
      'secret',
      SWITCH_AGENTS_GITIGNORE_RELATIVE,
      agentSettingsRelativePath('agent-abc'),
    ]);
  });
});

describe('writeAgentNeutralSettings', () => {
  it('produces the same file as the PluginFs writer, for a plain directory path', async () => {
    const secrets = fakeSecrets();
    await writeAgentNeutralSettings(secrets.store, {
      dir,
      slug: 'agent-abc',
      apiEndpoint: 'https://switch.example.com',
      apiToken: 'secret-token',
      agentId: 'switch-agent-1',
    });

    const raw = await fs.readFile(path.join(dir, agentSettingsRelativePath('agent-abc')), 'utf8');
    expect((JSON.parse(raw) as { env: Record<string, string> }).env).toEqual({
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_AGENT_ID: 'switch-agent-1',
    });
    expect(secrets.tokens.get('switch-agent-1')).toBe('secret-token');
    expect(await fs.readFile(path.join(dir, SWITCH_AGENTS_GITIGNORE_RELATIVE), 'utf8')).toBe('*\n');
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

describe('removeSwitchSettings', () => {
  it('round-trips a freshly provisioned file to deletion', () => {
    // A file written by mergeSwitchSettings with no pre-existing content is ours
    // alone, so tearing it down should leave nothing behind.
    const provisioned = mergeSwitchSettings(null, {
      apiEndpoint: 'https://switch.example.com',
      apiToken: 'secret-token',
      agentId: 'agent-123',
    });

    expect(removeSwitchSettings(provisioned)).toEqual({ kind: 'delete' });
  });

  it('strips only the SWITCH_* keys and connector rules, preserving everything else', () => {
    const existing = JSON.stringify({
      permissions: { allow: ['Bash', 'mcp__plugin_switch-connector_switch'], deny: ['Read'] },
      hooks: { PostToolUse: [{ command: 'x' }] },
      env: {
        EXISTING_KEY: 'keep-me',
        SWITCH_API_ENDPOINT: 'https://switch.example.com',
        SWITCH_API_TOKEN: 'secret-token',
        SWITCH_AGENT_ID: 'agent-123',
      },
    });

    const result = removeSwitchSettings(existing);
    expect(result.kind).toBe('write');
    const parsed = JSON.parse((result as { content: string }).content) as Record<string, unknown>;

    // Our env keys are gone; the user's stays.
    expect(parsed.env).toEqual({ EXISTING_KEY: 'keep-me' });
    // The connector allow rule is removed; the user's allow/deny rules stay.
    expect(parsed.permissions).toEqual({ allow: ['Bash'], deny: ['Read'] });
    // Unrelated keys are untouched.
    expect(parsed.hooks).toEqual({ PostToolUse: [{ command: 'x' }] });
  });

  it('drops now-empty env and permissions blocks but keeps other keys', () => {
    const existing = JSON.stringify({
      hooks: { PostToolUse: [{ command: 'x' }] },
      permissions: {
        allow: [
          'mcp__plugin_switch-connector_switch',
          'mcp__plugin_switch-connector_switch-channel',
        ],
      },
      env: { SWITCH_API_ENDPOINT: 'e', SWITCH_API_TOKEN: 't', SWITCH_AGENT_ID: 'a' },
    });

    const result = removeSwitchSettings(existing);
    expect(result.kind).toBe('write');
    const parsed = JSON.parse((result as { content: string }).content) as Record<string, unknown>;

    // Both blocks held only our contributions — including the retired
    // switch-channel rule an older switchdash wrote — so both are dropped.
    expect(parsed).toEqual({ hooks: { PostToolUse: [{ command: 'x' }] } });
    expect('env' in parsed).toBe(false);
    expect('permissions' in parsed).toBe(false);
  });

  it('skips files that are not a provisioned Switch agent', () => {
    // Absent file.
    expect(removeSwitchSettings(null)).toEqual({ kind: 'skip' });
    // Unparseable.
    expect(removeSwitchSettings('{not json')).toEqual({ kind: 'skip' });
    // Empty object.
    expect(removeSwitchSettings('{}')).toEqual({ kind: 'skip' });
    // A real config with no Switch creds -> leave it untouched.
    expect(removeSwitchSettings(JSON.stringify({ env: { OTHER: 'x' } }))).toEqual({ kind: 'skip' });
  });

  it('tears down even a partially-provisioned file (only some SWITCH_* keys)', () => {
    // Defensive: if a write was interrupted and only the token survived, teardown
    // must still remove it rather than leaving a dangling secret.
    const existing = JSON.stringify({ env: { SWITCH_API_TOKEN: 'secret-token' } });
    expect(removeSwitchSettings(existing)).toEqual({ kind: 'delete' });
  });

  it('leaves the directory undetectable as a Switch agent after teardown', async () => {
    await writeSwitchSettings({
      dir,
      apiEndpoint: 'https://switch.example.com',
      apiToken: 'secret-token',
      agentId: 'agent-123',
    });
    const raw = await fs.readFile(path.join(dir, SWITCH_SETTINGS_RELATIVE_PATH), 'utf8');

    const result = removeSwitchSettings(raw);
    // The file was ours alone -> delete it, which makes the dir undetectable.
    expect(result).toEqual({ kind: 'delete' });
    await fs.rm(path.join(dir, SWITCH_SETTINGS_RELATIVE_PATH), { force: true });

    expect(await detectSwitchAgent(dir)).toBeNull();
  });
});

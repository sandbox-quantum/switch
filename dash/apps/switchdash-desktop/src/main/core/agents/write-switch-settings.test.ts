import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import {
  agentSettingsRelativePath,
  SWITCH_AGENTS_GITIGNORE_RELATIVE,
} from './switch-settings-paths';
import {
  mergeSwitchApiEndpoint,
  writeAgentNeutralSettings,
  writeNeutralAgentSettingsFs,
} from './write-switch-settings';

let dir: string;

beforeEach(async () => {
  dir = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'switchdash-settings-'));
});

afterEach(async () => {
  await nodeFs.rm(dir, { recursive: true, force: true });
});

describe('writeNeutralAgentSettingsFs', () => {
  it('writes the provider-neutral per-agent creds keyed by slug, with a gitignore', async () => {
    await writeNeutralAgentSettingsFs(createPluginFs(dir), {
      slug: 'agent-abc',
      apiEndpoint: 'https://switch.example.com',
      apiToken: 'secret-token',
      agentId: 'switch-agent-1',
    });

    const raw = await nodeFs.readFile(
      path.join(dir, agentSettingsRelativePath('agent-abc')),
      'utf8'
    );
    const settings = JSON.parse(raw) as Record<string, unknown>;
    expect(settings.env).toEqual({
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_API_TOKEN: 'secret-token',
      SWITCH_AGENT_ID: 'switch-agent-1',
    });

    // The credentials directory is git-ignored so the token never enters VCS.
    const ignore = await nodeFs.readFile(path.join(dir, SWITCH_AGENTS_GITIGNORE_RELATIVE), 'utf8');
    expect(ignore).toBe('*\n');
  });

  it('merges into an existing per-agent file, preserving unrelated env keys and allow rules', async () => {
    const relPath = agentSettingsRelativePath('agent-abc');
    await nodeFs.mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
    await nodeFs.writeFile(
      path.join(dir, relPath),
      JSON.stringify({
        permissions: { allow: ['Bash'] },
        env: { EXISTING: 'keep', SWITCH_API_TOKEN: 'old' },
      }),
      'utf8'
    );

    await writeNeutralAgentSettingsFs(createPluginFs(dir), {
      slug: 'agent-abc',
      apiEndpoint: 'https://switch.example.com',
      apiToken: 'new-token',
      agentId: 'switch-agent-1',
    });

    const settings = JSON.parse(await nodeFs.readFile(path.join(dir, relPath), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(settings.env).toEqual({
      EXISTING: 'keep',
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_API_TOKEN: 'new-token',
      SWITCH_AGENT_ID: 'switch-agent-1',
    });
    // The connector's MCP tools are auto-approved on top of whatever the agent
    // already allowed, so a Switch agent never has to ask to reach its room.
    expect(settings.permissions).toEqual({
      allow: ['Bash', 'mcp__plugin_switch-connector_switch'],
    });
  });

  it('writes the gitignore before the token file, so a crash never leaves a tracked token', async () => {
    const writes: string[] = [];
    const recordingFs = createPluginFs(dir);
    const write = recordingFs.write.bind(recordingFs);
    recordingFs.write = async (p, c) => {
      writes.push(p);
      return write(p, c);
    };

    await writeNeutralAgentSettingsFs(recordingFs, {
      slug: 'agent-abc',
      apiEndpoint: 'https://switch.example.com',
      apiToken: 'secret-token',
      agentId: 'switch-agent-1',
    });

    expect(writes).toEqual([
      SWITCH_AGENTS_GITIGNORE_RELATIVE,
      agentSettingsRelativePath('agent-abc'),
    ]);
  });
});

describe('writeAgentNeutralSettings', () => {
  it('produces the same file as the PluginFs writer, for a plain directory path', async () => {
    await writeAgentNeutralSettings({
      dir,
      slug: 'agent-abc',
      apiEndpoint: 'https://switch.example.com',
      apiToken: 'secret-token',
      agentId: 'switch-agent-1',
    });

    const raw = await nodeFs.readFile(
      path.join(dir, agentSettingsRelativePath('agent-abc')),
      'utf8'
    );
    expect((JSON.parse(raw) as { env: Record<string, string> }).env).toEqual({
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_API_TOKEN: 'secret-token',
      SWITCH_AGENT_ID: 'switch-agent-1',
    });
    expect(await nodeFs.readFile(path.join(dir, SWITCH_AGENTS_GITIGNORE_RELATIVE), 'utf8')).toBe(
      '*\n'
    );
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

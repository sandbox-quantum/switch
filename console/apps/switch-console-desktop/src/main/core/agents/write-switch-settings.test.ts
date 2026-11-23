import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PluginFs } from '@switch-console/core/agents/plugins';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import { detectSwitchAgent } from './detect';
import { localGitIgnoreCheck } from './git-ignore-check';
import {
  agentSettingsRelativePath,
  SWITCH_AGENTS_GITIGNORE_RELATIVE,
  SWITCH_SETTINGS_RELATIVE_PATH,
} from './switch-settings-paths';
import {
  ExistingAgentCredentialsError,
  ForeignAgentCredentialsError,
  foreignCredentialsEndpoint,
  foreignCredentialsOwnerFs,
  holdsSwitchToken,
  mergeSwitchApiEndpoint,
  mergeSwitchSettings,
  removeSwitchSettings,
  stripSwitchToken,
  UnignoredAgentCredentialsError,
  writeAgentNeutralSettings,
  writeNeutralAgentSettingsFs,
  writeSwitchSettings,
} from './write-switch-settings';

let dir: string;

function workdirAt(root: string, workdirFs: PluginFs = createPluginFs(root)) {
  return { fs: workdirFs, ignored: localGitIgnoreCheck(root) };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'switch-console-settings-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function readSettings(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(dir, SWITCH_SETTINGS_RELATIVE_PATH), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('writeSwitchSettings', () => {
  it('creates .claude/settings.local.json naming the agent, with no token in it', async () => {
    await writeSwitchSettings({
      dir,
      apiEndpoint: 'https://switch.example.com',
      agentId: 'agent-123',
    });

    const settings = await readSettings();
    // Claude Code reads this file natively, so the identity belongs here — but
    // it is in the working tree, so the token does not (CHOO-1962).
    expect(settings.env).toEqual({
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_AGENT_ID: 'agent-123',
    });
    // The Switch tools are auto-approved ("don't ask").
    expect(settings.permissions).toEqual({
      allow: ['mcp__switch'],
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
      agentId: 'agent-999',
    });

    const settings = await readSettings();
    // Existing allow rules are preserved; the Switch rules are unioned in.
    expect(settings.permissions).toEqual({
      allow: ['Bash', 'mcp__switch'],
    });
    expect(settings.env).toEqual({
      EXISTING_KEY: 'keep-me',
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_AGENT_ID: 'agent-999',
    });
  });
});

describe('writeNeutralAgentSettingsFs', () => {
  it('writes the per-agent credentials, token included, with a gitignore', async () => {
    await writeNeutralAgentSettingsFs(workdirAt(dir), {
      slug: 'agent-abc',
      apiEndpoint: 'https://switch.example.com',
      apiToken: 'secret-token',
      agentId: 'switch-agent-1',
    });

    const raw = await fs.readFile(path.join(dir, agentSettingsRelativePath('agent-abc')), 'utf8');
    // This is the one file that carries the token: `settings.local.json` names
    // the agent, this authenticates it.
    expect((JSON.parse(raw) as { env: Record<string, string> }).env).toEqual({
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_API_TOKEN: 'secret-token',
      SWITCH_AGENT_ID: 'switch-agent-1',
    });

    const ignore = await fs.readFile(path.join(dir, SWITCH_AGENTS_GITIGNORE_RELATIVE), 'utf8');
    expect(ignore).toBe('*\n');
  });

  it.skipIf(process.platform === 'win32')(
    'leaves the token readable by its owner alone, whatever the umask',
    async () => {
      const previous = process.umask(0o022);
      try {
        await writeNeutralAgentSettingsFs(workdirAt(dir), {
          slug: 'agent-abc',
          apiEndpoint: 'https://switch.example.com',
          apiToken: 'secret-token',
          agentId: 'switch-agent-1',
        });
      } finally {
        process.umask(previous);
      }

      const file = path.join(dir, agentSettingsRelativePath('agent-abc'));
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'tightens a credentials file and directory an earlier version left open',
    async () => {
      const file = path.join(dir, agentSettingsRelativePath('agent-abc'));
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
      await fs.writeFile(file, JSON.stringify({ env: { SWITCH_API_TOKEN: 'old' } }), {
        mode: 0o644,
      });

      await writeNeutralAgentSettingsFs(workdirAt(dir), {
        slug: 'agent-abc',
        apiEndpoint: 'https://switch.example.com',
        apiToken: 'new-token',
        agentId: 'switch-agent-1',
      });

      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
  );

  it('merges into an existing per-agent file, preserving unrelated env keys and allow rules', async () => {
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

    await writeNeutralAgentSettingsFs(workdirAt(dir), {
      slug: 'agent-abc',
      apiEndpoint: 'https://switch.example.com',
      apiToken: 'new-token',
      agentId: 'switch-agent-1',
    });

    const settings = JSON.parse(await fs.readFile(path.join(dir, relPath), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(settings.env).toEqual({
      EXISTING: 'keep',
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_API_TOKEN: 'new-token',
      SWITCH_AGENT_ID: 'switch-agent-1',
    });
    // The Switch MCP tools are auto-approved on top of whatever the agent
    // already allowed, so a Switch agent never has to ask to reach its room.
    expect(settings.permissions).toEqual({
      allow: ['Bash', 'mcp__switch'],
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

    await writeNeutralAgentSettingsFs(workdirAt(dir, recordingFs), {
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

describe('writeNeutralAgentSettingsFs, in a git repository', () => {
  const isolated = { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  const previous: Record<string, string | undefined> = {};
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        '-c',
        'commit.gpgsign=false',
      ].concat(args),
      { cwd: dir, encoding: 'utf8', env: { ...process.env, ...isolated } }
    );
  const write = (slug: string) =>
    writeNeutralAgentSettingsFs(workdirAt(dir), {
      slug,
      apiEndpoint: 'https://switch.example.com',
      apiToken: 'secret-token',
      agentId: 'switch-agent-1',
    });

  beforeAll(() => {
    for (const [name, value] of Object.entries(isolated)) {
      previous[name] = process.env[name];
      process.env[name] = value;
    }
  });
  afterAll(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  beforeEach(() => {
    git('init', '-q');
  });

  it('keeps the token out of git when the repository ships a .gitignore there ignoring nothing', async () => {
    await fs.mkdir(path.join(dir, '.switch/agents'), { recursive: true });
    await fs.writeFile(path.join(dir, SWITCH_AGENTS_GITIGNORE_RELATIVE), '# keep the folder\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'seed');

    await write('agent-abc');

    expect(await fs.readFile(path.join(dir, SWITCH_AGENTS_GITIGNORE_RELATIVE), 'utf8')).toBe('*\n');
    expect(() =>
      git('check-ignore', '-q', '--', agentSettingsRelativePath('agent-abc'))
    ).not.toThrow();
    expect(git('add', '-A', '--dry-run')).not.toContain('agent-abc.json');
  });

  it('refuses, writing no token, when the repository tracks the credentials file', async () => {
    const relPath = agentSettingsRelativePath('agent-abc');
    await fs.mkdir(path.join(dir, '.switch/agents'), { recursive: true });
    await fs.writeFile(path.join(dir, relPath), '{"placeholder":true}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'seed');

    await expect(write('agent-abc')).rejects.toBeInstanceOf(UnignoredAgentCredentialsError);
    await expect(write('agent-abc')).rejects.toThrow(`git rm --cached ${relPath}`);

    expect(await fs.readFile(path.join(dir, relPath), 'utf8')).toBe('{"placeholder":true}\n');
  });

  it('writes the token in a repository that ignores it', async () => {
    await write('agent-abc');

    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(
      JSON.parse(await fs.readFile(path.join(dir, agentSettingsRelativePath('agent-abc')), 'utf8'))
        .env.SWITCH_API_TOKEN
    ).toBe('secret-token');
  });
});

describe('writeNeutralAgentSettingsFs, against another install of Switch Console', () => {
  const otherInstall = {
    env: {
      SWITCH_API_ENDPOINT: 'https://other-switch.example.com',
      SWITCH_API_TOKEN: 'their-token',
      SWITCH_AGENT_ID: 'their-agent',
    },
  };

  async function seed(slug: string, content: unknown): Promise<string> {
    const relPath = agentSettingsRelativePath(slug);
    await fs.mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
    await fs.writeFile(path.join(dir, relPath), JSON.stringify(content), 'utf8');
    return path.join(dir, relPath);
  }

  it('refuses a name whose credentials belong to a different Switch server, leaving them intact', async () => {
    const filePath = await seed('shared-name', otherInstall);

    await expect(
      writeNeutralAgentSettingsFs(workdirAt(dir), {
        slug: 'shared-name',
        apiEndpoint: 'https://switch.example.com',
        apiToken: 'our-token',
        agentId: 'our-agent',
      })
    ).rejects.toBeInstanceOf(ForeignAgentCredentialsError);

    // The victim's token is minted once and stored nowhere else, so "not
    // overwritten" is the whole point of the check.
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual(otherInstall);
  });

  it('still rewrites its own agent when the server matches, trailing slash and all', async () => {
    await seed('ours', {
      env: {
        SWITCH_API_ENDPOINT: 'https://switch.example.com/',
        SWITCH_API_TOKEN: 'old-token',
        SWITCH_AGENT_ID: 'old-agent',
      },
    });

    // The caller passes expectedAgentId to confirm it owns the slot — without
    // this, the same-endpoint guard refuses the write (CHOO-2560).
    await writeNeutralAgentSettingsFs(workdirAt(dir), {
      slug: 'ours',
      apiEndpoint: 'https://switch.example.com',
      apiToken: 'new-token',
      agentId: 'new-agent',
      expectedAgentId: 'old-agent',
    });

    const raw = await fs.readFile(path.join(dir, agentSettingsRelativePath('ours')), 'utf8');
    expect((JSON.parse(raw) as { env: Record<string, string> }).env).toEqual({
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_API_TOKEN: 'new-token',
      SWITCH_AGENT_ID: 'new-agent',
    });
  });

  it('refuses when same-endpoint slot holds a different agent and no expectedAgentId is given (CHOO-2560)', async () => {
    await seed('colleague', {
      env: {
        SWITCH_API_ENDPOINT: 'https://switch.example.com',
        SWITCH_API_TOKEN: 'their-token',
        SWITCH_AGENT_ID: 'their-agent',
      },
    });

    await expect(
      writeNeutralAgentSettingsFs(workdirAt(dir), {
        slug: 'colleague',
        apiEndpoint: 'https://switch.example.com',
        apiToken: 'our-token',
        agentId: 'our-agent',
      })
    ).rejects.toBeInstanceOf(ExistingAgentCredentialsError);
  });

  it('reports the owning server through foreignCredentialsOwnerFs, for a caller checking before it registers', async () => {
    await seed('shared-name', otherInstall);
    const workdirFs = createPluginFs(dir);

    expect(
      await foreignCredentialsOwnerFs(workdirFs, 'shared-name', 'https://switch.example.com')
    ).toBe('https://other-switch.example.com');
    expect(
      await foreignCredentialsOwnerFs(workdirFs, 'shared-name', 'https://other-switch.example.com')
    ).toBeNull();
    expect(await foreignCredentialsOwnerFs(workdirFs, 'absent', 'https://switch.example.com')) //
      .toBeNull();
  });
});

describe('stripSwitchToken', () => {
  const legacy = (env: Record<string, string>) =>
    JSON.stringify({ permissions: { allow: ['Bash'] }, env: { EXISTING: 'keep', ...env } });

  it('takes out the token of a file naming the agent, keeping its identity and the rest', () => {
    const result = stripSwitchToken(
      legacy({
        SWITCH_API_ENDPOINT: 'https://switch.example.com',
        SWITCH_API_TOKEN: 'secret-token',
        SWITCH_AGENT_ID: 'agent-1',
      }),
      'agent-1'
    );

    expect(result.kind).toBe('write');
    expect(JSON.parse(result.kind === 'write' ? result.content : '')).toEqual({
      permissions: { allow: ['Bash'] },
      env: {
        EXISTING: 'keep',
        SWITCH_API_ENDPOINT: 'https://switch.example.com',
        SWITCH_AGENT_ID: 'agent-1',
      },
    });
  });

  it('skips a file naming another agent or none, holding no token, or not JSON', () => {
    expect(
      stripSwitchToken(legacy({ SWITCH_API_TOKEN: 't', SWITCH_AGENT_ID: 'agent-2' }), 'agent-1')
    ).toEqual({ kind: 'skip' });
    expect(stripSwitchToken(legacy({ SWITCH_API_TOKEN: 't' }), 'agent-1')).toEqual({
      kind: 'skip',
    });
    expect(stripSwitchToken(legacy({ SWITCH_AGENT_ID: 'agent-1' }), 'agent-1')).toEqual({
      kind: 'skip',
    });
    expect(stripSwitchToken('{not json', 'agent-1')).toEqual({ kind: 'skip' });
    expect(stripSwitchToken('{"env":[]}', 'agent-1')).toEqual({ kind: 'skip' });
    expect(stripSwitchToken(null, 'agent-1')).toEqual({ kind: 'skip' });
  });
});

describe('foreignCredentialsEndpoint', () => {
  const ours = 'https://switch.example.com';

  it('names the other server only when the file actually belongs to one', () => {
    const withEndpoint = (endpoint: string) =>
      JSON.stringify({ env: { SWITCH_API_ENDPOINT: endpoint } });

    expect(foreignCredentialsEndpoint(withEndpoint('https://other.example.com'), ours)).toBe(
      'https://other.example.com'
    );
    expect(foreignCredentialsEndpoint(withEndpoint(`${ours}//`), ours)).toBeNull();
    expect(foreignCredentialsEndpoint(null, ours)).toBeNull();
  });

  it('treats a file that names no Switch server as free, however malformed', () => {
    // Nothing here identifies an agent, so there is no identity to destroy — the
    // writer's existing merge-or-replace behaviour is right for all of them.
    expect(foreignCredentialsEndpoint('{not json', ours)).toBeNull();
    expect(foreignCredentialsEndpoint('[]', ours)).toBeNull();
    expect(foreignCredentialsEndpoint('{"env":{}}', ours)).toBeNull();
    expect(foreignCredentialsEndpoint('{"env":{"SWITCH_API_ENDPOINT":"  "}}', ours)).toBeNull();
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

    const raw = await fs.readFile(path.join(dir, agentSettingsRelativePath('agent-abc')), 'utf8');
    expect((JSON.parse(raw) as { env: Record<string, string> }).env).toEqual({
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_API_TOKEN: 'secret-token',
      SWITCH_AGENT_ID: 'switch-agent-1',
    });
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
    // An endpoint with no agent id names nobody -> skip rather than half-write.
    expect(
      mergeSwitchApiEndpoint(
        JSON.stringify({ env: { SWITCH_API_ENDPOINT: 'https://old' } }),
        'https://new.example.com'
      )
    ).toBeNull();
  });

  it('cascades to an agent whose token has moved to the home store', () => {
    // Requiring a token here would silently skip every agent the CHOO-1962
    // migration has already moved — their endpoint would then never be updated
    // when the server URL changes, and they would quietly point at the old one.
    const merged = mergeSwitchApiEndpoint(
      JSON.stringify({ env: { SWITCH_API_ENDPOINT: 'https://old', SWITCH_AGENT_ID: 'a' } }),
      'https://new.example.com'
    );

    expect(merged).not.toBeNull();
    expect(JSON.parse(merged as string).env).toEqual({
      SWITCH_API_ENDPOINT: 'https://new.example.com',
      SWITCH_AGENT_ID: 'a',
    });
  });
});

describe('removeSwitchSettings', () => {
  it('round-trips a freshly provisioned file to deletion', () => {
    // A file written by mergeSwitchSettings with no pre-existing content is ours
    // alone, so tearing it down should leave nothing behind.
    const provisioned = mergeSwitchSettings(null, {
      apiEndpoint: 'https://switch.example.com',
      agentId: 'agent-123',
    });

    expect(removeSwitchSettings(provisioned, 'agent-123')).toEqual({ kind: 'delete' });
  });

  it('strips only the SWITCH_* keys and Switch rules, preserving everything else', () => {
    const existing = JSON.stringify({
      permissions: { allow: ['Bash', 'mcp__switch'], deny: ['Read'] },
      hooks: { PostToolUse: [{ command: 'x' }] },
      env: {
        EXISTING_KEY: 'keep-me',
        SWITCH_API_ENDPOINT: 'https://switch.example.com',
        SWITCH_API_TOKEN: 'secret-token',
        SWITCH_AGENT_ID: 'agent-123',
      },
    });

    const result = removeSwitchSettings(existing, 'agent-123');
    expect(result.kind).toBe('write');
    const parsed = JSON.parse((result as { content: string }).content) as Record<string, unknown>;

    // Our env keys are gone; the user's stays.
    expect(parsed.env).toEqual({ EXISTING_KEY: 'keep-me' });
    // The Switch allow rule is removed; the user's allow/deny rules stay.
    expect(parsed.permissions).toEqual({ allow: ['Bash'], deny: ['Read'] });
    // Unrelated keys are untouched.
    expect(parsed.hooks).toEqual({ PostToolUse: [{ command: 'x' }] });
  });

  it('drops now-empty env and permissions blocks but keeps other keys', () => {
    const existing = JSON.stringify({
      hooks: { PostToolUse: [{ command: 'x' }] },
      permissions: {
        allow: [
          'mcp__switch',
          'mcp__plugin_switch-connector_switch',
          'mcp__plugin_switch-connector_switch-channel',
        ],
      },
      env: { SWITCH_API_ENDPOINT: 'e', SWITCH_API_TOKEN: 't', SWITCH_AGENT_ID: 'a' },
    });

    const result = removeSwitchSettings(existing, 'a');
    expect(result.kind).toBe('write');
    const parsed = JSON.parse((result as { content: string }).content) as Record<string, unknown>;

    // Both blocks held only our contributions — including the retired
    // connector-plugin rules an older Switch Console wrote — so both are dropped.
    expect(parsed).toEqual({ hooks: { PostToolUse: [{ command: 'x' }] } });
    expect('env' in parsed).toBe(false);
    expect('permissions' in parsed).toBe(false);
  });

  it('skips files that are not a provisioned Switch agent', () => {
    // Absent file.
    expect(removeSwitchSettings(null, 'a')).toEqual({ kind: 'skip' });
    // Unparseable.
    expect(removeSwitchSettings('{not json', 'a')).toEqual({ kind: 'skip' });
    // Empty object.
    expect(removeSwitchSettings('{}', 'a')).toEqual({ kind: 'skip' });
    // A real config with no Switch creds -> leave it untouched.
    expect(removeSwitchSettings(JSON.stringify({ env: { OTHER: 'x' } }), 'a')).toEqual({
      kind: 'skip',
    });
  });

  it('tears down even a partially-provisioned file (only some SWITCH_* keys)', () => {
    // Defensive: if a write was interrupted and only the token survived, teardown
    // must still remove it rather than leaving a dangling secret.
    const existing = JSON.stringify({ env: { SWITCH_API_TOKEN: 'secret-token' } });
    expect(removeSwitchSettings(existing, 'agent-123')).toEqual({ kind: 'delete' });
  });

  it('leaves another agent’s credentials in a shared directory alone', () => {
    const existing = JSON.stringify({
      env: { SWITCH_API_ENDPOINT: 'e', SWITCH_API_TOKEN: 't', SWITCH_AGENT_ID: 'agent-main' },
    });

    expect(removeSwitchSettings(existing, 'agent-sibling')).toEqual({ kind: 'skip' });
    expect(removeSwitchSettings(existing, null)).toEqual({ kind: 'skip' });
  });

  it('leaves the directory undetectable as a Switch agent after teardown', async () => {
    await writeSwitchSettings({
      dir,
      apiEndpoint: 'https://switch.example.com',
      agentId: 'agent-123',
    });
    const raw = await fs.readFile(path.join(dir, SWITCH_SETTINGS_RELATIVE_PATH), 'utf8');

    const result = removeSwitchSettings(raw, 'agent-123');
    // The file was ours alone -> delete it, which makes the dir undetectable.
    expect(result).toEqual({ kind: 'delete' });
    await fs.rm(path.join(dir, SWITCH_SETTINGS_RELATIVE_PATH), { force: true });

    expect(await detectSwitchAgent(dir)).toBeNull();
  });
});

describe('holdsSwitchToken', () => {
  it('is true only for settings whose env carries a token', () => {
    expect(holdsSwitchToken(JSON.stringify({ env: { SWITCH_API_TOKEN: 'secret' } }))).toBe(true);
    expect(holdsSwitchToken(JSON.stringify({ env: { SWITCH_AGENT_ID: 'a' } }))).toBe(false);
    expect(holdsSwitchToken(JSON.stringify({ SWITCH_API_TOKEN: 'not in env' }))).toBe(false);
    expect(holdsSwitchToken('null')).toBe(false);
    expect(holdsSwitchToken('{')).toBe(false);
    expect(holdsSwitchToken(null)).toBe(false);
  });
});

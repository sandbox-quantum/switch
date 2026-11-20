import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codexHomeNotAbsolute,
  codexSourceHome,
  prepareCodexSessionHome,
  managedCodexSandbox,
} from './home';
import type { CodexSandboxMode } from './protocol';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('isolates config, preserves rollouts and refreshed auth on resume, and protects credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-test-'));
  roots.push(root);
  const sourceHome = join(root, 'source');
  await mkdir(sourceHome);
  await writeFile(join(sourceHome, 'auth.json'), 'fixture-login');
  await writeFile(join(sourceHome, 'config.toml'), 'model_reasoning_effort = "high"');
  const input = {
    root: join(root, 'sessions'),
    sessionId: '../session',
    sourceHome,
    config: 'model = "test-model"',
    defaultSandbox: null,
  };
  const { home, keyringLogin } = await prepareCodexSessionHome(input);
  expect(keyringLogin).toBe(false);
  expect(parse(await readFile(join(home, 'config.toml'), 'utf8'))).toEqual({
    model: 'test-model',
    model_reasoning_effort: 'high',
  });
  expect((await readdir(home)).filter((name) => name !== 'skills')).toEqual([
    'auth.json',
    'config.toml',
  ]);
  if (process.platform !== 'win32')
    expect((await stat(join(home, 'auth.json'))).mode & 0o777).toBe(0o600);
  await writeFile(join(home, 'auth.json'), 'refreshed-fixture');
  await mkdir(join(home, 'sessions'));
  expect(await prepareCodexSessionHome(input)).toEqual({ home, keyringLogin: false });
  expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('refreshed-fixture');
  expect(await readFile(join(sourceHome, 'config.toml'), 'utf8')).toBe(
    'model_reasoning_effort = "high"'
  );
  const other = await prepareCodexSessionHome({ ...input, sessionId: 'other' });
  expect(other.home).not.toBe(home);
});

it('hands the session a keyring login when the source home has no auth.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-test-'));
  roots.push(root);
  const { home, keyringLogin } = await prepareCodexSessionHome({
    root,
    sessionId: 'session',
    sourceHome: join(root, 'missing'),
    config: '',
    defaultSandbox: null,
  });
  expect(keyringLogin).toBe(true);
  expect(await readdir(home)).not.toContain('auth.json');
});

it('leaves a copied login alone when the machine moves its own to the keyring', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-test-'));
  roots.push(root);
  const sourceHome = join(root, 'source');
  await mkdir(sourceHome);
  await writeFile(join(sourceHome, 'auth.json'), 'fixture-login');
  const input = {
    root: join(root, 'sessions'),
    sessionId: 'session',
    sourceHome,
    config: '',
    defaultSandbox: null,
  };
  const { home } = await prepareCodexSessionHome(input);
  await rm(join(sourceHome, 'auth.json'));
  // Codex may still read the copy; the adapter decides once it has asked.
  expect(await prepareCodexSessionHome(input)).toEqual({ home, keyringLogin: true });
  expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('fixture-login');
});

it('removes a Switch skill file an earlier build left in the session home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-test-'));
  roots.push(root);
  const input = {
    root,
    sessionId: 'session',
    sourceHome: join(root, 'missing'),
    config: '',
    defaultSandbox: null,
  };
  const { home } = await prepareCodexSessionHome(input);
  await mkdir(join(home, 'skills/switch'), { recursive: true });
  await writeFile(join(home, 'skills/switch/SKILL.md'), 'old copy');
  await prepareCodexSessionHome(input);
  await expect(stat(join(home, 'skills/switch'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('links the user’s own Codex skills into a session home that has no skills folder yet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-test-'));
  roots.push(root);
  const sourceHome = join(root, 'source');
  await mkdir(join(sourceHome, 'skills', '.system'), { recursive: true });
  await writeFile(join(sourceHome, 'skills', '.system', 'SKILL.md'), 'system skill');
  const { home } = await prepareCodexSessionHome({
    root: join(root, 'sessions'),
    sessionId: 'session',
    sourceHome,
    config: '',
    defaultSandbox: null,
  });
  expect(await readFile(join(home, 'skills', '.system', 'SKILL.md'), 'utf8')).toBe('system skill');
});

describe('codexSourceHome', () => {
  it('takes CODEX_HOME, else ~/.codex', () => {
    expect(codexSourceHome({ CODEX_HOME: '/srv/codex' })).toBe('/srv/codex');
    expect(codexSourceHome({})).toBe(join(homedir(), '.codex'));
  });

  it('refuses a relative CODEX_HOME rather than guess which directory it is from', () => {
    expect(() => codexSourceHome({ CODEX_HOME: '.codex-work' })).toThrow(
      codexHomeNotAbsolute('.codex-work')
    );
    expect(() => codexSourceHome({ CODEX_HOME: '~/.codex' })).toThrow('absolute path');
  });
});

describe('managedCodexSandbox', () => {
  it('gives an agent that bypasses permissions full access, any other its workspace', () => {
    expect(managedCodexSandbox('full-access')).toBe('danger-full-access');
    expect(managedCodexSandbox('auto')).toBe('workspace-write');
    expect(managedCodexSandbox('auto-accept-edits')).toBe('workspace-write');
    expect(managedCodexSandbox('approval-required')).toBe('workspace-write');
  });
});

describe('the session sandbox', () => {
  async function sessionSandbox(input: {
    host: string | null;
    agent: string;
    defaultSandbox: CodexSandboxMode | null;
  }): Promise<unknown> {
    const root = await mkdtemp(join(tmpdir(), 'codex-home-test-'));
    roots.push(root);
    const sourceHome = join(root, 'source');
    await mkdir(sourceHome);
    if (input.host !== null) await writeFile(join(sourceHome, 'config.toml'), input.host);
    const { home } = await prepareCodexSessionHome({
      root: join(root, 'sessions'),
      sessionId: 'session',
      sourceHome,
      config: input.agent,
      defaultSandbox: input.defaultSandbox,
    });
    return parse(await readFile(join(home, 'config.toml'), 'utf8')).sandbox_mode;
  }

  it.each(['full-access', 'auto', 'approval-required'] as const)(
    'keeps a host set to read-only read-only in %s',
    async (mode) => {
      expect(
        await sessionSandbox({
          host: 'sandbox_mode = "read-only"\n',
          agent: 'model = "m"\n',
          defaultSandbox: managedCodexSandbox(mode),
        })
      ).toBe('read-only');
    }
  );

  it('prefers the host’s sandbox to the agent’s', async () => {
    expect(
      await sessionSandbox({
        host: 'sandbox_mode = "read-only"\n',
        agent: 'sandbox_mode = "danger-full-access"\n',
        defaultSandbox: 'danger-full-access',
      })
    ).toBe('read-only');
  });

  it('takes the agent’s sandbox when the host names none', async () => {
    expect(
      await sessionSandbox({
        host: 'model = "m"\n',
        agent: 'sandbox_mode = "read-only"\n',
        defaultSandbox: 'danger-full-access',
      })
    ).toBe('read-only');
  });

  it.each([
    ['full-access', 'danger-full-access'],
    ['auto', 'workspace-write'],
    ['approval-required', 'workspace-write'],
  ] as const)(
    'falls back to the runtime mode’s sandbox in %s on a host with no Codex configuration',
    async (mode, expected) => {
      expect(
        await sessionSandbox({
          host: null,
          agent: 'model = "m"\n',
          defaultSandbox: managedCodexSandbox(mode),
        })
      ).toBe(expected);
      expect(
        await sessionSandbox({
          host: '[mcp_servers.x]\ncommand = "x"\n',
          agent: '',
          defaultSandbox: managedCodexSandbox(mode),
        })
      ).toBe(expected);
    }
  );

  it('leaves Codex its own default when there is no default to apply', async () => {
    expect(await sessionSandbox({ host: null, agent: '', defaultSandbox: null })).toBeUndefined();
  });
});

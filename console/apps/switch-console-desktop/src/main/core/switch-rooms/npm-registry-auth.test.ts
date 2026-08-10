import { describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { isEnvShadowedToken, NPMRC_CONTENTS, parseGhAuthStatus } from '@shared/core/npm-registry';
import { remoteNpmRegistryAuthEnv } from './npm-registry-auth';

vi.mock('electron', () => ({ app: { getPath: () => '/userData' } }));
vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@main/core/updates/github-token', () => ({
  GH_EXECUTABLE: 'gh',
  getGithubTokenFromGhCli: vi.fn(),
}));

type Call = { command: string; args: string[] };

function fakeCtx(handlers: {
  token?: () => Promise<{ stdout: string; stderr: string }>;
  status?: () => Promise<{ stdout: string; stderr: string }>;
  write?: () => Promise<{ stdout: string; stderr: string }>;
}): { ctx: IExecutionContext; calls: Call[] } {
  const calls: Call[] = [];
  const ok = async () => ({ stdout: '', stderr: '' });
  const ctx = {
    supportsLocalSpawn: false,
    exec: async (command: string, args: string[] = []) => {
      calls.push({ command, args });
      if (command === 'gh' && args[1] === 'token') return (handlers.token ?? ok)();
      if (command === 'gh' && args[1] === 'status') return (handlers.status ?? ok)();
      return (handlers.write ?? ok)();
    },
    execStreaming: async () => {},
    dispose: () => {},
  } as unknown as IExecutionContext;
  return { ctx, calls };
}

function ghStatus(...entries: Record<string, unknown>[]): string {
  return JSON.stringify({ hosts: { 'github.com': entries } });
}

const KEYRING = '/home/u/.config/gh/hosts.yml';

describe('parseGhAuthStatus', () => {
  it('accepts a token carrying the scope', () => {
    const state = parseGhAuthStatus(
      ghStatus({
        state: 'success',
        active: true,
        login: 'octocat',
        tokenSource: KEYRING,
        scopes: 'gist, read:org, read:packages, repo, workflow',
      })
    );
    expect(state).toEqual({
      status: 'ok',
      login: 'octocat',
      scopes: ['gist', 'read:org', 'read:packages', 'repo', 'workflow'],
      tokenSource: KEYRING,
    });
  });

  it('flags a token missing the scope', () => {
    const state = parseGhAuthStatus(
      ghStatus({
        state: 'success',
        active: true,
        login: 'octocat',
        tokenSource: KEYRING,
        scopes: 'gist, read:org, repo, workflow',
      })
    );
    expect(state.status).toBe('missing-scope');
  });

  // The bug this parser replaces: the old check searched the whole of
  // `gh auth status` for the scope, so a second account that had it answered
  // for the active account that did not.
  it('judges only the active account, not whichever account has the scope', () => {
    const state = parseGhAuthStatus(
      ghStatus(
        { state: 'success', active: true, login: 'work', tokenSource: KEYRING, scopes: 'repo' },
        {
          state: 'success',
          active: false,
          login: 'personal',
          tokenSource: KEYRING,
          scopes: 'repo, read:packages',
        }
      )
    );
    expect(state.status).toBe('missing-scope');
  });

  // The state a stale GH_TOKEN produces: the env token is active and rejected,
  // while the keyring account below it is healthy and has the scope.
  it('reports an unusable active token even when another account is fine', () => {
    const state = parseGhAuthStatus(
      ghStatus(
        {
          state: 'error',
          active: true,
          login: '',
          tokenSource: 'GH_TOKEN',
          error: 'non-200 OK status code: 401 Unauthorized',
        },
        {
          state: 'success',
          active: false,
          login: 'octocat',
          tokenSource: KEYRING,
          scopes: 'repo, read:packages',
        }
      )
    );
    expect(state).toMatchObject({ status: 'invalid', tokenSource: 'GH_TOKEN' });
    expect(isEnvShadowedToken(state)).toBe(true);
  });

  it('recognises an environment token that is otherwise healthy', () => {
    const state = parseGhAuthStatus(
      ghStatus({
        state: 'success',
        active: true,
        login: 'octocat',
        tokenSource: 'GH_TOKEN',
        scopes: 'repo, read:packages',
      })
    );
    expect(state.status).toBe('ok');
    // Healthy today, but it outlives the next `gh auth login` — worth saying.
    expect(isEnvShadowedToken(state)).toBe(true);
  });

  it('does not treat the keyring as a shadowing token', () => {
    const state = parseGhAuthStatus(
      ghStatus({
        state: 'success',
        active: true,
        login: 'octocat',
        tokenSource: KEYRING,
        scopes: 'read:packages',
      })
    );
    expect(isEnvShadowedToken(state)).toBe(false);
  });

  // Guessing wrong must not send someone chasing a scope they already have,
  // nor block setup on a check that did not apply.
  it.each([
    ['unparseable output', 'gh: unknown flag --json'],
    ['no hosts', JSON.stringify({ hosts: {} })],
  ])('returns unknown for %s', (_label, stdout) => {
    expect(parseGhAuthStatus(stdout)).toEqual({ status: 'unknown' });
  });

  it('returns unknown when the scope field is absent', () => {
    const state = parseGhAuthStatus(
      ghStatus({ state: 'success', active: true, login: 'octocat', tokenSource: KEYRING })
    );
    expect(state).toEqual({ status: 'unknown' });
  });
});

describe('remoteNpmRegistryAuthEnv', () => {
  it('writes the npmrc on the remote host and returns the env pointing at it', async () => {
    const { ctx, calls } = fakeCtx({
      token: async () => ({ stdout: 'ghp_remote\n', stderr: '' }),
      status: async () => ({
        stdout: ghStatus({
          state: 'success',
          active: true,
          login: 'octocat',
          tokenSource: KEYRING,
          scopes: 'repo, read:packages',
        }),
        stderr: '',
      }),
    });

    const env = await remoteNpmRegistryAuthEnv(ctx, '/home/ubuntu/repo');

    expect(env).toEqual({
      npm_config_userconfig: '/home/ubuntu/repo/.switchdash/npmrc',
      SWITCHDASH_GITHUB_TOKEN: 'ghp_remote',
    });

    // The file must be written on the remote host — the desktop's own npmrc
    // path does not exist there, which is the whole reason this exists.
    const write = calls.find((c) => c.command === 'sh');
    expect(write?.args[1]).toContain('/home/ubuntu/repo/.switchdash/npmrc');
    expect(write?.args[1]).toContain(NPMRC_CONTENTS.split('\n')[0]);
  });

  it('returns nothing when the remote host has no gh token', async () => {
    const { ctx } = fakeCtx({ token: async () => ({ stdout: '  \n', stderr: '' }) });
    expect(await remoteNpmRegistryAuthEnv(ctx, '/repo')).toEqual({});
  });

  // A session with no MCP server beats no session at all.
  it('returns nothing rather than throwing when gh is absent', async () => {
    const { ctx } = fakeCtx({
      token: async () => {
        throw new Error('command not found: gh');
      },
    });
    expect(await remoteNpmRegistryAuthEnv(ctx, '/repo')).toEqual({});
  });

  it('still returns the env when the scope probe fails', async () => {
    const { ctx } = fakeCtx({
      token: async () => ({ stdout: 'ghp_remote', stderr: '' }),
      status: async () => {
        throw new Error('gh auth status exploded');
      },
    });
    const env = await remoteNpmRegistryAuthEnv(ctx, '/repo');
    expect(env.SWITCHDASH_GITHUB_TOKEN).toBe('ghp_remote');
  });
});

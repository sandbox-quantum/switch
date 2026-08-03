import { describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { lacksReadPackages, NPMRC_CONTENTS } from '@shared/core/npm-registry';
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

describe('lacksReadPackages', () => {
  it('flags a token missing the scope', () => {
    expect(lacksReadPackages("Token scopes: 'gist', 'read:org', 'repo'")).toBe(true);
  });

  it('accepts a token carrying it', () => {
    expect(lacksReadPackages("Token scopes: 'read:packages', 'repo'")).toBe(false);
  });

  // The output is human-readable and may change. Guessing wrong must not
  // produce a warning that sends someone chasing a scope they already have.
  it('says nothing when there is no scope line', () => {
    expect(lacksReadPackages('not logged in')).toBe(false);
  });
});

describe('remoteNpmRegistryAuthEnv', () => {
  it('writes the npmrc on the remote host and returns the env pointing at it', async () => {
    const { ctx, calls } = fakeCtx({
      token: async () => ({ stdout: 'ghp_remote\n', stderr: '' }),
      status: async () => ({ stdout: "Token scopes: 'read:packages'", stderr: '' }),
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

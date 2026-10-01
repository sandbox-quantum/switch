import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@main/core/execution-context/types';
vi.mock('@main/core/agent-runtime/impl/resolve-sidecar-bundle', () => ({
  resolveSharedHostBundlePath: vi.fn(),
}));
const ssh = vi.hoisted(() => ({
  ensureSshConnected: vi.fn(async () => ({ proxy: true })),
  exec: vi.fn(async () => ({
    stdout: '/home/alice/.local/state/switch/sdk-watchers/abc\n',
    stderr: '',
  })),
  contexts: [] as unknown[][],
}));
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({
  ensureSshConnected: ssh.ensureSshConnected,
}));
vi.mock('@main/core/execution-context/ssh-execution-context', () => ({
  SshExecutionContext: class {
    exec = ssh.exec;
    constructor(...args: unknown[]) {
      ssh.contexts.push(args);
    }
  },
}));
const { LOCATE_BUNDLE, resolveWatcherRoot, runSharedHostCommand } =
  await import('./shared-host-deployment');
it.each([false, true])(
  'keeps configuration out of launch arguments and cleans files on failure=%s',
  async (fail) => {
    let path = '';
    const config = { environment: { PRIVATE_TEST_VALUE: 'synthetic-sensitive-value' } };
    const exec = vi.fn(async (_command: string, args: string[]) => {
      expect(JSON.stringify(args)).not.toContain('synthetic-sensitive-value');
      path = args[2];
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(config);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      if (fail) throw new Error('Launch failed');
      return { stdout: '{"created":true}', stderr: '', exitCode: 0 };
    });
    const launched = runSharedHostCommand(
      { kind: 'local' },
      {
        ctx: { exec } as unknown as IExecutionContext,
        root: '/tmp/session',
        entrypoint: '/tmp/host.mjs',
      },
      config,
      '--ensure',
      false
    );
    if (fail) await expect(launched).rejects.toThrow('Launch failed');
    else await expect(launched).resolves.toMatchObject({ stdout: '{"created":true}' });
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  }
);

it('finds a watcher’s state root on a host without deploying anything there', async () => {
  const { root } = await resolveWatcherRoot(
    { kind: 'ssh', connectionId: 'conn-1', host: 'vm-1', dir: '/work' } as never,
    '/work',
    'switch-agent-1'
  );

  expect(root).toBe('/home/alice/.local/state/switch/sdk-watchers/abc');
  expect(ssh.ensureSshConnected).toHaveBeenCalledWith('conn-1', 'vm-1');
  expect(ssh.exec).toHaveBeenCalledOnce();
  const [command, args] = ssh.exec.mock.calls[0] as unknown as [string, string[]];
  expect(command).toBe('node');
  expect(args.slice(2)).toEqual([
    createHash('sha256').update('switch-agent-1').digest('hex'),
    'sdk-watchers',
    'switch-agent-1',
  ]);
});

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function hostWith(bundles: { name: string; ageMs: number }[]) {
  const home = await mkdtemp(join(tmpdir(), 'locate-bundle-'));
  homes.push(home);
  const dir = join(home, '.local/state/switch/sdk-host');
  await mkdir(dir, { recursive: true });
  for (const bundle of bundles) {
    await writeFile(join(dir, bundle.name), '');
    const at = new Date(Date.now() - bundle.ageMs);
    await utimes(join(dir, bundle.name), at, at);
  }
  return { home, dir };
}

async function locate(home: string, wanted: string) {
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', LOCATE_BUNDLE, wanted], {
    env: { ...process.env, HOME: home },
  });
  return stdout.trim();
}

const bundle = (c: string) => `shared-host-${c.repeat(64)}.mjs`;

it('finds this build’s bundle on a host without deploying one', async () => {
  const { home, dir } = await hostWith([
    { name: bundle('a'), ageMs: 0 },
    { name: bundle('b'), ageMs: 60_000 },
  ]);
  expect(await locate(home, bundle('b'))).toBe(join(dir, bundle('b')));
  expect((await readdir(dir)).sort()).toEqual([bundle('a'), bundle('b')]);
});

it('falls back to the newest bundle an earlier deployment left', async () => {
  const { home, dir } = await hostWith([
    { name: bundle('a'), ageMs: 120_000 },
    { name: bundle('b'), ageMs: 1_000 },
    { name: 'shared-host-not-a-bundle.mjs', ageMs: 0 },
  ]);
  expect(await locate(home, bundle('c'))).toBe(join(dir, bundle('b')));
});

it('reports a host with no bundle rather than deploying one', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'locate-bundle-'));
  homes.push(empty);
  expect(await locate(empty, bundle('c'))).toBe('');
  await expect(stat(join(empty, '.local'))).rejects.toMatchObject({ code: 'ENOENT' });
});

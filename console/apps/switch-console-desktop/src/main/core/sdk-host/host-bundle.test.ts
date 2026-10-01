import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ exec: vi.fn(), copy: vi.fn(), bundle: '' }));
vi.mock('@main/core/agent-runtime/impl/resolve-sidecar-bundle', () => ({
  resolveSharedHostBundlePath: () => mocks.bundle,
}));
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({
  ensureSshConnected: vi.fn(async () => ({})),
}));
vi.mock('@main/core/execution-context/ssh-execution-context', () => ({
  SshExecutionContext: class {
    exec = mocks.exec;
  },
}));
vi.mock('@main/core/fs/impl/ssh-fs', () => ({
  SshFileSystem: class {
    copyLocalFile = mocks.copy;
    close() {}
  },
}));

const { clearHostBundles, ensureHostBundle, forgetHostBundle, HOST_PREPARE } =
  await import('./host-bundle');

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'host-bundle-'));
  mocks.bundle = join(home, 'local-bundle.mjs');
  writeFileSync(mocks.bundle, 'export {}');
  clearHostBundles();
  vi.clearAllMocks();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const transport = { kind: 'ssh', connectionId: 'conn-1', host: 'builder', dir: '/work' } as const;
const hash = () => createHash('sha256').update('export {}').digest('hex');

async function prepare(env: Record<string, string> = {}) {
  const name = `shared-host-${hash()}.mjs`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['-e', HOST_PREPARE, name, hash(), String(60 * 60 * 1000)],
    { env: { ...process.env, HOME: home, ...env } }
  );
  return JSON.parse(stdout.trim()) as { directory: string; staging: string; present: boolean };
}

it('readies a host in one command: finds the bundle, prunes old ones, clears stale staging', async () => {
  const state = join(home, '.local/state/switch');
  const hostDir = join(state, 'sdk-host');
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(hostDir, `shared-host-${hash()}.mjs`), 'export {}');
  writeFileSync(join(hostDir, `shared-host-${'b'.repeat(64)}.mjs`), 'old build');
  const stale = join(state, 'sdk-launch/launch-old');
  const fresh = join(state, 'sdk-launch/launch-new');
  const legacy = join(state, 'sdk-watchers/.launch-old');
  for (const dir of [stale, fresh, legacy]) mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  utimesSync(legacy, old, old);

  expect(await prepare()).toEqual({
    directory: hostDir,
    staging: join(state, 'sdk-launch'),
    present: true,
  });
  expect(readdirSync(hostDir)).toEqual([`shared-host-${hash()}.mjs`]);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(legacy)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
});

it('says when this build’s bundle is not on the host, or is not what it should be', async () => {
  expect((await prepare()).present).toBe(false);
  writeFileSync(
    join(home, '.local/state/switch/sdk-host', `shared-host-${hash()}.mjs`),
    'truncated'
  );
  expect((await prepare()).present).toBe(false);
});

it('checks a host once for all its agents, and uploads only a bundle that is missing', async () => {
  mocks.exec.mockImplementation(async (_command: string, args: string[]) =>
    args[1] === HOST_PREPARE
      ? {
          stdout: JSON.stringify({
            directory: '/h/sdk-host',
            staging: '/h/sdk-launch',
            present: false,
          }),
        }
      : { stdout: '' }
  );

  const all = await Promise.all([1, 2, 3].map(() => ensureHostBundle(transport)));

  expect(all).toEqual(
    Array(3).fill({ entrypoint: `/h/sdk-host/shared-host-${hash()}.mjs`, staging: '/h/sdk-launch' })
  );
  expect(mocks.exec.mock.calls.filter(([, args]) => args[1] === HOST_PREPARE)).toHaveLength(1);
  expect(mocks.copy).toHaveBeenCalledOnce();

  await ensureHostBundle(transport);
  expect(mocks.exec.mock.calls.filter(([, args]) => args[1] === HOST_PREPARE)).toHaveLength(1);

  // A launch that failed makes the next one look again.
  forgetHostBundle('conn-1');
  await ensureHostBundle(transport);
  expect(mocks.exec.mock.calls.filter(([, args]) => args[1] === HOST_PREPARE)).toHaveLength(2);
});

it('does not remember a check that failed', async () => {
  mocks.exec.mockRejectedValueOnce(new Error('SSH exec channel open timed out'));
  await expect(ensureHostBundle(transport)).rejects.toThrow('timed out');
  mocks.exec.mockResolvedValue({
    stdout: JSON.stringify({ directory: '/h/sdk-host', staging: '/h/sdk-launch', present: true }),
  });
  await expect(ensureHostBundle(transport)).resolves.toMatchObject({ staging: '/h/sdk-launch' });
  expect(mocks.copy).not.toHaveBeenCalled();
});

/**
 * `runHostRequest`: a one-off command of this build's shared host, with its
 * request staged as a private file rather than put on a command line. Here
 * and on an SSH host the file is readable only by the user and gone
 * afterwards; reading a host never deploys to it, and a host without this
 * build's bundle is refused rather than asked with another build's. A launch
 * (`runSharedHostCommand`) stages its configuration the same way.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { MAKE_LAUNCH_DIR } from './state-roots';

const mocks = vi.hoisted(() => ({
  bundlePath: '',
  ensureSshConnected: vi.fn(async () => ({ proxy: true })),
  sshExec: vi.fn(),
  localExec: vi.fn(),
  /** What each SFTP copy found in the local file it copied, and where it put it. */
  copied: [] as { root: string; dest: string; content: string; mode: number }[],
  ensureHostBundle: vi.fn(),
  forgetHostBundle: vi.fn(),
  warn: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  mocks.rm.mockImplementation(actual.rm);
  return { ...actual, rm: mocks.rm };
});

vi.mock('@main/core/agent-runtime/impl/resolve-sidecar-bundle', () => ({
  resolveSharedHostBundlePath: () => mocks.bundlePath,
}));
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({
  ensureSshConnected: mocks.ensureSshConnected,
}));
vi.mock('@main/core/execution-context/ssh-execution-context', () => ({
  SshExecutionContext: class {
    exec = mocks.sshExec;
    dispose() {}
  },
}));
vi.mock('@main/core/execution-context/local-execution-context', () => ({
  LocalExecutionContext: class {
    exec = mocks.localExec;
    dispose() {}
  },
}));
vi.mock('@main/core/fs/impl/ssh-fs', () => ({
  SshFileSystem: class {
    constructor(
      _proxy: unknown,
      private readonly root: string
    ) {}
    async copyLocalFile(local: string, dest: string) {
      mocks.copied.push({
        root: this.root,
        dest,
        content: await readFile(local, 'utf8'),
        mode: (await stat(local)).mode & 0o777,
      });
    }
    close() {}
  },
}));
vi.mock('./host-bundle', () => ({
  ensureHostBundle: mocks.ensureHostBundle,
  forgetHostBundle: mocks.forgetHostBundle,
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: mocks.warn } }));

const { LOCATE_BUNDLE, runHostRequest, runSharedHostCommand } =
  await import('./shared-host-deployment');

const STATE = '/home/someone/.local/state/switch';
const STAGED = `${STATE}/sdk-sessions/cli-conversations/launch-1`;
const SECRET = `shell-setup-${'q'.repeat(14)}`;
const REQUEST = { provider: 'claude', dir: '/work', shellSetup: `export SETTING=${SECRET}` };
const ssh = { kind: 'ssh', connectionId: 'conn-1', host: 'build-box', dir: '/work' } as never;

let scratch = '';
let entrypoint = '';
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'host-request-'));
  mocks.bundlePath = join(scratch, 'shared-host.mjs');
  await writeFile(mocks.bundlePath, 'export {};\n');
  const hash = createHash('sha256').update('export {};\n').digest('hex');
  entrypoint = `${STATE}/sdk-host/shared-host-${hash}.mjs`;
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/**
 * An SSH host that has `bundle` (or none), stages requests in `STAGED`, and
 * answers the command with `answer`.
 */
function host(bundle: string | null, answer: () => Promise<unknown>) {
  mocks.sshExec.mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] !== '-e') return answer();
    const script = args[1];
    if (script === LOCATE_BUNDLE) return { stdout: `${bundle ?? ''}\n`, stderr: '' };
    if (script === MAKE_LAUNCH_DIR) return { stdout: `${STAGED}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  });
}

const CHMOD = "require('node:fs').chmodSync(process.argv[1],0o600)";
const REMOVE = "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true})";

/** The arguments of each time `script` ran on the host with `node -e`. */
function scripts(script: string): string[][] {
  return mocks.sshExec.mock.calls
    .map((call) => call[1] as string[])
    .filter((args) => args[0] === '-e' && args[1] === script)
    .map((args) => args.slice(2));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.copied = [];
});

it.each([false, true])(
  'stages the request here as a private file, off the command line, and removes it (failing: %s)',
  async (fail) => {
    let path = '';
    mocks.localExec.mockImplementation(async (_command: string, args: string[]) => {
      expect(JSON.stringify(args)).not.toContain(SECRET);
      path = args[2]!;
      expect(args.slice(0, 2)).toEqual([mocks.bundlePath, '--cli-conversations']);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(REQUEST);
      if (fail) throw new Error('Command failed');
      return { stdout: '{}', stderr: '' };
    });
    const answered = runHostRequest({ kind: 'local' }, '--cli-conversations', REQUEST, {
      deploy: false,
      timeout: 1_000,
    });
    if (fail) await expect(answered).rejects.toThrow('Command failed');
    else await expect(answered).resolves.toEqual({ stdout: '{}', stderr: '' });
    await expect(stat(dirname(path))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mocks.ensureSshConnected).not.toHaveBeenCalled();
  }
);

it('reads an SSH host with this build’s bundle without deploying, staging the request privately and removing it', async () => {
  host(entrypoint, async () => ({ stdout: '{"ownershipKnown":true}', stderr: '' }));

  await expect(
    runHostRequest(ssh, '--cli-conversations', REQUEST, { deploy: false, timeout: 1_000 })
  ).resolves.toMatchObject({ stdout: '{"ownershipKnown":true}' });

  expect(mocks.ensureHostBundle).not.toHaveBeenCalled();
  // Staged beside a launch's configuration, as a file only the user can read.
  expect(scripts(MAKE_LAUNCH_DIR)).toEqual([
    [`${STATE}/sdk-sessions/cli-conversations`, String(60 * 60 * 1000)],
  ]);
  expect(mocks.copied).toEqual([
    { root: STAGED, dest: 'request.json', content: JSON.stringify(REQUEST), mode: 0o600 },
  ]);
  expect(scripts(CHMOD)).toEqual([[`${STAGED}/request.json`]]);
  const run = mocks.sshExec.mock.calls.find((call) => (call[1] as string[])[0] !== '-e')!;
  expect(run[1]).toEqual([entrypoint, '--cli-conversations', `${STAGED}/request.json`]);
  expect(run[2]).toEqual({ timeout: 1_000 });
  expect(JSON.stringify(mocks.sshExec.mock.calls)).not.toContain(SECRET);
  expect(scripts(REMOVE)).toEqual([[STAGED]]);
});

it.each([
  ['another build’s bundle', `${STATE}/sdk-host/shared-host-${'b'.repeat(64)}.mjs`],
  ['no bundle', null],
])('refuses to read an SSH host that has %s, rather than deploy to it', async (_label, bundle) => {
  host(bundle, async () => ({ stdout: '{}', stderr: '' }));

  await expect(
    runHostRequest(ssh, '--cli-conversations', REQUEST, { deploy: false, timeout: 1_000 })
  ).rejects.toThrow("build-box does not have this version of Switch Console's host yet");

  expect(mocks.ensureHostBundle).not.toHaveBeenCalled();
  expect(scripts(MAKE_LAUNCH_DIR)).toEqual([]);
  expect(mocks.copied).toEqual([]);
});

it('deploys for a launch, and on a failure that names the bundle forgets the host and still removes the request', async () => {
  mocks.ensureHostBundle.mockResolvedValue({ entrypoint, staging: `${STATE}/sdk-launch` });
  host(null, async () =>
    Promise.reject(
      Object.assign(new Error('Command failed'), {
        stderr: `Cannot find module '${entrypoint}'`,
      })
    )
  );

  await expect(
    runHostRequest(ssh, '--fork-cli-conversation', REQUEST, { deploy: true, timeout: 1_000 })
  ).rejects.toThrow('Command failed');

  expect(mocks.ensureHostBundle).toHaveBeenCalledWith(ssh);
  expect(scripts(LOCATE_BUNDLE)).toEqual([]);
  expect(mocks.forgetHostBundle).toHaveBeenCalledWith('conn-1');
  expect(scripts(REMOVE)).toEqual([[STAGED]]);
});

/** Makes removing what was staged on the SSH host fail, after `host()` set it up. */
function removalFails() {
  const exec = mocks.sshExec.getMockImplementation()!;
  mocks.sshExec.mockImplementation(async (command: string, args: string[]) => {
    if (args[0] === '-e' && args[1] === REMOVE) throw new Error('Permission denied');
    return exec(command, args);
  });
}

it('keeps the command’s own failure when the staged request cannot be removed', async () => {
  host(entrypoint, async () => Promise.reject(new Error('Command failed')));
  removalFails();

  await expect(
    runHostRequest(ssh, '--cli-conversations', REQUEST, { deploy: false, timeout: 1_000 })
  ).rejects.toThrow('Command failed');
  expect(mocks.warn).toHaveBeenCalledWith(
    'Could not remove a file staged for the shared host',
    expect.objectContaining({
      event: 'sdk_host.staged_file_cleanup',
      stage: 'request-finished',
      host: 'build-box',
      error: 'Error: Permission denied',
    })
  );
});

it('keeps the command’s own failure here when the staged request cannot be removed', async () => {
  let path = '';
  mocks.localExec.mockImplementation(async (_command: string, args: string[]) => {
    path = args[2]!;
    throw new Error('Command failed');
  });
  mocks.rm.mockRejectedValueOnce(new Error('Device busy'));
  onTestFinished(() => rm(dirname(path), { recursive: true, force: true }));

  await expect(
    runHostRequest({ kind: 'local' }, '--cli-conversations', REQUEST, {
      deploy: false,
      timeout: 1_000,
    })
  ).rejects.toThrow('Command failed');
  expect(mocks.warn).toHaveBeenCalledWith(
    'Could not remove a file staged for the shared host',
    expect.objectContaining({ event: 'sdk_host.staged_file_cleanup', stage: 'request-finished' })
  );
});

it('keeps why staging failed when what it had made cannot be removed', async () => {
  host(entrypoint, async () => ({ stdout: '{}', stderr: '' }));
  const exec = mocks.sshExec.getMockImplementation()!;
  mocks.sshExec.mockImplementation(async (command: string, args: string[]) => {
    if (args[0] === '-e' && args[1] === CHMOD) throw new Error('Read-only file system');
    if (args[0] === '-e' && args[1] === REMOVE) throw new Error('Permission denied');
    return exec(command, args);
  });

  await expect(
    runHostRequest(ssh, '--cli-conversations', REQUEST, { deploy: false, timeout: 1_000 })
  ).rejects.toThrow('Read-only file system');
  expect(mocks.warn).toHaveBeenCalledWith(
    'Could not remove a file staged for the shared host',
    expect.objectContaining({
      event: 'sdk_host.staged_file_cleanup',
      stage: 'staging-failed',
      host: 'build-box',
    })
  );
});

it('keeps a launch command’s own failure when its staged configuration cannot be removed', async () => {
  const root = `${STATE}/sdk-sessions/abc`;
  host(entrypoint, async () => Promise.reject(new Error('Command failed')));
  removalFails();
  const ctx = { exec: mocks.sshExec } as never;

  await expect(
    runSharedHostCommand(ssh, { ctx, root, entrypoint }, {}, '--ensure', false)
  ).rejects.toThrow('Command failed');
  expect(mocks.warn).toHaveBeenCalledWith(
    'Could not remove a file staged for the shared host',
    expect.objectContaining({
      event: 'sdk_host.staged_file_cleanup',
      stage: 'command-failed',
      host: 'build-box',
    })
  );
});

it('fails a launch that ran when its staged configuration cannot be removed', async () => {
  const root = `${STATE}/sdk-sessions/abc`;
  host(entrypoint, async () => ({ stdout: '{"created":true}', stderr: '' }));
  removalFails();
  const ctx = { exec: mocks.sshExec } as never;

  await expect(
    runSharedHostCommand(ssh, { ctx, root, entrypoint }, {}, '--ensure', false)
  ).rejects.toThrow('Permission denied');
  expect(mocks.warn).not.toHaveBeenCalled();
});

it('stages a launch’s configuration on an SSH host in its state root, privately, and removes it', async () => {
  const config = { environment: { PRIVATE_TEST_VALUE: SECRET } };
  const root = `${STATE}/sdk-sessions/abc`;
  host(entrypoint, async () => ({ stdout: '{"created":true}', stderr: '' }));
  const ctx = { exec: mocks.sshExec } as never;

  await expect(
    runSharedHostCommand(ssh, { ctx, root, entrypoint }, config, '--ensure', true)
  ).resolves.toMatchObject({ stdout: '{"created":true}' });

  expect(scripts(MAKE_LAUNCH_DIR)).toEqual([[root, String(60 * 60 * 1000)]]);
  expect(mocks.copied).toEqual([
    { root: STAGED, dest: 'config.json', content: JSON.stringify(config), mode: 0o600 },
  ]);
  expect(scripts(CHMOD)).toEqual([[`${STAGED}/config.json`]]);
  const run = mocks.sshExec.mock.calls.find((call) => (call[1] as string[])[0] !== '-e')!;
  expect(run[1]).toEqual([entrypoint, root, `${STAGED}/config.json`, '--ensure', 'true']);
  expect(JSON.stringify(mocks.sshExec.mock.calls)).not.toContain(SECRET);
  expect(scripts(REMOVE)).toEqual([[STAGED]]);
});

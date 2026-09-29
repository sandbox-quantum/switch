import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerBusyError } from '@shared/core/managed-switch-server/managed-switch-server';
import { STACK_HELPER_IMAGE, STACK_STATE_VOLUME_SUFFIX } from './constants';
import type { LockClaim, LockTiming, ServerLease } from './stack-lock';
import type { StackStateHost } from './stack-state';

/**
 * The server lock and the state mutex against a real state volume, through
 * the real helper image (CHOO-2893). Nothing short of that shows the lock
 * holding: it rests on `flock` across throwaway containers sharing one
 * volume, and on the host's clock — neither of which a laptop's shell has
 * (macOS has no flock at all). Needs a Docker daemon, so it is skipped,
 * visibly, where there is none; CI runs it on Linux.
 */

vi.mock('@main/core/switch-servers/console-identity', () => ({
  getConsoleIdentity: () =>
    Promise.resolve({ id: '3f2a9c1e-5b7d-4e8f-a1b2-c3d4e5f6a7b8', name: 'alice@laptop' }),
}));
vi.mock('@main/core/app/utils', () => ({ resolveAppVersion: () => Promise.resolve('0.37.0') }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { acquireServerLock, LOCK_SCRIPT, readServerLock, ServerLockLostError } =
  await import('./stack-lock');
const { publishEnv, withdrawPublishedEnv, writeStateVolume, readStateVolume, runStateScript } =
  await import('./stack-state');
const { RECORD_SCRIPT } = await import('./console-register');
const { LOCK_LOST_MESSAGE } = await import('./state-mutex');

const run = promisify(execFile);

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: 'pipe',
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

const DOCKER = dockerAvailable();

/** A host whose docker is this machine's. */
function localHost(project: string): StackStateHost {
  return {
    label: 'test-host',
    dockerBin: 'docker',
    composeProjectName: project,
    workingDir: '/nonexistent',
    readFile: () => Promise.resolve(null),
    ctx: {
      supportsLocalSpawn: true,
      exec: (command: string, args: string[] = [], opts: { timeout?: number } = {}) =>
        run(command, args, { timeout: opts.timeout, maxBuffer: 8 * 1024 * 1024 }),
    } as unknown as StackStateHost['ctx'],
    writeCommandInput: (command, args, input, opts) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { timeout: opts.timeoutMs });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.stdout.resume();
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`exit ${code}: ${stderr.trim()}`))
        );
        child.stdin.end(input);
      }),
  };
}

function claim(overrides: Partial<LockClaim> = {}): LockClaim {
  return {
    consoleId: 'aaaaaaaa-0000-4000-8000-000000000001',
    instance: 'run-1',
    name: 'alice@laptop',
    hostAccount: 'alice',
    action: 'starting',
    ...overrides,
  };
}

const bob = (overrides: Partial<LockClaim> = {}) =>
  claim({
    consoleId: 'bbbbbbbb-0000-4000-8000-000000000002',
    name: 'bob@desk',
    hostAccount: 'bob',
    ...overrides,
  });

/** No renewals unless a test asks for them, so expiry can be watched. */
const QUIET: LockTiming = {
  ttlSeconds: 2,
  renewEveryMs: 60_000,
  maxHoldSeconds: 600,
  pollEveryMs: 200,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!DOCKER)('the server lock, against a real state volume', () => {
  let host: StackStateHost;
  let project: string;
  const leases: ServerLease[] = [];

  beforeEach(() => {
    project = `switch-lock-test-${randomBytes(4).toString('hex')}`;
    host = localHost(project);
  });

  afterEach(async () => {
    for (const lease of leases.splice(0)) await lease.release();
    await run('docker', ['volume', 'rm', '-f', `${project}_${STACK_STATE_VOLUME_SUFFIX}`]).catch(
      () => undefined
    );
  });

  async function take(c: LockClaim, timing: LockTiming = QUIET): Promise<ServerLease> {
    const lease = await acquireServerLock(host, c, { mode: 'refuse', timing });
    leases.push(lease);
    return lease;
  }

  it('is taken, refused to someone else naming its holder, and free again once released', async () => {
    const alice = await take(claim());

    const refused = await take(bob()).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ServerBusyError);
    expect((refused as InstanceType<typeof ServerBusyError>).holder).toMatchObject({
      name: 'alice@laptop',
      hostAccount: 'alice',
      action: 'starting',
    });
    expect((refused as Error).message).toMatch(
      /alice@laptop \(as alice\) is starting the server on test-host right now/
    );

    await alice.release();
    await expect(take(bob())).resolves.toBeDefined();
  }, 60_000);

  it('goes to exactly one of two Consoles taking it at once', async () => {
    const results = await Promise.allSettled([take(claim()), take(bob())]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ServerBusyError);
  }, 60_000);

  it('lets a waiting Console in once the holder releases it, saying who it waited for', async () => {
    const alice = await take(claim());
    const onWaiting = vi.fn();
    const waiting = acquireServerLock(host, bob(), {
      mode: 'wait',
      timing: QUIET,
      signal: new AbortController().signal,
      onWaiting,
    });

    await sleep(1000);
    await alice.release();
    leases.push(await waiting);

    expect(onWaiting).toHaveBeenCalledWith(expect.objectContaining({ name: 'alice@laptop' }));
  }, 60_000);

  it('can be taken over once its holder stops renewing it', async () => {
    await take(claim());

    await sleep(2500);

    await expect(take(bob())).resolves.toBeDefined();
  }, 60_000);

  it('goes to exactly one of two Consoles taking over the same lapsed lease', async () => {
    await take(claim());
    await sleep(2500);

    const results = await Promise.allSettled([
      take(bob()),
      take(claim({ consoleId: 'cccccccc-0000-4000-8000-000000000003', name: 'carol@pc' })),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  }, 60_000);

  it('stays held past its lease while its holder renews it', async () => {
    await take(claim(), { ...QUIET, renewEveryMs: 500 });

    await sleep(3000);

    await expect(take(bob())).rejects.toBeInstanceOf(ServerBusyError);
  }, 60_000);

  it('cannot be renewed past the longest hold, and then goes to whoever asks', async () => {
    const alice = await take(claim(), { ...QUIET, renewEveryMs: 500, maxHoldSeconds: 3 });

    await sleep(4000);

    await expect(alice.assertHeld()).rejects.toBeInstanceOf(ServerLockLostError);
    await expect(take(bob())).resolves.toBeDefined();
  }, 60_000);

  it('is not released by a holder that lost it, and knows it was lost', async () => {
    const alice = await take(claim());
    await sleep(2500);
    await take(bob());

    await expect(alice.assertHeld()).rejects.toBeInstanceOf(ServerLockLostError);
    await alice.release();

    await expect(
      take(claim({ consoleId: 'cccccccc-0000-4000-8000-000000000003' }))
    ).rejects.toMatchObject({ holder: expect.objectContaining({ name: 'bob@desk' }) });
  }, 60_000);

  it('is not taken back by a Console that only shares the id, as a restored backup would', async () => {
    await take(claim({ instance: 'run-before-crash' }));

    await expect(
      take(claim({ instance: 'other-desk', name: 'alice@other-desk' }))
    ).rejects.toBeInstanceOf(ServerBusyError);
  }, 60_000);

  it('is taken over by a take that names it as a lease this run failed to give back', async () => {
    await take(claim());
    const args = (op: string, token: string, stale: string) => [
      op,
      token,
      'aaaaaaaa-0000-4000-8000-000000000001',
      'run-1',
      'starting',
      '2',
      '600',
      'alice@laptop',
      'alice',
      stale,
    ];
    const held = (await readStateVolume(host, 'sed -n 2p /state/lock')).trim();

    expect(
      (await runStateScript(host, LOCK_SCRIPT, args('take', 'other', ''))).split('\n')[0]
    ).toBe('held');
    expect(
      (await runStateScript(host, LOCK_SCRIPT, args('take', 'next', `x ${held} y`))).split('\n')[0]
    ).toBe('taken');
  }, 60_000);

  it('is taken back at once by the same Console after a restart, but not by the same run', async () => {
    await take(claim({ instance: 'run-before-crash' }));

    await expect(take(claim({ instance: 'run-before-crash' }))).rejects.toBeInstanceOf(
      ServerBusyError
    );
    await expect(take(claim({ instance: 'run-after-restart' }))).resolves.toBeDefined();
  }, 60_000);

  it('is only taken under the state mutex', async () => {
    await writeStateVolume(host, 'true', '', []);
    const holding = run('docker', [
      'run',
      '--rm',
      '--volume',
      `${project}_${STACK_STATE_VOLUME_SUFFIX}:/state`,
      '--entrypoint',
      'sh',
      STACK_HELPER_IMAGE,
      '-c',
      'exec 9>/state/.mutex; flock 9; touch /state/held; sleep 3; rm /state/held',
    ]);
    while ((await readStateVolume(host, '[ -f /state/held ] && echo held; true')) !== 'held\n') {
      await sleep(100);
    }

    const started = Date.now();
    await take(claim());

    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    await holding;
  }, 60_000);

  it('is not taken when its file cannot be written, so nobody else takes it too', async () => {
    // A write that cannot happen — here the temp file's name is taken by a
    // directory; on a real host, a full disk — must fail the take, not answer
    // "taken" over an empty lock file the next Console would read as free.
    await writeStateVolume(host, 'mkdir /state/.lock.tmp', '', []);

    await expect(take(claim())).rejects.toThrow();

    expect(await readServerLock(host)).toBeNull();
  }, 60_000);

  it('is read without being changed, and reads as free once released', async () => {
    expect(await readServerLock(host)).toBeNull();
    const alice = await take(claim({ action: 'updating' }));

    expect(await readServerLock(host)).toMatchObject({ name: 'alice@laptop', action: 'updating' });

    await alice.release();
    expect(await readServerLock(host)).toBeNull();
  }, 60_000);

  it('lets only its holder publish or withdraw the settings', async () => {
    const alice = await take(claim());
    await sleep(2500);
    const bobs = await take(bob());

    await expect(publishEnv(host, 'A=1\n', alice)).rejects.toThrow(LOCK_LOST_MESSAGE);
    await expect(withdrawPublishedEnv(host, alice)).rejects.toThrow(LOCK_LOST_MESSAGE);
    await publishEnv(host, 'B=2\n', bobs);

    expect(await readStateVolume(host, 'cat /state/stack.env')).toBe('B=2\n');
  }, 60_000);
});

describe.skipIf(!DOCKER)('the state mutex, against a real state volume', () => {
  let host: StackStateHost;
  let project: string;

  beforeEach(() => {
    project = `switch-lock-test-${randomBytes(4).toString('hex')}`;
    host = localHost(project);
  });

  afterEach(async () => {
    await run('docker', ['volume', 'rm', '-f', `${project}_${STACK_STATE_VOLUME_SUFFIX}`]).catch(
      () => undefined
    );
  });

  it('makes a record wait while another script holds the mutex', async () => {
    // Container start-up jitter dwarfs a trim, so racing real records rarely
    // shows anything; holding the mutex for a known time does.
    await writeStateVolume(host, 'true', '', []);
    const holding = run('docker', [
      'run',
      '--rm',
      '--volume',
      `${project}_${STACK_STATE_VOLUME_SUFFIX}:/state`,
      '--entrypoint',
      'sh',
      STACK_HELPER_IMAGE,
      '-c',
      'exec 9>/state/.mutex; flock 9; touch /state/held; sleep 3; rm /state/held',
    ]);
    while ((await readStateVolume(host, '[ -f /state/held ] && echo held; true')) !== 'held\n') {
      await sleep(100);
    }

    const started = Date.now();
    await writeStateVolume(host, RECORD_SCRIPT, '{"entry":1}\n{"line":1}\n', [
      'dddddddd-0000-4000-8000-000000000001',
      'act',
    ]);

    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect(await readStateVolume(host, '[ -f /state/held ] && echo held; true')).toBe('');
    await holding;
  }, 60_000);
});

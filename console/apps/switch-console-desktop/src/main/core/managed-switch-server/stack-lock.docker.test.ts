import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerBusyError } from '@shared/core/managed-switch-server/managed-switch-server';
import { STACK_HELPER_IMAGE, STACK_STATE_VOLUME_SUFFIX } from './constants';
import type { LockClaim, LockTiming, ServerLease } from './stack-lock';
import type { StackStateHost } from './stack-state';

/**
 * Only a real volume and helper image show the lock holding: it rests on
 * `flock` across containers sharing one volume, and on the host's clock.
 * Skipped where there is no Docker daemon; CI runs it on Linux.
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

/**
 * A lease that outlasts any test, for tests that need the lock to stay held
 * while they act on it. Each step here starts a container, so a short lease
 * can lapse between two of them on a slow machine.
 */
const HELD: LockTiming = {
  ttlSeconds: 600,
  renewEveryMs: 60_000,
  maxHoldSeconds: 600,
  pollEveryMs: 200,
};

/** No renewals unless a test asks for them, so expiry can be watched. */
const LAPSING: LockTiming = { ...HELD, ttlSeconds: 2 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `promise`, and whether it has settled yet. */
function settles<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  return { promise: tracked, settled: () => settled };
}

/**
 * Holds the state mutex from a container of its own until released, so a test
 * can show a script waiting for it however long containers take to start.
 */
async function holdStateMutex(
  host: StackStateHost,
  project: string
): Promise<{ release: () => Promise<void> }> {
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
    'exec 9>/state/.mutex; flock 9; touch /state/held; ' +
      'while [ ! -f /state/release ]; do sleep 0.1; done; rm /state/held /state/release',
  ]);
  while ((await readStateVolume(host, '[ -f /state/held ] && echo held; true')) !== 'held\n') {
    await sleep(100);
  }
  return {
    release: async () => {
      await runStateScript(host, 'touch /state/release', []);
      await holding;
    },
  };
}

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

  async function take(c: LockClaim, timing: LockTiming = HELD): Promise<ServerLease> {
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
      timing: HELD,
      signal: new AbortController().signal,
      onWaiting,
    });

    await sleep(1000);
    await alice.release();
    leases.push(await waiting);

    expect(onWaiting).toHaveBeenCalledWith(expect.objectContaining({ name: 'alice@laptop' }));
  }, 60_000);

  it('can be taken over once its holder stops renewing it', async () => {
    await take(claim(), LAPSING);

    await sleep(2500);

    await expect(take(bob())).resolves.toBeDefined();
  }, 60_000);

  it('goes to exactly one of two Consoles taking over the same lapsed lease', async () => {
    await take(claim(), LAPSING);
    await sleep(2500);

    const results = await Promise.allSettled([
      take(bob()),
      take(claim({ consoleId: 'cccccccc-0000-4000-8000-000000000003', name: 'carol@pc' })),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  }, 60_000);

  it('stays held past its lease while its holder renews it', async () => {
    // Long enough a lease that a renewal always lands inside it, even when
    // starting each renewal's container is slow.
    await take(claim(), { ...HELD, ttlSeconds: 5, renewEveryMs: 500 });

    await sleep(6500);

    await expect(take(bob())).rejects.toBeInstanceOf(ServerBusyError);
  }, 60_000);

  it('cannot be renewed past the longest hold, and then goes to whoever asks', async () => {
    const alice = await take(claim(), { ...LAPSING, renewEveryMs: 500, maxHoldSeconds: 3 });

    await sleep(4000);

    await expect(alice.assertHeld()).rejects.toBeInstanceOf(ServerLockLostError);
    await expect(take(bob())).resolves.toBeDefined();
  }, 60_000);

  it('is not released by a holder that lost it, and knows it was lost', async () => {
    const alice = await take(claim(), LAPSING);
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
    const holder = await holdStateMutex(host, project);

    const taking = settles(take(claim()));
    try {
      await sleep(1500);
      expect(taking.settled()).toBe(false);
    } finally {
      await holder.release();
    }
    await taking.promise;
  }, 60_000);

  it('is not taken when its file cannot be written, so nobody else takes it too', async () => {
    // A directory in the temp file's place stands in for a full disk.
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
    const alice = await take(claim(), LAPSING);
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
    // shows anything; holding the mutex until told to let go does.
    const holder = await holdStateMutex(host, project);

    const recording = settles(
      writeStateVolume(host, RECORD_SCRIPT, '{"entry":1}\n{"line":1}\n', [
        'dddddddd-0000-4000-8000-000000000001',
        'act',
      ])
    );
    try {
      await sleep(1500);
      expect(recording.settled()).toBe(false);
    } finally {
      await holder.release();
    }
    await recording.promise;
    expect(await readStateVolume(host, '[ -f /state/held ] && echo held; true')).toBe('');
  }, 60_000);
});

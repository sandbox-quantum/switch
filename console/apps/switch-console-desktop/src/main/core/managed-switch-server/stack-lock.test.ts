import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockClaim, LockTiming } from './stack-lock';
import type * as StackState from './stack-state';
import type { StackStateHost } from './stack-state';

/**
 * The server lock's own logic (CHOO-2893) — reading the script's answers,
 * waiting, renewing, giving back — with the host's answers scripted. That the
 * script itself holds on a real volume is tested in stack-lock.docker.test.ts.
 */

const runStateScript = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
const readStateVolume = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
const stateVolumeExists = vi.hoisted(() => vi.fn(async () => true));
const logWarn = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());

vi.mock('@main/lib/logger', () => ({ log: { warn: logWarn, error: logError, info: vi.fn() } }));
vi.mock('./stack-state', async (importOriginal) => ({
  ...(await importOriginal<typeof StackState>()),
  runStateScript,
  readStateVolume,
  stateVolumeExists,
}));

const {
  acquireServerLock,
  parseLockReply,
  readServerLock,
  ServerLease,
  ServerLockLostError,
  ServerLockWaitCancelled,
} = await import('./stack-lock');
const { ServerBusyError } =
  await import('@shared/core/managed-switch-server/managed-switch-server');

const host = { label: 'vm-1' } as StackStateHost;

const claim: LockClaim = {
  consoleId: 'aaaaaaaa-0000-4000-8000-000000000001',
  instance: 'run-1',
  name: 'alice@laptop',
  hostAccount: 'alice',
  action: 'starting',
};

const timing: LockTiming = {
  ttlSeconds: 120,
  renewEveryMs: 30_000,
  maxHoldSeconds: 5400,
  pollEveryMs: 5_000,
};

/** The lock file as the script writes it. */
function lockFile(fields: { expires: number; since: number; action?: string; name?: string }) {
  return [
    'switch-console-lock v1',
    'their-token',
    String(fields.expires),
    String(fields.since),
    'bbbbbbbb-0000-4000-8000-000000000002',
    'run-9',
    fields.action ?? 'starting',
    fields.name ?? 'bob@desk',
    'bob',
    '',
  ].join('\n');
}

const reply = (status: string, now: number, file = '') => `${status}\n${now}\n${file}`;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reading the script’s answer', () => {
  it('names the holder, with how long it has held the lock and how long it has left', () => {
    expect(parseLockReply(reply('held', 1000, lockFile({ expires: 1090, since: 960 })))).toEqual({
      status: 'held',
      holder: {
        name: 'bob@desk',
        hostAccount: 'bob',
        action: 'starting',
        heldForSeconds: 40,
        expiresInSeconds: 90,
        live: true,
      },
    });
  });

  it('says a lapsed lock is lapsed, and no holder where there is no lock', () => {
    expect(
      parseLockReply(reply('peek', 1000, lockFile({ expires: 990, since: 800 }))).holder
    ).toMatchObject({ live: false, expiresInSeconds: 0 });
    expect(parseLockReply(reply('released', 1000))).toEqual({ status: 'released', holder: null });
  });

  it('makes do with a lock file whose fields it cannot read', () => {
    const file = [
      'switch-console-lock v1',
      'their-token',
      'soon',
      'earlier',
      'bbbbbbbb-0000-4000-8000-000000000002',
      'run-9',
      'starting',
      '',
      '',
      '',
    ].join('\n');

    expect(parseLockReply(reply('held', 1000, file)).holder).toEqual({
      name: 'unknown',
      hostAccount: 'unknown',
      action: 'starting',
      heldForSeconds: 0,
      expiresInSeconds: 0,
      live: false,
    });
  });

  it('refuses an answer it does not understand rather than take the lock for free', () => {
    expect(() => parseLockReply('sh: flock: not found\n')).toThrow(/Unexpected answer/);
    expect(() => parseLockReply('taken\nnot-a-clock\n')).toThrow(/Unexpected answer/);
  });

  it('shows an action from a later Console as a check, and logs it', () => {
    const { holder } = parseLockReply(
      reply('held', 1000, lockFile({ expires: 1090, since: 960, action: 'migrating' }))
    );

    expect(holder?.action).toBe('checking');
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringMatching(/action this Console does not know/),
      { action: 'migrating' }
    );
  });
});

describe('taking the lock', () => {
  it('passes who is taking it, one line each, and nothing that could split the file', async () => {
    runStateScript.mockResolvedValueOnce(reply('taken', 1000));

    const lease = await acquireServerLock(
      host,
      { ...claim, name: 'alice\n@laptop\t', hostAccount: '' },
      { mode: 'refuse', timing }
    );
    await lease.release();

    const args = runStateScript.mock.calls[0]![2] as string[];
    expect(args[0]).toBe('take');
    expect(args.slice(2)).toEqual([
      claim.consoleId,
      'run-1',
      'starting',
      '120',
      '5400',
      'alice @laptop',
      'unknown',
    ]);
  });

  it('refuses a console id that is not one without asking the host', async () => {
    await expect(
      acquireServerLock(host, { ...claim, consoleId: '../../etc' }, { mode: 'refuse', timing })
    ).rejects.toThrow(/not one/);
    expect(runStateScript).not.toHaveBeenCalled();
  });

  it('refuses at once, naming the holder, when told not to wait', async () => {
    runStateScript.mockResolvedValueOnce(
      reply('held', 1000, lockFile({ expires: 1090, since: 960 }))
    );

    const error = await acquireServerLock(host, claim, { mode: 'refuse', timing }).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(ServerBusyError);
    expect((error as Error).message).toMatch(/^bob@desk \(as bob\) is starting the server on vm-1/);
    // Only what a person reads goes on to the renderer.
    expect((error as InstanceType<typeof ServerBusyError>).holder).toEqual({
      name: 'bob@desk',
      hostAccount: 'bob',
      action: 'starting',
      heldForSeconds: 40,
      expiresInSeconds: 90,
    });
  });

  it('waits, saying who for, and takes it once it is free', async () => {
    vi.useFakeTimers();
    runStateScript
      .mockResolvedValueOnce(reply('held', 1000, lockFile({ expires: 1090, since: 960 })))
      .mockResolvedValueOnce(reply('taken', 1005));
    const onWaiting = vi.fn();

    const taking = acquireServerLock(host, claim, {
      mode: 'wait',
      timing,
      signal: new AbortController().signal,
      onWaiting,
    });
    await vi.advanceTimersByTimeAsync(timing.pollEveryMs);
    const lease = await taking;
    await lease.release();

    expect(onWaiting).toHaveBeenCalledWith({
      name: 'bob@desk',
      hostAccount: 'bob',
      action: 'starting',
      heldForSeconds: 40,
      expiresInSeconds: 90,
    });
    expect(runStateScript.mock.calls.filter((c) => (c[2] as string[])[0] === 'take')).toHaveLength(
      2
    );
  });

  it('stops waiting when cancelled, saying who it was waiting for', async () => {
    runStateScript.mockResolvedValue(reply('held', 1000, lockFile({ expires: 1090, since: 960 })));
    const abort = new AbortController();

    const taking = acquireServerLock(host, claim, {
      mode: 'wait',
      timing,
      signal: abort.signal,
      onWaiting: () => abort.abort(),
    });

    const error = await taking.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerLockWaitCancelled);
    expect((error as InstanceType<typeof ServerLockWaitCancelled>).holder).toMatchObject({
      name: 'bob@desk',
    });
  });

  it('stops waiting when cancelled in the middle of a wait, without asking again', async () => {
    vi.useFakeTimers();
    runStateScript.mockResolvedValue(reply('held', 1000, lockFile({ expires: 1090, since: 960 })));
    const abort = new AbortController();

    const taking = acquireServerLock(host, claim, {
      mode: 'wait',
      timing,
      signal: abort.signal,
      onWaiting: vi.fn(),
    }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(timing.pollEveryMs / 2);
    abort.abort();

    expect(await taking).toBeInstanceOf(ServerLockWaitCancelled);
    expect(runStateScript).toHaveBeenCalledOnce();
  });

  it('does not ask at all when the wait was cancelled before it began', async () => {
    const abort = new AbortController();
    abort.abort();

    await expect(
      acquireServerLock(host, claim, {
        mode: 'wait',
        timing,
        signal: abort.signal,
        onWaiting: vi.fn(),
      })
    ).rejects.toBeInstanceOf(ServerLockWaitCancelled);
    expect(runStateScript).not.toHaveBeenCalled();
  });

  it('refuses an answer that is neither taken nor held', async () => {
    runStateScript.mockResolvedValueOnce(reply('renewed', 1000));

    await expect(acquireServerLock(host, claim, { mode: 'refuse', timing })).rejects.toThrow(
      /Unexpected answer from the server lock on vm-1: renewed/
    );
  });
});

describe('holding the lock', () => {
  function lease() {
    return new ServerLease(host, 'my-token', claim, timing);
  }

  it('renews itself while held, and stops once released', async () => {
    vi.useFakeTimers();
    runStateScript.mockResolvedValue(reply('renewed', 1000));
    const held = lease();

    await vi.advanceTimersByTimeAsync(timing.renewEveryMs * 2);
    expect(runStateScript.mock.calls.map((c) => (c[2] as string[])[0])).toEqual(['renew', 'renew']);

    await held.release();
    await vi.advanceTimersByTimeAsync(timing.renewEveryMs * 2);
    expect(runStateScript.mock.calls.map((c) => (c[2] as string[])[0])).toEqual([
      'renew',
      'renew',
      'release',
    ]);
  });

  it('knows once a renewal finds it taken over, and then refuses without asking again', async () => {
    vi.useFakeTimers();
    runStateScript.mockResolvedValueOnce(
      reply('lost', 1000, lockFile({ expires: 1100, since: 990, name: 'carol@pc' }))
    );
    const held = lease();

    await vi.advanceTimersByTimeAsync(timing.renewEveryMs);

    expect(held.lost).toBe(true);
    const error = await held.assertHeld().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerLockLostError);
    expect((error as InstanceType<typeof ServerLockLostError>).holder).toMatchObject({
      name: 'carol@pc',
    });
    expect(runStateScript).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalled();

    // Nothing of its own left on the host to give back.
    await held.release();
    expect(runStateScript).toHaveBeenCalledOnce();
  });

  it('keeps it through a renewal that could not reach the host, and says so', async () => {
    vi.useFakeTimers();
    runStateScript.mockRejectedValueOnce(new Error('ssh dropped'));
    const held = lease();

    await vi.advanceTimersByTimeAsync(timing.renewEveryMs);

    expect(held.lost).toBe(false);
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringMatching(/could not renew/),
      expect.anything()
    );
    await held.release();
  });

  it('asks the host when asked whether it still holds it', async () => {
    runStateScript.mockResolvedValueOnce(reply('renewed', 1000));
    const held = lease();

    await held.assertHeld();

    expect((runStateScript.mock.calls[0]![2] as string[]).slice(0, 2)).toEqual([
      'renew',
      'my-token',
    ]);
    await held.release();
  });

  it('counts a lock that was removed outright as lost to nobody', async () => {
    runStateScript.mockResolvedValueOnce(reply('lost', 1000));
    const held = lease();

    const error = await held.assertHeld().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServerLockLostError);
    expect((error as InstanceType<typeof ServerLockLostError>).holder).toBeNull();
    await held.release();
  });

  it('gives it back once however often it is released, and logs a failure to', async () => {
    runStateScript.mockRejectedValueOnce(new Error('ssh dropped'));
    const held = lease();

    await held.release();
    await held.release();

    expect(runStateScript).toHaveBeenCalledOnce();
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringMatching(/lapses by itself within 120s/),
      expect.anything()
    );
    await expect(held.assertHeld()).rejects.toThrow(/already released/);
  });
});

describe('looking at the lock', () => {
  it('reads it without creating a volume where there is none', async () => {
    stateVolumeExists.mockResolvedValueOnce(false);

    expect(await readServerLock(host)).toBeNull();
    expect(readStateVolume).not.toHaveBeenCalled();
  });

  it('names a live holder and nobody for a lapsed one', async () => {
    readStateVolume.mockResolvedValueOnce(
      reply('peek', 1000, lockFile({ expires: 1090, since: 960 }))
    );
    expect(await readServerLock(host)).toEqual({
      name: 'bob@desk',
      hostAccount: 'bob',
      action: 'starting',
      heldForSeconds: 40,
      expiresInSeconds: 90,
    });

    readStateVolume.mockResolvedValueOnce(
      reply('peek', 1000, lockFile({ expires: 999, since: 900 }))
    );
    expect(await readServerLock(host)).toBeNull();
  });
});

import { randomBytes, randomUUID } from 'node:crypto';
import { log } from '@main/lib/logger';
import {
  ServerBusyError,
  type ServerLockAction,
  type ServerLockHolder,
} from '@shared/core/managed-switch-server/managed-switch-server';
import {
  readStateVolume,
  runStateScript,
  type StackStateHost,
  stateVolumeExists,
} from './stack-state';
import { LOCK_LOST_MESSAGE, SERVER_LOCK_FILE, UNDER_STATE_MUTEX } from './state-mutex';

/**
 * The lock on a shared remote stack (CHOO-2893): held by whichever Console is
 * changing the stack, so that two Consoles cannot act on it at once.
 *
 * Without it, two Consoles pressing Start on an empty host together both find
 * nothing there, both make credentials, and both publish them and run
 * compose — and whichever publishes second has the stack's database created
 * with credentials nobody else holds. Everything that reads the stack to act
 * on it takes the lock first, so the second Console finds the first one's
 * stack and joins it.
 *
 * It lives in the stack's state volume, beside the published settings, which
 * every Console using the stack can write and which a reset keeps. It is a
 * lease: held for {@link LockTiming.ttlSeconds} at a time and renewed while
 * its holder works, so a Console that crashes or loses its network holds it
 * for at most that long. Expiry is decided by the host's clock inside the
 * script, never a desktop's. Taking and renewing happen under the state mutex
 * (state-mutex.ts), so exactly one of two Consoles taking it at once — or
 * taking over the same lapsed lease — gets it.
 *
 * A Console that lost its lease while away can come back and carry on, so the
 * writes that decide a stack's credentials check the token in the same step
 * (`WHILE_HOLDING_SERVER_LOCK`), and compose is only run after
 * {@link ServerLease.assertHeld}.
 */

/** This run of this Console. A Console restarted after a crash takes back a
 * lease its previous run left, rather than waiting for it to lapse; a lease
 * held by this same run — another operation on the same host under a second
 * alias — it waits for like anyone else's. */
export const CONSOLE_INSTANCE = randomUUID();

export type LockTiming = {
  /** How long a lease lasts from its last renewal. */
  ttlSeconds: number;
  renewEveryMs: number;
  /** The longest one lease can be held, however often it is renewed, so a
   * Console that hangs while renewing cannot keep everyone out. Longer than
   * anything a start can legitimately take: a backup may run 30 minutes and
   * compose 20. */
  maxHoldSeconds: number;
  /** How often a Console waiting for the lock tries again. */
  pollEveryMs: number;
};

export const SERVER_LOCK_TIMING: LockTiming = {
  ttlSeconds: 120,
  renewEveryMs: 30_000,
  maxHoldSeconds: 90 * 60,
  pollEveryMs: 5_000,
};

/** Who is taking the lock, and for what — what the others are shown while
 * they wait. */
export type LockClaim = {
  consoleId: string;
  instance: string;
  name: string;
  hostAccount: string;
  action: ServerLockAction;
};

const LOCK_ACTIONS: readonly ServerLockAction[] = [
  'starting',
  'updating',
  'connecting',
  'checking',
  'stopping',
  'resetting',
];

/** First line of the lock file. A later format must keep the expiry on the
 * third line and the token on the second, which is all an older Console reads
 * of it. */
const LOCK_MAGIC = 'switch-console-lock v1';

/**
 * `$1` is the operation — `take`, `renew` or `release` — and `$2…$9` the
 * token, console id, run, action, lease length and longest hold in seconds,
 * name and host account. Answers on stdout: a status line, the host's clock,
 * then the lock file as it now stands, so a refusal can say who holds it.
 * Exported for the test that runs it against a real volume.
 */
export const LOCK_SCRIPT = [
  'set -u',
  'op=$1 token=$2 console=$3 instance=$4 action=$5 ttl=$6 max=$7 name=$8 account=$9',
  'umask 077',
  UNDER_STATE_MUTEX,
  `lock=${SERVER_LOCK_FILE}`,
  'now=$(date +%s)',
  'line() { sed -n "$1p" "$lock" 2>/dev/null; }',
  'number() { case $1 in ""|*[!0-9]*) return 1;; esac; }',
  'held=$(line 2) expires=$(line 3) since=$(line 4)',
  'report() { printf "%s\\n%s\\n" "$1" "$now"; [ -f "$lock" ] && cat "$lock"; exit 0; }',
  'until_for() { u=$((now + ttl)); c=$(($1 + max)); [ "$u" -gt "$c" ] && u=$c; echo "$u"; }',
  'case $op in',
  '  take)',
  '    if [ -f "$lock" ] && number "$expires" && [ "$expires" -gt "$now" ]; then',
  '      [ "$(line 5)" = "$console" ] && [ "$(line 6)" != "$instance" ] || report held',
  '    fi',
  `    printf "%s\\n" "${LOCK_MAGIC}" "$token" "$(until_for "$now")" "$now" "$console" "$instance" "$action" "$name" "$account" > /state/.lock.tmp`,
  '    mv /state/.lock.tmp "$lock"',
  '    report taken ;;',
  '  renew)',
  '    [ -n "$held" ] && [ "$held" = "$token" ] && number "$since" || report lost',
  '    u=$(until_for "$since")',
  '    [ "$u" -gt "$now" ] || report lost',
  '    sed "3s/.*/$u/" "$lock" > /state/.lock.tmp',
  '    mv /state/.lock.tmp "$lock"',
  '    report renewed ;;',
  '  release)',
  '    if [ -n "$held" ] && [ "$held" = "$token" ]; then rm -f "$lock"; report released; fi',
  '    report other ;;',
  '  *) echo "unknown lock operation: $op" >&2; exit 2 ;;',
  'esac',
].join('\n');

/** Prints the host's clock and the lock file, for a look that changes nothing. */
const PEEK_SCRIPT = [
  'printf "%s\\n%s\\n" peek "$(date +%s)"',
  `[ -f ${SERVER_LOCK_FILE} ] && cat ${SERVER_LOCK_FILE}`,
  'true',
].join('\n');

type LockStatus = 'taken' | 'held' | 'renewed' | 'lost' | 'released' | 'other' | 'peek';

export type LockReply = {
  status: LockStatus;
  /** Whoever the lock file names, lapsed or not; null when there is none. */
  holder: (ServerLockHolder & { live: boolean }) | null;
};

const STATUSES: readonly LockStatus[] = [
  'taken',
  'held',
  'renewed',
  'lost',
  'released',
  'other',
  'peek',
];

/** Read a {@link LOCK_SCRIPT} or peek answer. Throws on anything else: a lock
 * that cannot be understood must not be taken for one that is free. */
export function parseLockReply(stdout: string): LockReply {
  const [status = '', clock = '', ...file] = stdout.split('\n');
  const now = Number(clock);
  if (!(STATUSES as readonly string[]).includes(status) || !Number.isFinite(now)) {
    throw new Error(`Unexpected answer from the server lock: ${stdout.trim().slice(0, 200)}`);
  }
  if (file.length < 9 || file[1] === '') return { status: status as LockStatus, holder: null };
  const expires = Number(file[2]);
  const since = Number(file[3]);
  const action = file[6] ?? '';
  const known = (LOCK_ACTIONS as readonly string[]).includes(action);
  if (!known)
    log.warn('stack-lock: the lock names an action this Console does not know', { action });
  return {
    status: status as LockStatus,
    holder: {
      name: file[7] || 'unknown',
      hostAccount: file[8] || 'unknown',
      action: known ? (action as ServerLockAction) : 'checking',
      heldForSeconds: Number.isFinite(since) ? Math.max(0, now - since) : 0,
      expiresInSeconds: Number.isFinite(expires) ? Math.max(0, expires - now) : 0,
      live: Number.isFinite(expires) && expires > now,
    },
  };
}

/** A holder as others are shown it: whether it is live is this module's
 * business, and is not sent on to the status, a refusal or the renderer. */
function shownHolder(holder: ServerLockHolder & { live: boolean }): ServerLockHolder {
  return {
    name: holder.name,
    hostAccount: holder.hostAccount,
    action: holder.action,
    heldForSeconds: holder.heldForSeconds,
    expiresInSeconds: holder.expiresInSeconds,
  };
}

/** A Console id is our own random UUID; the script compares it as text. */
const CONSOLE_ID = /^[0-9A-Fa-f-]{1,64}$/;

/** One line each in the lock file, which is read line by line. */
function oneLine(text: string): string {
  let printable = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    printable += code < 0x20 || code === 0x7f ? ' ' : text[i];
  }
  return printable.trim().slice(0, 200) || 'unknown';
}

function scriptArgs(
  op: 'take' | 'renew' | 'release',
  token: string,
  claim: LockClaim,
  timing: LockTiming
): string[] {
  return [
    op,
    token,
    claim.consoleId,
    claim.instance,
    claim.action,
    String(timing.ttlSeconds),
    String(timing.maxHoldSeconds),
    oneLine(claim.name),
    oneLine(claim.hostAccount),
  ];
}

/** The lock was taken over by another Console while this one held it. */
export class ServerLockLostError extends Error {
  constructor(readonly holder: ServerLockHolder | null) {
    super(LOCK_LOST_MESSAGE);
    this.name = 'ServerLockLostError';
  }
}

/** The wait for the lock was cancelled; nothing was changed. */
export class ServerLockWaitCancelled extends Error {
  constructor(readonly holder: ServerLockHolder | null) {
    super('Stopped waiting for the server, so nothing was changed.');
    this.name = 'ServerLockWaitCancelled';
  }
}

/**
 * A held lock. Renews itself every {@link LockTiming.renewEveryMs} until
 * released, and notices when a renewal finds it taken over — after which
 * {@link assertHeld} throws without asking the host again. Release it in a
 * `finally`; releasing twice is harmless.
 */
export class ServerLease {
  private released = false;
  private lostTo: { holder: ServerLockHolder | null } | null = null;
  private renewing: Promise<void> | null = null;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly host: StackStateHost,
    readonly token: string,
    private readonly claim: LockClaim,
    private readonly timing: LockTiming
  ) {
    this.timer = setInterval(() => this.renewInBackground(), timing.renewEveryMs);
    this.timer.unref?.();
  }

  /** Whether a renewal has found the lock taken over. */
  get lost(): boolean {
    return this.lostTo !== null;
  }

  private async renew(): Promise<void> {
    const reply = parseLockReply(
      await runStateScript(
        this.host,
        LOCK_SCRIPT,
        scriptArgs('renew', this.token, this.claim, this.timing)
      )
    );
    if (reply.status === 'renewed') return;
    const holder = reply.holder?.live ? shownHolder(reply.holder) : null;
    this.lostTo = { holder };
    log.error(`stack-lock: lost the lock on ${this.host.label} while holding it`, {
      action: this.claim.action,
      holder,
    });
    throw new ServerLockLostError(holder);
  }

  private renewInBackground(): void {
    if (this.released || this.lostTo || this.renewing) return;
    this.renewing = this.renew()
      .catch((error: unknown) => {
        // Losing it is recorded by renew; anything else is a failure to ask,
        // which the next renewal retries — the lease runs for several of them.
        if (!(error instanceof ServerLockLostError)) {
          log.warn(`stack-lock: could not renew the lock on ${this.host.label}; retrying`, {
            error,
          });
        }
      })
      .finally(() => {
        this.renewing = null;
      });
  }

  /** Renew now, and throw {@link ServerLockLostError} if the lock is no longer
   * this lease's. Called before anything that cannot check it in the same step. */
  async assertHeld(): Promise<void> {
    if (this.released) throw new Error('This server lock was already released.');
    if (this.lostTo) throw new ServerLockLostError(this.lostTo.holder);
    await this.renew();
  }

  /** Give the lock back. A failure to reach the host is logged, not thrown:
   * the operation it guarded is over either way, and the lease lapses by
   * itself within {@link LockTiming.ttlSeconds}. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    clearInterval(this.timer);
    if (this.lostTo) return;
    try {
      await this.renewing;
      await runStateScript(
        this.host,
        LOCK_SCRIPT,
        scriptArgs('release', this.token, this.claim, this.timing)
      );
    } catch (error) {
      log.warn(
        `stack-lock: could not release the lock on ${this.host.label}; it lapses by itself ` +
          `within ${this.timing.ttlSeconds}s`,
        { error }
      );
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Aborted while the lock was being asked for: the listener below would
    // never hear it.
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export type AcquireOptions =
  /** Wait for whoever holds it, telling `onWaiting` who that is each time the
   * lock is found held, until it is free or `signal` aborts. */
  | {
      mode: 'wait';
      timing: LockTiming;
      signal: AbortSignal;
      onWaiting: (holder: ServerLockHolder) => void;
    }
  /** Throw `ServerBusyError` at once if someone else holds it. */
  | { mode: 'refuse'; timing: LockTiming };

/** Take the lock on the stack on `host` for `claim`. */
export async function acquireServerLock(
  host: StackStateHost,
  claim: LockClaim,
  opts: AcquireOptions
): Promise<ServerLease> {
  if (!CONSOLE_ID.test(claim.consoleId)) {
    throw new Error(
      `Refusing to take a server lock for a console id that is not one: ${claim.consoleId}`
    );
  }
  const token = randomBytes(16).toString('hex');
  let last: ServerLockHolder | null = null;
  for (;;) {
    if (opts.mode === 'wait' && opts.signal.aborted) throw new ServerLockWaitCancelled(last);
    const reply = parseLockReply(
      await runStateScript(host, LOCK_SCRIPT, scriptArgs('take', token, claim, opts.timing))
    );
    if (reply.status === 'taken') return new ServerLease(host, token, claim, opts.timing);
    if (reply.status !== 'held' || reply.holder === null) {
      throw new Error(`Unexpected answer from the server lock on ${host.label}: ${reply.status}`);
    }
    last = shownHolder(reply.holder);
    if (opts.mode === 'refuse') throw new ServerBusyError(last, host.label);
    opts.onWaiting(last);
    try {
      await sleep(opts.timing.pollEveryMs, opts.signal);
    } catch {
      throw new ServerLockWaitCancelled(last);
    }
  }
}

/** Who holds the lock on the stack on `host` right now, or null — a look that
 * changes nothing, and creates no volume where there is none. */
export async function readServerLock(host: StackStateHost): Promise<ServerLockHolder | null> {
  if (!(await stateVolumeExists(host))) return null;
  const { holder } = parseLockReply(await readStateVolume(host, PEEK_SCRIPT));
  return holder?.live ? shownHolder(holder) : null;
}

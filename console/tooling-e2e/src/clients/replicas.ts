import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ReplicasEnv } from '../core/env.ts';

const run = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export type ReplicaId = 1 | 2;
export const REPLICA_IDS: readonly ReplicaId[] = [1, 2];

/** Which replica a process id names: each runs as `replica-<n>-<suffix>`. */
export function replicaOf(processId: string | null): ReplicaId | null {
  const match = processId === null ? null : /^replica-([12])-/.exec(processId);
  return match ? (Number(match[1]) as ReplicaId) : null;
}

export function otherThan(replica: ReplicaId): ReplicaId {
  return replica === 1 ? 2 : 1;
}

/** One `ownership_leases` row, as `properties/history/ownership.py` reads it. */
export interface Holder {
  key: string;
  processId: string | null;
  token: number;
  /** Whether the holder's process lease holds, by the database's clock. */
  live: boolean;
}

/** The product's timers a fault scenario's waits come from, in seconds. */
export interface Timers {
  /** How long a process lease holds unrenewed (`process_lease.LEASE_TTL`). */
  leaseTtl: number;
  /** How often every process balances its work (`ownership.BALANCE_INTERVAL_SECONDS`). */
  balanceInterval: number;
  /** How often a process renews its lease (`process_lease.RENEW_EVERY_SECONDS`). */
  renewEvery: number;
}

export interface Ownership {
  holders: Holder[];
  processes: { id: string; live: boolean }[];
  timers: Timers;
}

/** A replica's log from some point on: one parsed record per line. */
export interface LogRecord {
  timestamp: string;
  status: string;
  message: string;
  process_id?: string;
}

const BACKEND = { 1: 'one', 2: 'two' } as const;

/**
 * The replicas of a two-replica stack (`ephemeral-stack.sh --replicas 2`), for
 * scenarios that fault them: stop one as a crash (`SIGKILL`) or a deploy
 * (`SIGTERM`) does, pause and resume it (`SIGSTOP`/`SIGCONT`, which lets its
 * lease lapse without its knowing), start it again, and take it out of
 * HAProxy's rotation, severing its sessions, and put it back.
 *
 * Every fault is undone by `restore`, which a scenario registers with its
 * fixtures, so the next scenario starts on two healthy replicas whether or
 * not this one passed.
 */
export class Replicas {
  private readonly paused = new Set<ReplicaId>();
  private readonly drained = new Set<ReplicaId>();

  private readonly env: ReplicasEnv;
  private readonly log: (message: string) => void;

  constructor(env: ReplicasEnv, log: (message: string) => void) {
    this.env = env;
    this.log = log;
  }

  pid(replica: ReplicaId): number {
    return Number(readFileSync(path.join(this.env.pidDir, `${replica}.pid`), 'utf8').trim());
  }

  running(replica: ReplicaId): boolean {
    try {
      process.kill(this.pid(replica), 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stop a replica: `SIGKILL` as a crash, which writes nothing on its way
   * out, or `SIGTERM` as a deploy, which lets go of its work and marks its
   * lease stopped. Returns once the process is gone.
   */
  async stop(replica: ReplicaId, signal: 'SIGKILL' | 'SIGTERM'): Promise<void> {
    const pid = this.pid(replica);
    this.log(`replica ${replica} (pid ${pid}): ${signal}`);
    if (this.paused.has(replica)) {
      process.kill(pid, 'SIGCONT');
      this.paused.delete(replica);
    }
    process.kill(pid, signal);
    const deadline = Date.now() + 60_000;
    while (this.running(replica)) {
      if (Date.now() > deadline) {
        throw new Error(`replica ${replica} (pid ${pid}) did not exit within 60s of ${signal}`);
      }
      await sleep(200);
    }
  }

  pause(replica: ReplicaId): void {
    this.log(`replica ${replica} (pid ${this.pid(replica)}): SIGSTOP`);
    process.kill(this.pid(replica), 'SIGSTOP');
    this.paused.add(replica);
  }

  resume(replica: ReplicaId): void {
    this.log(`replica ${replica} (pid ${this.pid(replica)}): SIGCONT`);
    process.kill(this.pid(replica), 'SIGCONT');
    this.paused.delete(replica);
  }

  /** Start a stopped replica again, under a new process id; returns once it answers. */
  async start(replica: ReplicaId): Promise<void> {
    this.log(`replica ${replica}: starting again`);
    await run(this.env.startScript, [String(replica)], { env: process.env, timeout: 180_000 });
  }

  /**
   * Take a replica out of rotation and close every session HAProxy holds to
   * it, WebSockets included, so clients reconnect through the other. The
   * replica itself keeps running.
   */
  async drain(replica: ReplicaId): Promise<void> {
    this.log(`replica ${replica}: out of rotation`);
    for (const backend of ['replicas', 'callback_replicas']) {
      await this.admin(`set server ${backend}/${BACKEND[replica]} state maint`);
      await this.admin(`shutdown sessions server ${backend}/${BACKEND[replica]}`);
    }
    this.drained.add(replica);
  }

  async undrain(replica: ReplicaId): Promise<void> {
    this.log(`replica ${replica}: back in rotation`);
    for (const backend of ['replicas', 'callback_replicas']) {
      await this.admin(`set server ${backend}/${BACKEND[replica]} state ready`);
    }
    this.drained.delete(replica);
  }

  /**
   * HAProxy's view of a replica on the API backend: `UP`, `DOWN`, `MAINT`, or
   * a transition such as `UP 1/2`.
   */
  async rotation(replica: ReplicaId): Promise<string> {
    const lines = (await this.ask('show stat')).split('\n');
    const header = (lines[0] ?? '').replace(/^# /, '').split(',');
    const status = header.indexOf('status');
    for (const line of lines.slice(1)) {
      const fields = line.split(',');
      if (fields[0] === 'replicas' && fields[1] === BACKEND[replica]) return fields[status] ?? '';
    }
    throw new Error(`HAProxy's stats name no server replicas/${BACKEND[replica]}`);
  }

  /**
   * Wait until HAProxy's checks agree with `state`: a replica just stopped or
   * paused still takes requests until its checks fail, and one just started
   * takes none until they pass.
   */
  async waitForRotation(replica: ReplicaId, state: 'UP' | 'DOWN', deadlineMs: number): Promise<void> {
    const until = Date.now() + deadlineMs;
    let last = '';
    while (Date.now() < until) {
      last = await this.rotation(replica);
      if (last === state) return;
      await sleep(250);
    }
    throw new Error(`replica ${replica} is still ${last} to HAProxy after ${deadlineMs}ms, not ${state}`);
  }

  /**
   * Undo every fault: both replicas running, unpaused and in rotation, and the
   * work of `kind` settled where it now belongs, each piece held by a live
   * process that has held it for a whole balance, so the next scenario does
   * not start in the middle of a hand-over.
   */
  async restore(kinds: readonly string[]): Promise<void> {
    for (const replica of REPLICA_IDS) {
      if (this.paused.has(replica)) this.resume(replica);
      if (!this.running(replica)) await this.start(replica);
      if (this.drained.has(replica)) await this.undrain(replica);
      await this.waitForRotation(replica, 'UP', 30_000);
    }
    for (const kind of kinds) await this.settled(kind);
  }

  /** Wait until every piece of `kind` has had the same live holder for two balances. */
  async settled(kind: string): Promise<Ownership> {
    const until = Date.now() + 120_000;
    let before = '';
    let ownership = await this.ownership(kind);
    while (Date.now() < until) {
      const live = new Set(ownership.processes.filter((p) => p.live).map((p) => replicaOf(p.id)));
      // A row let go of (no holder) is work that no longer runs: a bridge removed.
      const held = ownership.holders.filter((h) => h.processId !== null);
      const now = JSON.stringify(held.map((h) => [h.key, h.processId, h.live]));
      if (now === before && live.has(1) && live.has(2) && held.every((h) => h.live)) {
        return ownership;
      }
      before = now;
      await sleep(2 * ownership.timers.balanceInterval * 1000);
      ownership = await this.ownership(kind);
    }
    throw new Error(`the ${kind} work did not settle on two live replicas within 120s: ${JSON.stringify(ownership)}`);
  }

  /** Who holds each piece of work of `kind`, and the timers that bound a hand-over. */
  async ownership(kind: string): Promise<Ownership> {
    const { stdout } = await run(
      'uv',
      [
        'run',
        '--project',
        path.join(REPO_ROOT, 'core'),
        'python',
        path.join(REPO_ROOT, 'properties', 'history', 'ownership.py'),
        '--kind',
        kind,
      ],
      { env: process.env, timeout: 60_000 }
    );
    const raw = JSON.parse(stdout) as {
      holders: { key: string; process_id: string | null; token: number; live: boolean }[];
      processes: { id: string; live: boolean }[];
      timers: { lease_ttl: number; balance_interval: number; renew_every: number };
    };
    return {
      holders: raw.holders.map((h) => ({
        key: h.key,
        processId: h.process_id,
        token: h.token,
        live: h.live,
      })),
      processes: raw.processes,
      timers: {
        leaseTtl: raw.timers.lease_ttl,
        balanceInterval: raw.timers.balance_interval,
        renewEvery: raw.timers.renew_every,
      },
    };
  }

  /** Where a replica's log ends now, to read what it logs from here on. */
  logMark(replica: ReplicaId): number {
    return statSync(this.logPath(replica)).size;
  }

  /** What a replica logged since `mark`, parsed; lines that are not JSON are skipped. */
  logSince(replica: ReplicaId, mark: number): LogRecord[] {
    const text = readFileSync(this.logPath(replica)).subarray(mark).toString('utf8');
    const records: LogRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        records.push(JSON.parse(line) as LogRecord);
      } catch {
        // A line still being written; the next read has it whole.
      }
    }
    return records;
  }

  private logPath(replica: ReplicaId): string {
    return path.join(this.env.logDir, `switch-core-${replica}.log`);
  }

  /** One command to HAProxy's runtime API; an answer other than empty is an error. */
  private async admin(command: string): Promise<void> {
    const said = (await this.ask(command)).trim();
    if (said !== '') throw new Error(`HAProxy refused '${command}': ${said}`);
  }

  /** One command to HAProxy's runtime API, and its answer. */
  private ask(command: string): Promise<string> {
    const [host, port] = this.env.haproxyAdmin.split(':');
    return new Promise((resolve, reject) => {
      const socket = connect(Number(port), host, () => socket.end(`${command}\n`));
      let answer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        answer += chunk;
      });
      socket.on('error', reject);
      socket.on('close', () => resolve(answer));
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The run-once work whose hand-over a fault scenario waits out before the
 * next scenario starts: the collaboration bridges (`BRIDGE_CONNECTIONS`).
 */
export const REPLICA_KINDS: readonly string[] = ['bridge'];

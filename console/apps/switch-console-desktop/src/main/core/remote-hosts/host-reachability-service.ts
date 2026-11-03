import { EventEmitter } from 'node:events';
import {
  type HostReachability,
  type HostReachabilityStatus,
  HostUnreachableError,
  isHostBlocked,
  unknownHostReachability,
} from '@shared/core/remote-hosts/reachability';
import type { SshConnectionEvent } from '@shared/core/ssh/sshEvents';
import {
  deletePersistedReachability,
  hydrate,
  listPersistedReachability,
  listSshHostsInUse,
  savePersistedReachability,
  type PersistedHostReachability,
} from './reachability-store';

/**
 * Backoff schedule between probes of an unreachable host, capped at five
 * minutes and repeated.
 *
 * The early steps stay tight because the common cause is a credential the user
 * is actively re-establishing (VPN, `aws sso login`) and they expect the app to
 * notice quickly; the long tail keeps a host that is genuinely gone from
 * costing anything. Manual retry short-circuits the whole schedule, so the cap
 * only governs the unattended case.
 */
const PROBE_BACKOFF_MS = [1_000, 5_000, 15_000, 30_000, 60_000, 300_000];

export function probeDelayFor(consecutiveFailures: number): number {
  const step = Math.min(Math.max(consecutiveFailures, 1), PROBE_BACKOFF_MS.length);
  return PROBE_BACKOFF_MS[step - 1]!;
}

/** Probes a host's transport. Resolves on success, throws on failure. */
export type HostProbe = (sshHost: string) => Promise<void>;

/** Distinguishes a rejected credential (no point retrying) from a dead network. */
export type AuthErrorPredicate = (error: unknown) => boolean;

export type HostReachabilityLog = {
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
};

export type HostReachabilityServiceDeps = {
  probe: HostProbe;
  isAuthError: AuthErrorPredicate;
  publish: (reachability: HostReachability) => void;
  log: HostReachabilityLog;
  /** Injected so tests can drive the backoff without real timers. */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  now?: () => number;
};

type HostEntry = {
  reachability: HostReachability;
  timer?: NodeJS.Timeout;
  /** In-flight probe, so concurrent callers coalesce onto one round trip. */
  inFlight?: Promise<HostReachability>;
  /** Saves run one after another, so the last state written is the last one set. */
  saving?: Promise<void>;
};

export type HostReachabilityChange = {
  previous: HostReachabilityStatus;
  current: HostReachability;
};

/**
 * The single source of truth for whether a remote SSH host can be reached.
 *
 * One probe loop per host, shared by every consumer: ten agents on a dead host
 * produce one probe per backoff step, not ten reconnect storms. Consumers ask
 * `isBlocked`/`requireReachable` before doing host-dependent work and subscribe
 * to `change` to resume when a host comes back.
 */
export class HostReachabilityService extends EventEmitter {
  private readonly deps: Required<HostReachabilityServiceDeps>;
  private readonly hosts = new Map<string, HostEntry>();
  /** Hosts released as unused: failures reported for them are not tracked until a probe or success adopts them again. */
  private readonly forgotten = new Set<string>();
  private loaded = false;

  constructor(deps: HostReachabilityServiceDeps) {
    super();
    this.deps = {
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (timer) => clearTimeout(timer),
      now: () => Date.now(),
      ...deps,
    };
  }

  /**
   * Load persisted state so the app boots knowing which hosts were down. Hosts
   * that were unreachable at shutdown get a probe scheduled rather than being
   * hammered by every consumer at once on startup. Records for hosts nothing
   * uses any more are deleted instead, so a forgotten host is never dialled.
   */
  async initialize(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const [persisted, inUse] = await Promise.all([
      listPersistedReachability(),
      listSshHostsInUse(),
    ]);
    for (const record of persisted) {
      if (!inUse.has(record.sshHost)) {
        await deletePersistedReachability(record.sshHost);
        this.deps.log.info('HostReachabilityService: pruned reachability of unused host', {
          sshHost: record.sshHost,
        });
        continue;
      }
      const reachability = hydrate(record);
      this.hosts.set(record.sshHost, { reachability });
      if (isHostBlocked(reachability) && reachability.status !== 'suspended') {
        this.scheduleProbe(record.sshHost);
      }
    }
    this.deps.log.info('HostReachabilityService: restored persisted host reachability', {
      hosts: persisted.length,
    });
  }

  get(sshHost: string): HostReachability {
    return this.entry(sshHost).reachability;
  }

  getAll(): HostReachability[] {
    return [...this.hosts.values()].map((entry) => entry.reachability);
  }

  /** True when host-dependent work should be held back for this host. */
  isBlocked(sshHost: string): boolean {
    return isHostBlocked(this.get(sshHost));
  }

  /**
   * Gate for host-dependent work. Throws `HostUnreachableError` immediately —
   * with the modeled reason — instead of letting the caller discover the
   * failure through a 20-second SSH timeout.
   */
  requireReachable(sshHost: string): void {
    const reachability = this.get(sshHost);
    if (isHostBlocked(reachability)) throw new HostUnreachableError(reachability);
  }

  /**
   * Record that a host was just reached successfully by real work (not a
   * probe). Lets ordinary traffic keep the record fresh so a busy host is
   * never probed redundantly.
   */
  reportSuccess(sshHost: string): void {
    this.forgotten.delete(sshHost);
    const entry = this.entry(sshHost);
    if (entry.reachability.status === 'reachable') return;
    this.cancelProbe(entry);
    void this.transition(entry, sshHost, {
      status: 'reachable',
      lastError: null,
      consecutiveFailures: 0,
    });
  }

  /**
   * Record that host-dependent work failed at the transport level. Moves the
   * host into `unreachable` (or `suspended` for auth) and starts the shared
   * backoff probe, so the failing caller does not have to retry on its own.
   */
  reportFailure(sshHost: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const entry = this.entry(sshHost);
    const status: HostReachabilityStatus = this.deps.isAuthError(error)
      ? 'suspended'
      : 'unreachable';
    void this.transition(entry, sshHost, {
      status,
      lastError: message,
      consecutiveFailures: entry.reachability.consecutiveFailures + 1,
    }).then(() => {
      if (status === 'unreachable' && this.hosts.get(sshHost) === entry) {
        this.scheduleProbe(sshHost);
      }
    });
  }

  /**
   * Probe now, bypassing the backoff — the "Retry connection" path. Also used
   * to validate a host before it is adopted (e.g. the add-agent modal), so
   * validation and background recovery share one code path.
   */
  async checkNow(sshHost: string): Promise<HostReachability> {
    this.forgotten.delete(sshHost);
    const entry = this.entry(sshHost);
    if (entry.inFlight) return entry.inFlight;
    this.cancelProbe(entry);

    const run = (async (): Promise<HostReachability> => {
      this.setProbing(sshHost, true);
      try {
        await this.deps.probe(sshHost);
        if (this.hosts.get(sshHost) !== entry) return entry.reachability;
        return await this.transition(entry, sshHost, {
          status: 'reachable',
          lastError: null,
          consecutiveFailures: 0,
        });
      } catch (error) {
        if (this.hosts.get(sshHost) !== entry) return entry.reachability;
        const message = error instanceof Error ? error.message : String(error);
        const status: HostReachabilityStatus = this.deps.isAuthError(error)
          ? 'suspended'
          : 'unreachable';
        const next = await this.transition(entry, sshHost, {
          status,
          lastError: message,
          consecutiveFailures: entry.reachability.consecutiveFailures + 1,
        });
        if (status === 'unreachable' && this.hosts.get(sshHost) === entry) {
          this.scheduleProbe(sshHost);
        }
        return next;
      } finally {
        entry.inFlight = undefined;
        if (this.hosts.get(sshHost) === entry) this.setProbing(sshHost, false);
      }
    })();

    entry.inFlight = run;
    return run;
  }

  /**
   * Fold the pooled connection's own lifecycle into the host model, so a host
   * that recovers (or dies) through ordinary session traffic updates the shared
   * state without waiting for the next probe.
   */
  handleSshConnectionEvent(sshHost: string, event: SshConnectionEvent): void {
    if (event.type === 'connected' || event.type === 'reconnected') {
      this.reportSuccess(sshHost);
      return;
    }
    if (event.type === 'reconnect-failed') {
      const entry = this.entry(sshHost);
      void this.transition(entry, sshHost, {
        status: 'suspended',
        lastError: entry.reachability.lastError ?? 'SSH authentication failed',
        consecutiveFailures: entry.reachability.consecutiveFailures + 1,
      });
      return;
    }
    if (event.type === 'error') {
      this.reportFailure(sshHost, new Error(event.errorMessage));
    }
  }

  /** After a system resume every host is suspect — re-probe the blocked ones. */
  handleSystemResume(): void {
    for (const [sshHost, entry] of this.hosts) {
      if (isHostBlocked(entry.reachability)) void this.checkNow(sshHost);
    }
  }

  /**
   * Drop a host's state back to unknown: cancel its probe and delete its
   * persisted record once any save already in flight has landed. A probe still
   * in flight settles without saving it back.
   */
  async reset(sshHost: string): Promise<void> {
    const entry = this.hosts.get(sshHost);
    this.hosts.delete(sshHost);
    if (entry) {
      this.cancelProbe(entry);
      await entry.saving;
    }
    await deletePersistedReachability(sshHost);
    this.deps.publish(unknownHostReachability(sshHost));
  }

  /**
   * Stop tracking a host nothing uses any more. Until a probe or a success
   * adopts it again, failures reported for it neither save nor schedule probes.
   */
  async forget(sshHost: string): Promise<void> {
    this.forgotten.add(sshHost);
    await this.reset(sshHost);
  }

  /** Stop all timers (app shutdown / tests). */
  dispose(): void {
    for (const entry of this.hosts.values()) this.cancelProbe(entry);
  }

  private entry(sshHost: string): HostEntry {
    let entry = this.hosts.get(sshHost);
    if (!entry) {
      entry = { reachability: unknownHostReachability(sshHost) };
      if (!this.forgotten.has(sshHost)) this.hosts.set(sshHost, entry);
    }
    return entry;
  }

  private setProbing(sshHost: string, probing: boolean): void {
    const entry = this.entry(sshHost);
    if (entry.reachability.probing === probing) return;
    entry.reachability = { ...entry.reachability, probing };
    this.deps.publish(entry.reachability);
  }

  private async transition(
    entry: HostEntry,
    sshHost: string,
    patch: Pick<HostReachability, 'status' | 'lastError' | 'consecutiveFailures'>
  ): Promise<HostReachability> {
    const previous = entry.reachability.status;
    const checkedAt = new Date(this.deps.now()).toISOString();

    const next: HostReachability = {
      ...entry.reachability,
      ...patch,
      sshHost,
      lastCheckedAt: checkedAt,
      lastReachableAt:
        patch.status === 'reachable' ? checkedAt : entry.reachability.lastReachableAt,
      nextProbeAt: patch.status === 'reachable' ? null : entry.reachability.nextProbeAt,
    };
    entry.reachability = next;
    if (this.hosts.get(sshHost) !== entry) return next;

    // Log only on a status change: an unreachable host must be loud once, not
    // once per retry — the log spam was half of what CHOO-1682 reports.
    if (previous !== next.status) {
      const metadata = { sshHost, previous, status: next.status, error: next.lastError };
      if (next.status === 'reachable') {
        this.deps.log.info('HostReachabilityService: host reachable', metadata);
      } else {
        this.deps.log.warn('HostReachabilityService: host state changed', metadata);
      }
    }

    this.deps.publish(next);
    if (previous !== next.status) {
      this.emit('change', { previous, current: next } satisfies HostReachabilityChange);
    }

    const saving = (entry.saving ?? Promise.resolve()).then(() => this.persist(next));
    entry.saving = saving;
    await saving;
    return next;
  }

  private async persist(reachability: HostReachability): Promise<void> {
    const record: PersistedHostReachability = {
      sshHost: reachability.sshHost,
      status: reachability.status,
      lastError: reachability.lastError,
      lastCheckedAt: reachability.lastCheckedAt,
      lastReachableAt: reachability.lastReachableAt,
      consecutiveFailures: reachability.consecutiveFailures,
    };
    try {
      await savePersistedReachability(record);
    } catch (error) {
      // Persistence is a convenience (surviving restart); losing it must not
      // take down the in-memory model every consumer depends on.
      this.deps.log.warn('HostReachabilityService: failed to persist reachability', {
        sshHost: reachability.sshHost,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleProbe(sshHost: string): void {
    const entry = this.entry(sshHost);
    this.cancelProbe(entry);
    if (entry.reachability.status === 'suspended') return;

    const delayMs = probeDelayFor(entry.reachability.consecutiveFailures);
    entry.reachability = {
      ...entry.reachability,
      nextProbeAt: new Date(this.deps.now() + delayMs).toISOString(),
    };
    this.deps.publish(entry.reachability);

    entry.timer = this.deps.setTimer(() => {
      entry.timer = undefined;
      void this.checkNow(sshHost);
    }, delayMs);
  }

  private cancelProbe(entry: HostEntry): void {
    if (entry.timer) {
      this.deps.clearTimer(entry.timer);
      entry.timer = undefined;
    }
    if (entry.reachability.nextProbeAt !== null) {
      entry.reachability = { ...entry.reachability, nextProbeAt: null };
    }
  }
}

import { EventEmitter } from 'node:events';
import ssh2, { type Client, type ConnectConfig } from 'ssh2';
import type { ConnectionState, SshHealthState } from '@shared/core/ssh/ssh';
import type { SshConnectionEvent } from '@shared/core/ssh/sshEvents';
import type { SshConnectResult } from '../connect/resolve-ssh-connect-config';
import { isSshChannelOpenFailure, isSshChannelTimeout } from './ssh-channel-open-failure';
import { SshClientProxy } from './ssh-client-proxy';

const { Client: Ssh2Client } = ssh2;

// ─── Error classes ────────────────────────────────────────────────────────────

export class SshAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshAuthError';
  }
}

export class SshTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshTimeoutError';
  }
}

export class SshConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshConnectionError';
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type SshConnectionManagerEvent =
  | { type: 'connecting'; connectionId: string }
  | { type: 'connected'; connectionId: string; proxy: SshClientProxy }
  | { type: 'disconnected'; connectionId: string }
  | { type: 'reconnecting'; connectionId: string; attempt: number; delayMs: number }
  | { type: 'reconnected'; connectionId: string; proxy: SshClientProxy }
  | { type: 'reconnect-failed'; connectionId: string }
  | { type: 'error'; connectionId: string; error: Error };

/**
 * Resolves a fresh ssh2 ConnectConfig (and proxy transport) for a connection.
 * Called on every (re)connect because proxy socks are single-use — a stored
 * config can't be replayed after a transport teardown. In Switch Console this wraps
 * the remote agent's `sshHost` alias through `resolveSshConnectConfig`.
 */
export type SshConnectResolver = () => Promise<SshConnectResult>;

/** Delays (ms) between successive reconnect attempts. The last step is clamped
 * and retried indefinitely (see scheduleReconnect). */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000];

/**
 * Consecutive transport-shaped channel failures (open failures / open timeouts)
 * on a connection that still claims to be connected before the manager treats
 * the shared connection as wedged and force-rebuilds it. Low enough to recover
 * within a few seconds of probing, high enough that a genuinely full sshd
 * MaxSessions (which recovers by itself when a session closes) isn't confused
 * with a dead transport on the first blip.
 */
const WEDGE_FAILURE_THRESHOLD = 3;

type SshConnectionManagerLog = {
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, metadata?: Record<string, unknown>) => void;
};

export interface SshConnectionManagerDeps {
  createClient?: () => Client;
  publishEvent?: (event: SshConnectionEvent) => void;
  log?: SshConnectionManagerLog;
}

const noopLog: SshConnectionManagerLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Everything the manager knows about one connection id, in one place. Lifecycle
 * bookkeeping that used to be spread across id-keyed maps (pending promise,
 * active client, transport cleanup, reconnect backoff, generations, health,
 * intent) lives on this record so it cannot drift out of sync across them.
 */
interface ConnectionRecord {
  readonly id: string;
  /** Stable proxy handed to consumers; survives reconnects. */
  readonly proxy: SshClientProxy;
  state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'suspended';
  /** Bumped on every connect/disconnect intent; stale attempts check it. */
  generation: number;
  resolver?: SshConnectResolver;
  /** In-flight connect promise — concurrent connect() calls coalesce on it. */
  pending?: Promise<SshClientProxy>;
  /** The ssh2 client backing the current attempt or live connection. */
  client?: Client;
  /** Transport cleanup (proxy sock/process) for the current client. */
  cleanup?: () => void;
  reconnect?: { attempt: number; timer: NodeJS.Timeout };
  /**
   * True when disconnect() was called — excluded from auto-reconnect so an
   * intentional teardown is never silently restarted. connect() re-arms it.
   */
  intentional: boolean;
  health: SshHealthState;
  /** Consecutive transport-shaped channel failures — the wedge watchdog. */
  channelFailureStreak: number;
  /**
   * True once this record has had a ready connection. Any later ready is
   * surfaced as 'reconnected' — including a manual forceReconnect, which has
   * no backoff state — so consumers that re-attach sessions on a restored
   * transport (terminal + agent runtime providers) always get their signal.
   */
  hasConnectedBefore: boolean;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export class SshConnectionManager extends EventEmitter {
  private readonly deps: Required<SshConnectionManagerDeps>;

  constructor(deps: SshConnectionManagerDeps = {}) {
    super();
    this.deps = {
      createClient: deps.createClient ?? (() => new Ssh2Client()),
      publishEvent: deps.publishEvent ?? (() => {}),
      log: deps.log ?? noopLog,
    };
  }

  private readonly records = new Map<string, ConnectionRecord>();

  private record(id: string): ConnectionRecord {
    let record = this.records.get(id);
    if (!record) {
      record = {
        id,
        proxy: new SshClientProxy(id, this),
        state: 'disconnected',
        generation: 0,
        intentional: false,
        health: { status: 'ok' },
        channelFailureStreak: 0,
        hasConnectedBefore: false,
      };
      this.records.set(id, record);
    }
    return record;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Register (or replace) the config resolver for a connection ID. Must be
   * called before `connect(id)`; the resolver is reused for auto-reconnect.
   */
  register(id: string, resolver: SshConnectResolver): void {
    this.record(id).resolver = resolver;
  }

  /** Drop a connection's resolver so it can no longer be (re)connected by ID. */
  unregister(id: string): void {
    const record = this.records.get(id);
    if (record) record.resolver = undefined;
  }

  /**
   * Connect and register a client under the given ID.
   *
   * - Reuses an existing connection if already in the pool.
   * - Concurrent calls for the same ID coalesce to a single attempt.
   * - Requires a resolver registered via `register(id, ...)`.
   * - Revives a connection suspended by an auth failure.
   * - Throws SshAuthError, SshTimeoutError, or SshConnectionError on failure.
   */
  async connect(id: string): Promise<SshClientProxy> {
    const record = this.record(id);
    record.intentional = false;

    if (record.proxy.isConnected) return record.proxy;
    if (record.pending) return await record.pending;

    const resolver = record.resolver;
    if (!resolver) {
      throw new SshConnectionError(`SSH connection '${id}' has no registered resolver`);
    }

    const generation = ++record.generation;
    this.setState(record, 'connecting');
    this.emitConnecting(id);

    const pending = (async () => {
      const resolved = await resolver();
      if (record.generation !== generation || record.intentional) {
        resolved.cleanup();
        throw new SshConnectionError(`SSH connection '${id}' was disconnected before connecting`);
      }
      return await this.createConnection(record, resolved.config, resolved.cleanup, generation);
    })();

    record.pending = pending;
    try {
      return await pending;
    } finally {
      if (record.pending === pending) record.pending = undefined;
    }
  }

  /**
   * Force a full transport rebuild for a connection: destroy the current client
   * (dead or alive) and reconnect from a freshly resolved config. This is the
   * escalation path for a wedged-but-"connected" transport and the handler
   * behind the UI's manual refresh — unlike `connect()`, it never reuses the
   * existing client. Also revives a `suspended` connection.
   */
  async forceReconnect(id: string): Promise<SshClientProxy> {
    const record = this.record(id);
    // Routine: this is also the reachability probe's transport rebuild, so it
    // recurs on the backoff schedule for an unreachable host.
    this.deps.log.info('SshConnectionManager: force reconnect requested', { connectionId: id });
    record.intentional = false;
    this.cancelReconnect(record);
    if (record.client) {
      // Invalidate generation first so the dying client's close handler cannot
      // race a competing auto-reconnect against the connect() below.
      record.generation++;
      const client = record.client;
      this.invalidateLiveConnection(record);
      client.destroy();
    }
    record.pending = undefined;
    return this.connect(id);
  }

  /** Get the stable SshClientProxy for a connection, or undefined. */
  getProxy(id: string): SshClientProxy | undefined {
    return this.records.get(id)?.proxy;
  }

  /** Returns true if the connection is currently live. */
  isConnected(id: string): boolean {
    return this.records.get(id)?.proxy.isConnected ?? false;
  }

  /**
   * True when the connection is down because authentication was rejected.
   *
   * Distinct from every other down state, because it is the one the reconnect
   * loop deliberately does not run for: a rejected credential never becomes
   * accepted by waiting. Anything explaining the outage to a user has to know
   * the difference, or it will promise a recovery that is not coming.
   */
  isAuthSuspended(id: string): boolean {
    return this.records.get(id)?.state === 'suspended';
  }

  /** IDs of all tracked connections (connected, reconnecting, or suspended). */
  getConnectionIds(): string[] {
    return Array.from(this.records.keys());
  }

  /** Returns the current ConnectionState for a single connection ID. */
  getConnectionState(id: string): ConnectionState {
    const record = this.records.get(id);
    if (!record) return 'disconnected';
    switch (record.state) {
      case 'connected':
        // Defensive: the proxy is invalidated the instant a live client errors,
        // possibly before the state transition lands — never report a dead
        // proxy as connected.
        return record.proxy.isConnected ? 'connected' : 'disconnected';
      case 'reconnecting':
        return 'reconnecting';
      case 'connecting':
        return 'connecting';
      case 'suspended':
        return 'error';
      case 'disconnected':
        return 'disconnected';
    }
  }

  /** Returns the current ConnectionState for every tracked connection. */
  getAllConnectionStates(): Record<string, ConnectionState> {
    const result: Record<string, ConnectionState> = {};
    for (const id of this.records.keys()) {
      const state = this.getConnectionState(id);
      if (state !== 'disconnected') result[id] = state;
    }
    return result;
  }

  getAllHealthStates(): Record<string, SshHealthState> {
    const result: Record<string, SshHealthState> = {};
    for (const record of this.records.values()) {
      if (record.health.status !== 'ok') result[record.id] = record.health;
    }
    return result;
  }

  /**
   * Called by the proxy for every failed channel open. Transport-shaped
   * failures (channel-open refusals and open timeouts) mark the connection
   * degraded and feed the wedge watchdog: enough consecutive failures on a
   * connection that still claims to be connected mean the shared transport is
   * half-dead (TCP up, channels dead) — the one state ssh2's own close/error
   * events never surface — so the manager force-rebuilds it.
   */
  reportChannelError(connectionId: string, error: unknown): void {
    if (!isSshChannelOpenFailure(error) && !isSshChannelTimeout(error)) return;

    const record = this.record(connectionId);
    record.channelFailureStreak++;
    if (record.health.status !== 'degraded') {
      record.health = { status: 'degraded' };
      this.emitHealthChanged(connectionId, record.health);
    }

    // Record what actually failed. Only the wedge itself used to be logged,
    // which left "3 failures" with no way to tell an exhausted MaxSessions from
    // a saturated tunnel from a genuinely dead transport.
    this.deps.log.warn('SshConnectionManager: channel open failed', {
      connectionId,
      failures: record.channelFailureStreak,
      state: record.state,
      error: error instanceof Error ? error.message : String(error),
    });

    if (
      record.channelFailureStreak >= WEDGE_FAILURE_THRESHOLD &&
      record.state === 'connected' &&
      record.client
    ) {
      this.deps.log.error(
        'SshConnectionManager: connection wedged (consecutive channel failures) — forcing rebuild',
        {
          event: 'ssh_wedge_rebuild',
          connectionId,
          failures: record.channelFailureStreak,
          lastError: error instanceof Error ? error.message : String(error),
        }
      );
      record.channelFailureStreak = 0;
      // Destroying the client fires its close handler, which invalidates the
      // proxy and schedules the normal auto-reconnect path.
      record.client.destroy();
    }
  }

  /** Called by the proxy after every successful channel open. */
  reportChannelSuccess(connectionId: string): void {
    const record = this.records.get(connectionId);
    if (!record) return;
    record.channelFailureStreak = 0;
    this.clearHealthState(record);
  }

  reportChannelRecovered(connectionId: string): void {
    this.reportChannelSuccess(connectionId);
  }

  /**
   * Gracefully close a connection and permanently stop reconnection for it.
   * This is an intentional teardown — auto-reconnect will NOT fire afterward.
   * The resolver is left registered so a later `connect(id)` can revive it;
   * call `unregister(id)` to drop it entirely.
   */
  async disconnect(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    record.intentional = true;
    record.generation++;
    this.cancelReconnect(record);

    if (!record.proxy.isConnected) {
      this.deps.log.warn(
        'SshConnectionManager: disconnect called for unknown/inactive connection',
        {
          connectionId: id,
        }
      );
      record.client?.destroy();
      this.runCleanup(record);
      record.client = undefined;
      record.pending = undefined;
      this.setState(record, 'disconnected');
      return;
    }

    this.deps.log.info('SshConnectionManager: disconnecting', { connectionId: id });

    const client = record.proxy.client;
    return new Promise<void>((resolve) => {
      const finish = () => {
        record.proxy.invalidate();
        this.runCleanup(record);
        record.client = undefined;
        this.setState(record, 'disconnected');
        resolve();
      };
      const timeout = setTimeout(() => {
        this.deps.log.warn('SshConnectionManager: disconnect timed out, forcing close', {
          connectionId: id,
        });
        client.destroy();
        finish();
      }, 5_000);

      client.once('close', () => {
        clearTimeout(timeout);
        finish();
      });

      client.end();
    });
  }

  /** Gracefully close all connections. */
  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.records.keys());
    this.deps.log.info('SshConnectionManager: disconnecting all connections', {
      count: ids.length,
    });
    await Promise.all(ids.map((id) => this.disconnect(id)));
  }

  /**
   * React to the OS resuming from sleep. TCP connections frozen during sleep
   * are frequently dead-but-not-yet-detected; rather than wait out the keepalive
   * probes, proactively tear down each live connection so its close handler
   * reconnects immediately, kick any connection already backing off to retry
   * now, and revive connections suspended by an auth failure (a stale agent
   * socket at failure time is often valid again after wake).
   */
  handleSystemResume(): void {
    for (const record of this.records.values()) {
      if (record.intentional) continue;
      if (record.proxy.isConnected) {
        this.deps.log.warn('SshConnectionManager: system resumed — refreshing live connection', {
          connectionId: record.id,
        });
        record.client?.destroy();
      } else if (record.state === 'reconnecting') {
        this.deps.log.warn('SshConnectionManager: system resumed — retrying reconnect now', {
          connectionId: record.id,
        });
        this.cancelReconnect(record);
        this.scheduleReconnect(record);
      } else if (record.state === 'suspended' && record.resolver) {
        this.deps.log.warn('SshConnectionManager: system resumed — retrying suspended connection', {
          connectionId: record.id,
        });
        this.connect(record.id).catch((error: unknown) => {
          this.deps.log.warn('SshConnectionManager: post-resume revival failed', {
            connectionId: record.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
  }

  /**
   * Establish an ephemeral connection from a caller-supplied config.
   * The connection is marked intentional from the start so the close handler
   * never schedules a reconnect — callers are responsible for teardown via
   * `disconnect(id)`.
   */
  async connectFromConfig(
    id: string,
    config: ConnectConfig,
    cleanup: () => void = () => {}
  ): Promise<SshClientProxy> {
    const record = this.record(id);
    record.intentional = true;
    const generation = ++record.generation;
    this.setState(record, 'connecting');
    const pending = this.createConnection(record, config, cleanup, generation, {
      emitConnecting: true,
    });
    record.pending = pending;
    try {
      return await pending;
    } finally {
      if (record.pending === pending) record.pending = undefined;
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private createConnection(
    record: ConnectionRecord,
    config: ConnectConfig,
    cleanup: () => void,
    generation: number,
    options: { emitConnecting?: boolean } = {}
  ): Promise<SshClientProxy> {
    const id = record.id;
    this.deps.log.info('SshConnectionManager: creating connection', {
      connectionId: id,
      host: config.host,
      username: config.username,
    });

    const proxy = record.proxy;
    const client = this.deps.createClient();
    let cleanupCalled = false;
    const cleanupOnce = () => {
      if (cleanupCalled) return;
      cleanupCalled = true;
      if (record.cleanup === cleanupOnce) record.cleanup = undefined;
      if (record.client === client) record.client = undefined;
      cleanup();
    };
    record.client = client;
    record.cleanup = cleanupOnce;

    return new Promise((resolve, reject) => {
      if (options.emitConnecting) {
        this.emitConnecting(id);
      }

      let resolved = false;
      let connectedBeforeClose = false;
      let disconnectedEmitted = false;
      const resolveOnce = (p: SshClientProxy) => {
        if (!resolved) {
          resolved = true;
          resolve(p);
        }
      };
      const emitDisconnectedOnce = () => {
        if (disconnectedEmitted) return;
        disconnectedEmitted = true;
        this.emit('connection-event', {
          type: 'disconnected',
          connectionId: id,
        } satisfies SshConnectionManagerEvent);
        this.deps.publishEvent({ type: 'disconnected', connectionId: id });
      };

      client.on('error', (error: Error) => {
        // A remote host being down is an expected condition, not a fault in the
        // app: laptops sleep, VPNs drop, SSO tokens expire. The host's
        // reachability state is what escalates a persistent outage — this is
        // one transport attempt failing, so warn rather than error.
        this.deps.log.warn('SshConnectionManager: connection error', {
          connectionId: id,
          error: error.message,
        });

        this.emit('connection-event', {
          type: 'error',
          connectionId: id,
          error,
        } satisfies SshConnectionManagerEvent);

        this.deps.publishEvent({
          type: 'error',
          connectionId: id,
          errorMessage: error.message,
        });

        if (proxy.isConnected && proxy.client === client) {
          connectedBeforeClose = true;
          proxy.invalidate();
          emitDisconnectedOnce();
          if (record.generation === generation) this.setState(record, 'disconnected');
        } else if (!resolved && record.generation === generation) {
          this.setState(record, 'disconnected');
        }
        cleanupOnce();
        reject(classifyError(error));
      });

      client.on('close', () => {
        this.deps.log.warn('SshConnectionManager: connection closed', { connectionId: id });

        if (!resolved) {
          cleanupOnce();
          if (record.state === 'connecting' && record.generation === generation) {
            this.setState(record, 'disconnected');
          }
          reject(new SshConnectionError('SSH connection closed before ready'));
          return;
        }

        // Only react if this client is still the one backing the proxy.
        if ((proxy.isConnected && proxy.client === client) || connectedBeforeClose) {
          const wasConnected = proxy.isConnected && proxy.client === client;
          proxy.invalidate();

          emitDisconnectedOnce();
          cleanupOnce();

          const isCurrent = record.generation === generation;
          if (isCurrent) this.setState(record, 'disconnected');

          // Auto-reconnect unless this was an intentional disconnect, a newer
          // intent superseded this client, or the handshake never succeeded.
          if (!record.intentional && isCurrent && (wasConnected || connectedBeforeClose)) {
            this.scheduleReconnect(record);
          }
        }
      });

      client.on('ready', () => {
        // A reconnect (vs. a first connect) is a recovery event worth surfacing
        // at warn so a post-sleep freeze leaves a diagnosable trail.
        const isReconnect = record.reconnect !== undefined || record.hasConnectedBefore;
        if (isReconnect) {
          this.deps.log.warn('SshConnectionManager: connection ready (reconnected)', {
            connectionId: id,
          });
        } else {
          this.deps.log.info('SshConnectionManager: connection ready', { connectionId: id });
        }

        if (record.generation !== generation) {
          cleanupOnce();
          client.end();
          reject(new SshConnectionError(`SSH connection '${id}' was disconnected before ready`));
          return;
        }

        proxy.update(client);
        record.channelFailureStreak = 0;
        record.hasConnectedBefore = true;
        this.clearHealthState(record);
        this.setState(record, 'connected');

        // Capture the remote login-shell profile once, non-blocking. Failures are
        // warned but do not prevent the connection from being used.
        proxy.getRemoteShellProfile().catch((err: unknown) => {
          this.deps.log.warn('SshConnectionManager: remote shell profile capture failed', {
            connectionId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        this.cancelReconnect(record);

        this.emit('connection-event', {
          type: isReconnect ? 'reconnected' : 'connected',
          connectionId: id,
          proxy,
        } satisfies SshConnectionManagerEvent);

        this.deps.publishEvent({
          type: isReconnect ? 'reconnected' : 'connected',
          connectionId: id,
        });

        resolveOnce(proxy);
      });

      try {
        client.connect(config);
      } catch (error) {
        cleanupOnce();
        if (record.generation === generation) this.setState(record, 'disconnected');
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private scheduleReconnect(record: ConnectionRecord): void {
    const id = record.id;
    const attempt = (record.reconnect?.attempt ?? 0) + 1;

    // Retry indefinitely, clamping the delay to the last (longest) step. A
    // connection dropped by sleep or a network change can take far longer than
    // a handful of attempts to come back, and giving up permanently strands the
    // session until an app restart. Auth failures still suspend reconnection
    // (see the SshAuthError branch below).
    const delayMs = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length) - 1]!;

    this.deps.log.warn('SshConnectionManager: scheduling reconnect', {
      connectionId: id,
      attempt,
      delayMs,
    });

    this.setState(record, 'reconnecting');
    this.emit('connection-event', {
      type: 'reconnecting',
      connectionId: id,
      attempt,
      delayMs,
    } satisfies SshConnectionManagerEvent);

    this.deps.publishEvent({
      type: 'reconnecting',
      connectionId: id,
      attempt,
      delayMs,
    });

    const timer = setTimeout(() => {
      if (record.intentional) {
        record.reconnect = undefined;
        return;
      }

      this.connect(id).catch((error: unknown) => {
        if (record.intentional) {
          record.reconnect = undefined;
          return;
        }
        // Auth failures won't resolve with blind retries — suspend instead of
        // hammering the server. connect()/forceReconnect()/system resume revive.
        if (error instanceof SshAuthError) {
          // Expected (expired or rotated credentials), and the host's
          // reachability state surfaces it to the user as `suspended` — the log
          // does not need to shout about it.
          this.deps.log.warn('SshConnectionManager: reconnect suspended — auth failure', {
            connectionId: id,
          });
          record.reconnect = undefined;
          this.setState(record, 'suspended');
          this.emit('connection-event', {
            type: 'reconnect-failed',
            connectionId: id,
          } satisfies SshConnectionManagerEvent);
          this.deps.publishEvent({ type: 'reconnect-failed', connectionId: id });
        } else {
          this.scheduleReconnect(record);
        }
      });
    }, delayMs);

    record.reconnect = { attempt, timer };
  }

  private cancelReconnect(record: ConnectionRecord): void {
    if (record.reconnect) {
      clearTimeout(record.reconnect.timer);
      record.reconnect = undefined;
    }
  }

  private invalidateLiveConnection(record: ConnectionRecord): void {
    record.proxy.invalidate();
    this.runCleanup(record);
    record.client = undefined;
  }

  private runCleanup(record: ConnectionRecord): void {
    record.cleanup?.();
  }

  private setState(record: ConnectionRecord, state: ConnectionRecord['state']): void {
    record.state = state;
  }

  private emitConnecting(id: string): void {
    this.emit('connection-event', {
      type: 'connecting',
      connectionId: id,
    } satisfies SshConnectionManagerEvent);

    this.deps.publishEvent({
      type: 'connecting',
      connectionId: id,
    });
  }

  private clearHealthState(record: ConnectionRecord): void {
    if (record.health.status !== 'ok') {
      record.health = { status: 'ok' };
      this.emitHealthChanged(record.id, record.health);
    }
  }

  private emitHealthChanged(connectionId: string, health: SshHealthState): void {
    this.deps.publishEvent({
      type: 'health-changed',
      connectionId,
      health,
    });
  }
}

/**
 * Classify a connect-time failure. ssh2 tags its errors with a `level`
 * ('client-authentication' / 'client-timeout') — trust that first; the message
 * fallback exists for errors that lost their level (wrapping, transports).
 * Deliberately narrow: a bare "auth" substring must NOT classify as an auth
 * failure, because auth classification suspends reconnection.
 */
function classifyError(error: Error): SshAuthError | SshTimeoutError | SshConnectionError {
  const level = (error as Error & { level?: string }).level;
  if (level === 'client-authentication') return new SshAuthError(error.message);
  if (level === 'client-timeout') return new SshTimeoutError(error.message);

  const msg = error.message.toLowerCase();
  if (msg.includes('authentication') || msg.includes('permission denied')) {
    return new SshAuthError(error.message);
  }
  if (msg.includes('timeout') || msg.includes('timed out')) {
    return new SshTimeoutError(error.message);
  }
  return new SshConnectionError(error.message);
}

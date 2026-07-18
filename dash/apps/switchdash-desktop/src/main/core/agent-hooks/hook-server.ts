import crypto from 'node:crypto';
import http from 'node:http';

export interface RawHookRequest {
  ptyId: string;
  type: string;
  body: string;
}

/** A buffered hook event, tagged with a monotonic sequence for cursor replay. */
export interface RelayedHookEvent extends RawHookRequest {
  seq: number;
}

/**
 * In-memory ring buffer of the raw hook events the sidecar has handled, exposed
 * over the hook server's `/events` long-poll so switchdash can replay remote
 * sessions' room/status/session events through its own hook path while the UI
 * is attached.
 *
 * Delivery is at-least-once with a bounded buffer: a consumer polls with the
 * `seq` of the last event it processed and receives everything newer. If the
 * consumer falls more than `capacity` events behind, the oldest are evicted —
 * `oldestSeq` lets the consumer detect (and log) that gap rather than silently
 * believing it is caught up.
 */
export class HookEventLog {
  private readonly buffer: RelayedHookEvent[] = [];
  private seq = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly capacity = 256) {}

  append(raw: RawHookRequest): void {
    this.seq += 1;
    this.buffer.push({ seq: this.seq, ptyId: raw.ptyId, type: raw.type, body: raw.body });
    if (this.buffer.length > this.capacity) this.buffer.shift();
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /**
   * Return all buffered events newer than `since`. If none are available, wait
   * up to `timeoutMs` for the next append before resolving (possibly still
   * empty). `oldestSeq` is the lowest retained seq (0 when empty); `latestSeq`
   * is the highest seq ever appended.
   */
  poll(
    since: number,
    timeoutMs: number
  ): Promise<{ events: RelayedHookEvent[]; oldestSeq: number; latestSeq: number }> {
    const snapshot = () => ({
      events: this.buffer.filter((e) => e.seq > since),
      oldestSeq: this.buffer.length > 0 ? this.buffer[0]!.seq : 0,
      latestSeq: this.seq,
    });

    const immediate = snapshot();
    if (immediate.events.length > 0) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        resolve(snapshot());
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        resolve(snapshot());
      }, timeoutMs);
      this.waiters.push(wake);
    });
  }
}

const EVENTS_LONG_POLL_MS = 25_000;

/**
 * Minimal logger the hook server needs. Injected rather than imported so the
 * server can run in the remote sidecar bundle, which must not pull in the
 * Electron-bound main-process file logger.
 */
export interface HookServerLogger {
  info(...input: unknown[]): void;
  warn(...input: unknown[]): void;
  error(...input: unknown[]): void;
}

export type HookHandler = (raw: RawHookRequest) => Promise<void>;

/** One VM-side session switchdash can reconcile into its UI. */
export interface SidecarSessionInfo {
  sessionId: string;
  /** The Switch room the agent is attending, or null for a session that has
   * not joined a room (still discoverable so it can be attached to). */
  roomId: string | null;
}

/** Snapshot of the sessions the sidecar currently has live on the VM. */
export type SidecarSessionsProvider = () => SidecarSessionInfo[] | Promise<SidecarSessionInfo[]>;

/**
 * Drop one VM session: stop its room connection + forget it. `terminated` is
 * true when this is a deliberate delete/kill that should be broadcast to every
 * attached client (via a synthetic `session-terminated` event on the event log),
 * and false when a single client is merely stepping away (app quit / teardown)
 * and the session should survive for others.
 */
export type SidecarDisconnectHandler = (sessionId: string, terminated: boolean) => void;

export class HookServer {
  private server: http.Server | null = null;
  private port = 0;
  private token = '';
  private eventLog: HookEventLog | null = null;
  private sessionsProvider: SidecarSessionsProvider | null = null;
  private disconnectHandler: SidecarDisconnectHandler | null = null;

  constructor(private readonly log: HookServerLogger) {}

  /**
   * Start the hook server. When `eventLog` is provided (the remote sidecar
   * case), the server additionally exposes a token-gated `GET /events`
   * long-poll so switchdash can replay the events the sidecar handled. When
   * `sessionsProvider` is provided it also exposes a token-gated `GET /sessions`
   * snapshot so switchdash can reconcile VM-spawned sessions into its UI. When
   * `disconnectHandler` is provided it exposes a token-gated `POST /disconnect`
   * so switchdash can drop a session's room connection when it deletes it.
   */
  async start(
    handler: HookHandler,
    options?: {
      eventLog?: HookEventLog;
      sessionsProvider?: SidecarSessionsProvider;
      disconnectHandler?: SidecarDisconnectHandler;
    }
  ): Promise<void> {
    if (this.server) return;
    this.token = crypto.randomUUID();
    this.eventLog = options?.eventLog ?? null;
    this.sessionsProvider = options?.sessionsProvider ?? null;
    this.disconnectHandler = options?.disconnectHandler ?? null;

    this.server = http.createServer((req, res) => {
      if (req.headers['x-switchdash-token'] !== this.token) {
        this.log.warn('HookServer: rejected request with invalid token');
        res.writeHead(403);
        res.end();
        return;
      }

      if (req.method === 'GET' && this.eventLog && (req.url ?? '').startsWith('/events')) {
        void this.serveEvents(req, res, this.eventLog);
        return;
      }

      if (
        req.method === 'GET' &&
        this.sessionsProvider &&
        (req.url ?? '').startsWith('/sessions')
      ) {
        void this.serveSessions(res, this.sessionsProvider);
        return;
      }

      if (
        req.method === 'POST' &&
        this.disconnectHandler &&
        (req.url ?? '').startsWith('/disconnect')
      ) {
        this.serveDisconnect(req, res, this.disconnectHandler);
        return;
      }

      if (req.method !== 'POST' || req.url !== '/hook') {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 1_000_000) {
          req.destroy();
        }
      });

      req.on('end', () => {
        const ptyId = String(req.headers['x-switchdash-pty-id'] || '');
        const type = String(req.headers['x-switchdash-event-type'] || '');
        if (!ptyId || !type) {
          this.log.warn('HookServer: malformed request — missing ptyId or type headers');
          res.writeHead(400);
          res.end();
          return;
        }
        handler({ ptyId, type, body })
          .then(() => {
            res.writeHead(200);
            res.end();
          })
          .catch((err) => {
            this.log.warn('HookServer: handler error', { error: String(err) });
            res.writeHead(500);
            res.end();
          });
      });
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        this.log.info('HookServer: started', { port: this.port });
        resolve();
      });
      this.server!.on('error', (err) => {
        this.log.error('HookServer: failed to start', { error: String(err) });
        reject(err);
      });
    });
  }

  private async serveEvents(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    eventLog: HookEventLog
  ): Promise<void> {
    const url = new URL(req.url ?? '/events', 'http://127.0.0.1');
    const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10);
    this.log.info('HookServer: /events poll received', { since });
    const result = await eventLog.poll(Number.isFinite(since) ? since : 0, EVENTS_LONG_POLL_MS);
    this.log.info('HookServer: /events responding', {
      since,
      count: result.events.length,
      types: result.events.map((e) => e.type),
      oldestSeq: result.oldestSeq,
      latestSeq: result.latestSeq,
    });
    const payload = Buffer.from(JSON.stringify(result), 'utf8');
    // Send an explicit Content-Length (not chunked transfer-encoding) so the
    // relay — which reads the raw HTTP response off an SSH-forwarded socket —
    // gets the body verbatim without having to de-chunk it.
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': payload.byteLength,
    });
    res.end(payload);
  }

  private async serveSessions(
    res: http.ServerResponse,
    provider: SidecarSessionsProvider
  ): Promise<void> {
    let sessions: SidecarSessionInfo[];
    try {
      sessions = await provider();
    } catch (err) {
      this.log.warn('HookServer: /sessions provider error', { error: String(err) });
      res.writeHead(500);
      res.end();
      return;
    }
    const payload = Buffer.from(JSON.stringify({ sessions }), 'utf8');
    // Explicit Content-Length (not chunked) so the reconciler reading the raw
    // HTTP response off an SSH-forwarded socket gets the body verbatim.
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': payload.byteLength,
    });
    res.end(payload);
  }

  private serveDisconnect(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: SidecarDisconnectHandler
  ): void {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      let sessionId = '';
      let terminated = false;
      try {
        const parsed = JSON.parse(body) as { sessionId?: unknown; terminated?: unknown };
        if (typeof parsed.sessionId === 'string') sessionId = parsed.sessionId;
        terminated = parsed.terminated === true;
      } catch {
        sessionId = '';
      }
      if (!sessionId) {
        this.log.warn('HookServer: /disconnect missing sessionId');
        res.writeHead(400);
        res.end();
        return;
      }
      try {
        handler(sessionId, terminated);
      } catch (err) {
        this.log.warn('HookServer: /disconnect handler error', { error: String(err) });
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.port = 0;
      this.eventLog = null;
      this.sessionsProvider = null;
      this.disconnectHandler = null;
    }
  }
  getPort(): number {
    return this.port;
  }
  getToken(): string {
    return this.token;
  }
}

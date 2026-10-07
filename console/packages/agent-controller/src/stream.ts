import { setTimeout as delay } from 'node:timers/promises';
import type { z } from 'zod';
import {
  ControllerApiError,
  type ControllerClient,
  isRevoked,
  isTakenOver,
  type OpenedSocket,
} from './api';
import { errorMessage, type Logger } from './log';
import {
  type AgentApprovalOutcomeFrame,
  agentApprovalOutcomeFrameSchema,
  type AgentAttachedFrame,
  agentAttachedFrameSchema,
  type AgentCursor,
  type AgentDetachedFrame,
  agentDetachedFrameSchema,
  type AgentEventFrame,
  agentEventFrameSchema,
  type AgentGapFrame,
  agentGapFrameSchema,
  type AgentRoomsFrame,
  agentRoomsFrameSchema,
  type AgentSessionCommandFrame,
  agentSessionCommandFrameSchema,
  assignmentChangedSchema,
  type ConnectionState,
  connectionStateSchema,
  type ControllerConnection,
  credentialRevokedSchema,
  type Evicted,
  evictedSchema,
  type OperationPending,
  operationPendingSchema,
} from './schemas';

/** The schema for each frame the controller's socket carries, by its `event`. */
export const STREAM_FRAME_SCHEMAS = {
  connection_state: connectionStateSchema,
  evicted: evictedSchema,
  'agent.event': agentEventFrameSchema,
  'agent.gap': agentGapFrameSchema,
  'agent.session_command': agentSessionCommandFrameSchema,
  'agent.approval_outcome': agentApprovalOutcomeFrameSchema,
  'agent.attached': agentAttachedFrameSchema,
  'agent.detached': agentDetachedFrameSchema,
  'agent.rooms': agentRoomsFrameSchema,
  'assignment.changed': assignmentChangedSchema,
  'operation.pending': operationPendingSchema,
  'credential.revoked': credentialRevokedSchema,
} as const satisfies Record<string, z.ZodType>;

export type ControllerFrame =
  | { type: 'connection_state'; data: ConnectionState }
  | { type: 'evicted'; data: Evicted }
  | { type: 'agent.event'; data: AgentEventFrame }
  | { type: 'agent.gap'; data: AgentGapFrame }
  | { type: 'agent.session_command'; data: AgentSessionCommandFrame }
  | { type: 'agent.approval_outcome'; data: AgentApprovalOutcomeFrame }
  | { type: 'agent.attached'; data: AgentAttachedFrame }
  | { type: 'agent.detached'; data: AgentDetachedFrame }
  | { type: 'agent.rooms'; data: AgentRoomsFrame }
  | { type: 'assignment.changed'; data: { revision: number } }
  | { type: 'operation.pending'; data: OperationPending }
  | { type: 'credential.revoked'; data: Record<string, never> };

/** Why the stream stopped for good. */
export type StreamEnding = 'stopped' | 'revoked' | 'taken_over';

export type ControllerStreamOptions = {
  client: Pick<ControllerClient, 'openConnection' | 'openSocket'>;
  /** Where each agent resumes when a connection is opened. */
  cursors: () => Record<string, AgentCursor>;
  /** How far each agent's watcher has confirmed reading, sent with every pong. */
  confirmed: () => Record<string, number>;
  /** A connection was opened: Core attached these agents to it. */
  onOpened: (connection: ControllerConnection) => Promise<void> | void;
  /** The stream is attached and reading. */
  onConnected: () => void;
  /** The stream is down and about to be reopened. */
  onDisconnected: (error: string) => void;
  /** Each frame, in order; the next is not read until this one is handled. */
  onFrame: (frame: ControllerFrame) => Promise<void>;
  signal: AbortSignal;
  log: Logger;
  /** Nothing on the socket for this long, pings included, and it is presumed dead. */
  idleTimeoutMs: number;
  /** The first reconnect wait, and where the wait returns to once a stream attaches. */
  initialBackoffMs: number;
  /** The longest reconnect wait, before jitter of up to half of it is taken off. */
  maxBackoffMs: number;
  /** Jitter source in [0, 1); injectable for tests. */
  random: () => number;
};

/**
 * The close code a server sends as it begins shutting down (uvicorn sends it
 * to every socket). The server is about to be back, so the reconnect waits
 * are short and do not grow.
 */
const SERVICE_RESTART = 1012;
const RESTART_RETRY_MS = 250;
const RESTART_RETRY_JITTER_MS = 500;

class IdleTimeout extends Error {
  constructor(ms: number) {
    super(`Nothing on the controller socket for ${Math.round(ms / 1000)} s.`);
  }
}

/** A refusal meaning the connection is gone and has to be opened again, not reattached. */
function connectionGone(error: unknown): boolean {
  return (
    error instanceof ControllerApiError &&
    (error.status === 404 ||
      error.code === 'unknown_connection' ||
      error.code === 'stale_generation' ||
      error.code === 'no_stream')
  );
}

type Held = { connectionId: string; generation: number };

/** One attempt at attaching the socket, and what it learned. */
type Attempt = {
  abort: AbortController;
  /** Set when the stream stopped for good. */
  ending: StreamEnding | null;
  /** When the stream attached, or 0 if it never did. */
  attachedAt: number;
  /** The server closed the socket because it is restarting. */
  restarting: boolean;
};

type Message = { event: string; data: unknown };

/**
 * The controller's connection to Switch, held open for as long as `signal`
 * lives.
 *
 * A connection is opened once (`POST .../connection`, with every agent's
 * cursor) and a WebSocket attached to it (`.../connection/ws`). The socket
 * carries the stream's frames down, and the server's `ping` every heartbeat
 * interval, which is answered with a `pong` naming each agent's confirmed
 * cursor: that pong is the controller's beat. A dropped socket reattaches to
 * the same connection and generation, so Core resumes where it was; a
 * connection Core no longer knows (its heartbeat lapsed, or it was
 * superseded) is opened afresh, from the cursors as they stand.
 *
 * Ends with `'revoked'` on `credential.revoked` or a refusal saying
 * `controller_revoked`, with `'taken_over'` when another instance of this
 * controller took the connection over (an `evicted` frame or a refusal saying
 * so: reopening would take it straight back, so this one stops), and with
 * `'stopped'` when `signal` fires. Any other `evicted` opens a new connection.
 */
export function runControllerStream(options: ControllerStreamOptions): Promise<StreamEnding> {
  return new ControllerStream(options).run();
}

class ControllerStream {
  private held: Held | null = null;
  private backoff: number;

  constructor(private readonly options: ControllerStreamOptions) {
    this.backoff = options.initialBackoffMs;
  }

  async run(): Promise<StreamEnding> {
    const { signal, log } = this.options;
    while (!signal.aborted) {
      const attempt: Attempt = {
        abort: new AbortController(),
        ending: null,
        attachedAt: 0,
        restarting: false,
      };
      const stop = () => attempt.abort.abort();
      signal.addEventListener('abort', stop, { once: true });
      let failure: string | null = null;
      try {
        await this.attach(attempt);
      } catch (error) {
        if (!attempt.ending && !signal.aborted) {
          if (isRevoked(error)) attempt.ending = 'revoked';
          else if (isTakenOver(error)) attempt.ending = 'taken_over';
          else {
            const reason = attempt.abort.signal.reason;
            failure = errorMessage(reason instanceof IdleTimeout ? reason : error);
          }
        }
      } finally {
        signal.removeEventListener('abort', stop);
        attempt.abort.abort();
      }
      if (attempt.ending) return attempt.ending;
      if (signal.aborted) break;
      if (attempt.attachedAt > 0) {
        this.options.onDisconnected(failure ?? 'the socket closed');
        // Every agent on this controller is offline until the socket is back,
        // so a socket that attached at all starts the waits over.
        this.backoff = this.options.initialBackoffMs;
      }
      const wait = attempt.restarting
        ? RESTART_RETRY_MS + Math.round(this.options.random() * RESTART_RETRY_JITTER_MS)
        : Math.round(this.backoff * (0.5 + this.options.random() * 0.5));
      if (failure !== null)
        log.warn('The controller socket is down; reconnecting.', {
          error: failure,
          retryInMs: wait,
        });
      await delay(wait, undefined, { signal }).catch(() => {});
      if (!attempt.restarting) this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs);
    }
    return 'stopped';
  }

  private async attach(attempt: Attempt): Promise<void> {
    const { client, log } = this.options;
    if (!this.held) {
      const opened = await client.openConnection(this.options.cursors(), attempt.abort.signal);
      this.held = { connectionId: opened.connection_id, generation: opened.generation };
      log.info('Opened the controller connection', {
        connectionId: opened.connection_id,
        generation: opened.generation,
        agents: opened.agents.length,
      });
      await this.options.onOpened(opened);
    }
    const current = this.held;
    try {
      await this.read(await client.openSocket(current), attempt);
    } catch (error) {
      if (!connectionGone(error)) throw error;
      log.warn('Switch no longer knows the controller connection; opening a new one.', {
        error: errorMessage(error),
      });
      if (this.held === current) this.held = null;
    }
  }

  /**
   * Reads the socket until it closes: answers each ping with the confirmed
   * cursors and hands every other frame on, in order. A refusal is thrown as
   * the error an HTTP request would have raised.
   */
  private async read(opened: OpenedSocket, attempt: Attempt): Promise<void> {
    const { socket } = opened;
    const abort = attempt.abort;
    const pending: Message[] = [];
    let refused: { status: number; code: string; message: string } | null = null;
    let closedWith: number | null = null;
    let wake: (() => void) | null = null;
    const notify = () => {
      const resolve = wake;
      wake = null;
      resolve?.();
    };
    let idle: ReturnType<typeof setTimeout> | null = null;
    const touch = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(
        () => abort.abort(new IdleTimeout(this.options.idleTimeoutMs)),
        this.options.idleTimeoutMs
      );
    };
    const onMessage = (message: MessageEvent) => {
      touch();
      let parsed: { event?: unknown; data?: unknown };
      try {
        parsed = JSON.parse(String(message.data)) as typeof parsed;
      } catch {
        this.options.log.error('Dropped a controller socket message that is not JSON');
        return;
      }
      if (parsed.event === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', cursors: this.options.confirmed() }));
        return;
      }
      if (parsed.event === 'refused') {
        refused = refusalOf(parsed.data);
        return;
      }
      if (typeof parsed.event !== 'string') return;
      pending.push({ event: parsed.event, data: parsed.data });
      notify();
    };
    const onClose = (event: CloseEvent) => {
      closedWith = event.code;
      if (event.code === SERVICE_RESTART) attempt.restarting = true;
      notify();
    };
    const onAbort = () => notify();
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', notify);
    abort.signal.addEventListener('abort', onAbort, { once: true });
    try {
      touch();
      for (;;) {
        while (pending.length > 0) {
          const message = pending.shift() as Message;
          if (attempt.attachedAt === 0) {
            attempt.attachedAt = Date.now();
            this.options.onConnected();
          }
          const frame = parseFrame(message, this.options.log);
          if (!frame) continue;
          await this.options.onFrame(frame);
          if (this.ended(frame, attempt)) return;
        }
        if (closedWith !== null || abort.signal.aborted) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const refusal = refused as { status: number; code: string; message: string } | null;
      if (refusal !== null) {
        if (refusal.status === 401 && refusal.code !== 'controller_revoked') opened.tokenRefused();
        throw new ControllerApiError(refusal.status, refusal.code, refusal.message, false, null);
      }
      if (abort.signal.aborted && abort.signal.reason instanceof IdleTimeout)
        throw abort.signal.reason;
      if (!this.options.signal.aborted && attempt.attachedAt === 0)
        throw new Error(`The controller socket closed before it attached (code ${closedWith}).`);
      if (!this.options.signal.aborted)
        this.options.log.warn('The controller socket closed; reconnecting.', { code: closedWith });
    } finally {
      if (idle) clearTimeout(idle);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', notify);
      abort.signal.removeEventListener('abort', onAbort);
      if (socket.readyState === 0 || socket.readyState === 1) socket.close(1000);
    }
  }

  /** Whether this frame ends the attempt: a revocation, or an eviction. */
  private ended(frame: ControllerFrame, attempt: Attempt): boolean {
    if (frame.type === 'credential.revoked') {
      attempt.ending = 'revoked';
      return true;
    }
    if (frame.type !== 'evicted') return false;
    if (frame.data.code === 'taken_over') {
      this.options.log.error(
        'Another instance of this controller took its connection over; this one stops. Run one controller per data directory.'
      );
      attempt.ending = 'taken_over';
      return true;
    }
    this.options.log.warn('Switch ended the controller connection; opening a new one.', {
      code: frame.data.code,
      reason: frame.data.reason,
    });
    this.held = null;
    return true;
  }
}

function refusalOf(data: unknown): { status: number; code: string; message: string } {
  const body = (data ?? {}) as { status?: unknown; detail?: unknown };
  const detail = (body.detail ?? {}) as { code?: unknown; message?: unknown };
  return {
    status: typeof body.status === 'number' ? body.status : 0,
    code: typeof detail.code === 'string' ? detail.code : 'refused',
    message:
      typeof detail.message === 'string' ? detail.message : 'Switch refused the controller socket.',
  };
}

function parseFrame(message: Message, log: Logger): ControllerFrame | null {
  const schema = (STREAM_FRAME_SCHEMAS as Record<string, z.ZodType>)[message.event];
  if (!schema) {
    log.debug('Ignoring a frame this controller does not know', { event: message.event });
    return null;
  }
  const result = schema.safeParse(message.data);
  if (!result.success) {
    log.error('Dropped a controller frame that does not match the protocol', {
      event: message.event,
      error: result.error.message,
    });
    return null;
  }
  return { type: message.event, data: result.data } as ControllerFrame;
}

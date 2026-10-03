import { setTimeout as delay } from 'node:timers/promises';
import type { z } from 'zod';
import { ControllerApiError, type ControllerClient, isRevoked, isTakenOver } from './api';
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
  type AgentPlacements,
  agentGapFrameSchema,
  type AgentRoomsFrame,
  agentRoomsFrameSchema,
  type AgentSessionCommandFrame,
  agentSessionCommandFrameSchema,
  type AgentWorkerClosedFrame,
  agentWorkerClosedFrameSchema,
  type AgentWorkerFrame,
  agentWorkerFrameSchema,
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

export type SseItem =
  | { kind: 'comment'; text: string }
  | { kind: 'event'; event: string; data: string; id: string | null };

/**
 * Splits an SSE byte stream into events and comments. Comments are surfaced
 * rather than skipped because the server's `: keepalive` is how a silent but
 * healthy stream is told apart from a dead one.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseItem> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let event = '';
  let id: string | null = null;
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffered.slice(0, newline);
        const width = buffered.startsWith('\r\n', newline) ? 2 : 1;
        // A lone CR at the end of the buffer may be the first half of a CRLF.
        if (width === 1 && buffered[newline] === '\r' && newline === buffered.length - 1) break;
        buffered = buffered.slice(newline + width);
        if (line === '') {
          if (data.length)
            yield { kind: 'event', event: event || 'message', data: data.join('\n'), id };
          event = '';
          data = [];
          continue;
        }
        if (line.startsWith(':')) {
          yield { kind: 'comment', text: line.slice(1).trimStart() };
          continue;
        }
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
        else if (field === 'id') id = value;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** The schema for each SSE event type the controller stream carries, by `event:` name. */
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
  'agent.worker': agentWorkerFrameSchema,
  'agent.worker_closed': agentWorkerClosedFrameSchema,
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
  | { type: 'agent.worker'; data: AgentWorkerFrame }
  | { type: 'agent.worker_closed'; data: AgentWorkerClosedFrame }
  | { type: 'assignment.changed'; data: { revision: number } }
  | { type: 'operation.pending'; data: OperationPending }
  | { type: 'credential.revoked'; data: Record<string, never> };

/** Why the stream stopped for good. */
export type StreamEnding = 'stopped' | 'revoked' | 'taken_over';

export type ControllerStreamOptions = {
  client: Pick<ControllerClient, 'openConnection' | 'beat' | 'openEvents'>;
  /** Where each agent resumes when a connection is opened. */
  cursors: () => Record<string, AgentCursor>;
  /** How far each agent's watcher has confirmed reading, sent on every beat. */
  confirmed: () => Record<string, number>;
  /** The rooms each agent's sessions work in, sent on the open and on every beat. */
  placements: () => AgentPlacements;
  /** A connection was opened: Core attached these agents to it. */
  onOpened: (connection: ControllerConnection) => Promise<void> | void;
  /** The stream is attached to this connection and reading. */
  onConnected: (connection: { connectionId: string; generation: number }) => void;
  /** The stream is down and about to be reopened. */
  onDisconnected: (error: string) => void;
  /** Each frame, in order; the next is not read until this one is handled. */
  onFrame: (frame: ControllerFrame) => Promise<void>;
  signal: AbortSignal;
  log: Logger;
  /** No byte for this long, keepalives included, and the stream is presumed dead. */
  idleTimeoutMs: number;
  /** The first reconnect wait, and where the wait returns to once a stream attaches. */
  initialBackoffMs: number;
  /** The longest reconnect wait, before jitter of up to half of it is taken off. */
  maxBackoffMs: number;
  /** Jitter source in [0, 1); injectable for tests. */
  random: () => number;
};

class IdleTimeout extends Error {
  constructor(ms: number) {
    super(`No data on the event stream for ${Math.round(ms / 1000)} s.`);
  }
}

/** A refusal meaning the connection is gone and has to be opened again, not reattached. */
function connectionGone(error: unknown): boolean {
  return (
    error instanceof ControllerApiError &&
    (error.status === 404 ||
      error.code === 'unknown_connection' ||
      error.code === 'stale_generation')
  );
}

type Held = { connectionId: string; generation: number; heartbeatMs: number };

/** One attempt at attaching the stream: its socket, and what it learned. */
type Attempt = {
  socket: AbortController;
  /** Set when the stream stopped for good. */
  ending: StreamEnding | null;
  /** When the stream attached, or 0 if it never did. */
  attachedAt: number;
  beating: Promise<void> | null;
};

/**
 * The controller stream, held open for as long as `signal` lives.
 *
 * A connection is opened once (`POST .../connection`, with every agent's
 * cursor) and the stream attached to it (`GET .../events`). A dropped socket
 * reattaches to the same connection and generation, so Core resumes where it
 * was; a connection Core no longer knows (its 6 s heartbeat lapsed, or it was
 * superseded) is opened afresh, from the cursors as they stand. While the
 * stream is attached the connection is beaten every `heartbeat_interval_s`
 * with each agent's confirmed cursor and the rooms its sessions work in, so a
 * placement made locally reaches Switch on the next beat.
 *
 * Ends with `'revoked'` on `credential.revoked` or a request refused as
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
        socket: new AbortController(),
        ending: null,
        attachedAt: 0,
        beating: null,
      };
      const stop = () => attempt.socket.abort();
      signal.addEventListener('abort', stop, { once: true });
      let failure: string | null = null;
      try {
        await this.attach(attempt);
      } catch (error) {
        if (!attempt.ending && !signal.aborted) {
          if (isRevoked(error)) attempt.ending = 'revoked';
          else if (isTakenOver(error)) attempt.ending = 'taken_over';
          else {
            const reason = attempt.socket.signal.reason;
            failure = errorMessage(reason instanceof IdleTimeout ? reason : error);
          }
        }
      } finally {
        signal.removeEventListener('abort', stop);
        attempt.socket.abort();
        await attempt.beating;
      }
      if (attempt.ending) return attempt.ending;
      if (signal.aborted) break;
      if (attempt.attachedAt > 0) {
        this.options.onDisconnected(failure ?? 'the stream ended');
        // Every agent on this controller is offline until the stream is back,
        // so a stream that attached at all starts the waits over.
        this.backoff = this.options.initialBackoffMs;
      }
      const wait = Math.round(this.backoff * (0.5 + this.options.random() * 0.5));
      if (failure !== null)
        log.warn('The controller stream is down; reconnecting.', {
          error: failure,
          retryInMs: wait,
        });
      await delay(wait, undefined, { signal }).catch(() => {});
      this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs);
    }
    return 'stopped';
  }

  private async attach(attempt: Attempt): Promise<void> {
    const { client, log } = this.options;
    if (!this.held) {
      const opened = await client.openConnection(
        this.options.cursors(),
        this.options.placements(),
        attempt.socket.signal
      );
      this.held = {
        connectionId: opened.connection_id,
        generation: opened.generation,
        heartbeatMs: opened.heartbeat_interval_s * 1000,
      };
      log.info('Opened the controller stream connection', {
        connectionId: opened.connection_id,
        generation: opened.generation,
        agents: opened.agents.length,
      });
      await this.options.onOpened(opened);
    }
    const current = this.held;
    let response: Response;
    try {
      response = await client.openEvents(current, attempt.socket.signal);
    } catch (error) {
      if (!connectionGone(error)) throw error;
      log.warn('Switch no longer knows the stream connection; opening a new one.', {
        error: errorMessage(error),
      });
      this.held = null;
      return;
    }
    attempt.attachedAt = Date.now();
    this.options.onConnected({
      connectionId: current.connectionId,
      generation: current.generation,
    });
    attempt.beating = this.beat(current, attempt);
    await this.read(response.body!, attempt);
  }

  private async read(body: ReadableStream<Uint8Array>, attempt: Attempt): Promise<void> {
    const { socket } = attempt;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const touch = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(
        () => socket.abort(new IdleTimeout(this.options.idleTimeoutMs)),
        this.options.idleTimeoutMs
      );
    };
    const aborted = new Promise<never>((_resolve, reject) => {
      const fail = () => reject(socket.signal.reason ?? new Error('aborted'));
      if (socket.signal.aborted) fail();
      socket.signal.addEventListener('abort', fail, { once: true });
    });
    aborted.catch(() => {});
    try {
      touch();
      const items = parseSse(body);
      for (;;) {
        const next = await Promise.race([items.next(), aborted]);
        if (next.done) break;
        touch();
        const item = next.value;
        if (item.kind === 'comment') continue;
        const frame = parseFrame(item, this.options.log);
        if (!frame) continue;
        await this.options.onFrame(frame);
        if (frame.type === 'credential.revoked') {
          attempt.ending = 'revoked';
          return;
        }
        if (frame.type === 'evicted') {
          if (frame.data.code === 'taken_over') {
            this.options.log.error(
              'Another instance of this controller took its stream over; this one stops. Run one controller per data directory.'
            );
            attempt.ending = 'taken_over';
            return;
          }
          this.options.log.warn('Switch ended the controller stream; opening a new connection.', {
            code: frame.data.code,
            reason: frame.data.reason,
          });
          this.held = null;
          return;
        }
      }
      if (!this.options.signal.aborted)
        this.options.log.warn('The controller stream ended; reconnecting.');
    } finally {
      if (idle) clearTimeout(idle);
    }
  }

  /** Beats the connection while this attempt's stream is attached. */
  private async beat(connection: Held, attempt: Attempt): Promise<void> {
    const { client, log } = this.options;
    const signal = attempt.socket.signal;
    let failures = 0;
    while (!signal.aborted) {
      await delay(connection.heartbeatMs, undefined, { signal }).catch(() => {});
      if (signal.aborted) return;
      try {
        await client.beat(connection, this.options.confirmed(), this.options.placements(), signal);
        if (failures > 0)
          log.info('The controller stream heartbeat recovered', { afterFailures: failures });
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        if (isRevoked(error) || isTakenOver(error)) {
          if (isTakenOver(error))
            log.error(
              'Another instance of this controller took its stream connection over; this one stops. Run one controller per data directory.'
            );
          attempt.ending = isRevoked(error) ? 'revoked' : 'taken_over';
          attempt.socket.abort();
          return;
        }
        if (connectionGone(error)) {
          log.warn('Switch refused the heartbeat for a connection it no longer holds; reopening.', {
            error: errorMessage(error),
          });
          if (this.held === connection) this.held = null;
          attempt.socket.abort();
          return;
        }
        failures++;
        // The first failure, then powers of two: an outage costs a few lines.
        if ((failures & (failures - 1)) === 0)
          log.warn('The controller stream heartbeat failed', {
            failures,
            error: errorMessage(error),
          });
      }
    }
  }
}

function parseFrame(item: SseItem & { kind: 'event' }, log: Logger): ControllerFrame | null {
  const schema = (STREAM_FRAME_SCHEMAS as Record<string, z.ZodType>)[item.event];
  if (!schema) {
    log.debug('Ignoring an event type this controller does not know', { event: item.event });
    return null;
  }
  try {
    return { type: item.event, data: schema.parse(JSON.parse(item.data)) } as ControllerFrame;
  } catch (error) {
    log.error('Dropped a controller stream frame that does not match the protocol', {
      event: item.event,
      error: errorMessage(error),
    });
    return null;
  }
}

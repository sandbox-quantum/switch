import { contractRange } from './artifacts';
import { readSse, type SseFrame } from './sse';
import type { AgentBridgeEvent, SwitchCredentials } from './types';
import { RUNTIME_ARTIFACT, RUNTIME_VERSION } from './version';

/** This artifact's own range for the contract it speaks to Switch over. */
const AGENT_PROTOCOL = contractRange('agent-protocol', RUNTIME_ARTIFACT);

/**
 * The agent bridge's push transport (CHOO-1857), client side.
 *
 * Replaces the long-poll: one SSE stream carries events, one heartbeat proves
 * we are alive, and both are tied to a connection id we choose. The connection
 * outlives its socket — losing the stream stops delivery but does not end the
 * connection, so reopening within the heartbeat TTL keeps the room slot and the
 * role lease and resumes from the cursor.
 *
 * Two things this buys that the poll could not:
 *
 * - **Resume.** Every event carries a sequence number; we reopen with
 *   `Last-Event-ID` and get exactly what we missed. The poll had no cursor at
 *   all — the server drained the queue on read, so anything delivered while we
 *   were away was simply gone.
 * - **One heartbeat instead of three.** `/connection/renew`, `/leases/renew`
 *   and `/watch/heartbeat` collapse into `/connection/beat`.
 *
 * A gap is never silent. If the server cannot serve our cursor it says so, and
 * `onGap` fires so the caller can tell the agent to re-read context rather than
 * carry on believing it saw everything.
 */

/** Cadence of the connection heartbeat. Must stay well inside the server's
 * 6s TTL — the server declares the connection dead without it. */
export const BEAT_INTERVAL_MS = 2000;
const BEAT_REQUEST_TIMEOUT_MS = 4000;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export type StreamScope = 'single' | 'all';
export type DeliveryFilter = 'all' | 'addressed';

export interface EventStreamLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface SwitchEventStreamDeps {
  creds: SwitchCredentials;
  /** Chosen by us and reused across reconnects — that is what makes the
   * connection survive a dropped socket. */
  connectionId: string;
  scope: StreamScope;
  filter: DeliveryFilter;
  /**
   * Declares that this connection will start a session for a room on demand.
   *
   * The server keys the "Starting a session…" reply and the DORMANT status off
   * this rather than off the agent's configured `connection_model`, so a
   * watcher must say so — otherwise an addressed message in an unattended room
   * is answered with "my connector isn't reporting in" while this connection is
   * sitting right here, about to spawn.
   */
  spawnCapable?: boolean;
  /**
   * Where to begin, when it must not be "whatever happens next".
   *
   * A session spawned to answer a message needs the buffer position *before*
   * that message: the watcher already consumed it to decide to spawn, so
   * opening at head starts the session after the very thing it was started
   * for. Omitted for every other case, where head is right.
   */
  startCursor?: number;
  /** Rooms declared when the stream opens. Declared at open rather than
   * subscribed afterwards: catch-up runs immediately, and a room claimed a
   * moment later arrives too late for the buffered events a reconnect exists
   * to recover — they would be skipped as "not covered" AND the cursor
   * advanced past them. */
  rooms: string[];
  onEvent(event: AgentBridgeEvent): Promise<void> | void;
  /**
   * The rooms the server says this connection covers — on connect, and again
   * whenever they change. The server is the authority here: a room claimed by
   * the session's own `connect_to_room` arrives this way, which is what lets a
   * supervisor learn its session's room from Switch rather than by watching
   * the agent's tool calls.
   */
  onRooms?: (rooms: string[]) => void;
  /**
   * A room we declared that the server refuses to serve, and has therefore
   * been dropped from the declared set.
   *
   * Terminal for that room: the id outlives the room, so whatever remembers it
   * has to forget, or the next connection declares the same dead room again.
   */
  onRoomRejected?: (info: { roomId: string; status: number; detail: string }) => void;
  /** Fired when the server reports missed events it cannot replay. */
  onGap(info: { fromSequence: number; reason: string }): void;
  /** Fired when another stream took this connection over, or it was closed. */
  onEvicted(reason: string): void;
  log: EventStreamLogger;
  /** Aborts the stream and the heartbeat together. */
  signal: AbortSignal;
}

export class SwitchEventStream {
  private readonly deps: SwitchEventStreamDeps;
  /** Highest sequence number received. Sent on every beat and used as
   * `Last-Event-ID` when reopening. Seeded from `startCursor` when the caller
   * needs to begin behind head rather than at it. */
  private cursor: number;
  /** Aborts only the current socket, so a reconnect can replace it without
   * tearing down the connection. */
  private socketAbort: AbortController | null = null;
  private rooms: string[];

  constructor(deps: SwitchEventStreamDeps) {
    this.deps = deps;
    this.rooms = [...deps.rooms];
    this.cursor = deps.startCursor ?? 0;
  }

  get position(): number {
    return this.cursor;
  }

  start(): void {
    void this.streamLoop();
    void this.beatLoop();
  }

  /** Repoint the stream at a different room without dropping the connection.
   * The room is claimed server-side first, then the socket is reopened so the
   * new room's buffered events are part of catch-up. */
  async repoint(roomId: string): Promise<void> {
    this.rooms = [roomId];
    await this.subscribe(roomId);
    this.reopen();
  }

  private reopen(): void {
    this.socketAbort?.abort();
  }

  /**
   * Pass the server's room list on, and keep our own copy in step.
   *
   * The local copy matters on reconnect: it is what gets declared on the open
   * URL, so a room the server claimed while we were connected is still ours
   * after a drop. Without it a reconnect would re-open with the room we were
   * first told about — or none — and quietly stop receiving.
   */
  private reportRooms(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const rooms = raw.filter((r): r is string => typeof r === 'string');
    this.rooms = rooms;
    this.deps.onRooms?.(rooms);
  }

  /**
   * Give up on a declared room the server refuses, keeping the connection.
   *
   * The server refuses the **whole** connection when one declared room cannot
   * be served, so re-declaring it means never connecting again: a room id
   * outlives its room, and nothing else in the open path would ever notice.
   * The room is dropped, the refusal is reported at error level, and the room
   * list goes out over the same callback the server's own updates arrive on,
   * so anything holding the room learns it is gone.
   *
   * Only rooms the body actually names are dropped. A refusal that names none
   * of them says nothing about which room is at fault — it stays a transport
   * error and keeps its backoff.
   */
  private dropRefusedRooms(status: number, body: string): boolean {
    if (status !== 403 && status !== 404) return false;
    const refused = this.rooms.filter((room) => body.includes(room));
    if (refused.length === 0) return false;
    const remaining = this.rooms.filter((room) => !refused.includes(room));
    const detail = body.slice(0, 500);
    this.deps.log.error('SwitchEventStream: the server refused a declared room — dropping it', {
      event: 'switch_stream_room_refused',
      status,
      rooms: refused,
      remaining,
      detail,
    });
    this.rooms = remaining;
    for (const roomId of refused) this.deps.onRoomRejected?.({ roomId, status, detail });
    this.deps.onRooms?.(remaining);
    return true;
  }

  private async subscribe(roomId: string): Promise<void> {
    const resp = await this.post('connection/subscribe', {
      connection_id: this.deps.connectionId,
      room_id: roomId,
    });
    if (!resp.ok) {
      // 409 means another live connection of this agent already holds the room
      // — usually a stale session. Loud: quietly carrying on would leave us
      // attached to a stream that will never deliver that room's events.
      throw new Error(`subscribe to ${roomId} failed: HTTP ${resp.status}`);
    }
  }

  private post(path: string, body: unknown, timeoutMs = BEAT_REQUEST_TIMEOUT_MS) {
    const { creds } = this.deps;
    return fetch(`${creds.apiEndpoint}/agents/${creds.agentId}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.deps.signal]),
    });
  }

  /**
   * Reopen the stream until it comes back, reporting on a curve.
   *
   * The reconnect itself is unconditional — an endpoint that is down now may be
   * up in a moment, and this loop is the only thing that would notice. What is
   * rationed is the reporting: an endpoint that is simply gone (a managed
   * stack the user stopped, one session per room, each retrying forever) writes
   * the same line every thirty seconds until the app is quit, which is how a
   * real failure elsewhere gets lost. The first failure is reported, then
   * powers of two, and recovery is stated so the outage has an end in the log
   * as well as a beginning — the same discipline the heartbeat already applies.
   */
  private async streamLoop(): Promise<void> {
    const { creds, connectionId, scope, filter, log, signal } = this.deps;
    let backoff = INITIAL_BACKOFF_MS;
    let failures = 0;

    while (!signal.aborted) {
      const socketAbort = new AbortController();
      this.socketAbort = socketAbort;
      try {
        const params = new URLSearchParams({
          connection_id: connectionId,
          scope,
          filter,
          start_from: this.cursor > 0 ? String(this.cursor) : 'head',
          // What we are and what we speak, declared on the connect we already
          // make (CHOO-1865). A client that says nothing records as unknown
          // server-side, and a declaration cannot be backfilled after the fact
          // — every release that ships silent is a permanent blind spot.
          protocol: String(AGENT_PROTOCOL.speaks),
          protocol_accepts: String(AGENT_PROTOCOL.accepts),
          client: RUNTIME_ARTIFACT,
          client_version: RUNTIME_VERSION,
        });
        if (this.deps.spawnCapable) params.set('spawn_capable', 'true');
        if (this.rooms.length) params.set('rooms', this.rooms.join(','));

        const resp = await fetch(`${creds.apiEndpoint}/agents/${creds.agentId}/events?${params}`, {
          headers: {
            Authorization: `Bearer ${creds.token}`,
            Accept: 'text/event-stream',
            ...(this.cursor > 0 ? { 'Last-Event-ID': String(this.cursor) } : {}),
          },
          signal: AbortSignal.any([socketAbort.signal, signal]),
        });

        if (!resp.ok || !resp.body) {
          const body = await resp.text();
          // Reopening without the refused room is a different request from the
          // one that just failed, and the declared set strictly shrinks, so
          // this cannot spin: retry now rather than serving the backoff a
          // transport failure earned.
          if (this.dropRefusedRooms(resp.status, body)) continue;
          throw new Error(`HTTP ${resp.status}: ${body}`);
        }

        backoff = INITIAL_BACKOFF_MS;
        if (failures > 0) {
          log.warn('SwitchEventStream: stream recovered', {
            event: 'switch_stream_recovered',
            afterFailures: failures,
          });
          failures = 0;
        }
        log.debug('SwitchEventStream: stream open', {
          event: 'switch_stream_open',
          connectionId,
          cursor: this.cursor,
          rooms: this.rooms,
        });

        for await (const frame of readSse(resp.body, socketAbort.signal)) {
          if (frame.id) this.cursor = Math.max(this.cursor, Number(frame.id) || 0);
          await this.handleFrame(frame);
        }
      } catch (error) {
        if (signal.aborted) return;
        // A deliberate reopen (repoint) aborts the socket; that is not an error.
        if (!socketAbort.signal.aborted) {
          failures += 1;
          if ((failures & (failures - 1)) === 0) {
            log.warn('SwitchEventStream: stream error', {
              event: 'switch_stream_error',
              endpoint: creds.apiEndpoint,
              failures,
              error: String(error),
              backoffMs: backoff,
            });
          }
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
      }
    }
  }

  private async handleFrame(frame: SseFrame): Promise<void> {
    const { log, onGap, onEvicted, onEvent } = this.deps;
    switch (frame.event) {
      case 'connection_state':
        log.debug('SwitchEventStream: connection established', {
          event: 'switch_stream_connected',
          rooms: frame.data.rooms,
          // What the server says it is (CHOO-1865). Recorded, not acted on —
          // logging it is what makes "which versions are actually talking to
          // each other" answerable from a bug report rather than a guess.
          server: frame.data.server ?? null,
        });
        this.reportRooms(frame.data.rooms);
        return;
      case 'subscription_changed':
        log.debug('SwitchEventStream: subscription changed', {
          event: 'switch_stream_subscription',
          rooms: frame.data.rooms,
        });
        this.reportRooms(frame.data.rooms);
        return;
      case 'gap':
        log.warn('SwitchEventStream: gap — events missed', {
          event: 'switch_stream_gap',
          fromSequence: frame.data.from_sequence,
          reason: frame.data.reason,
        });
        onGap({
          fromSequence: Number(frame.data.from_sequence ?? 0),
          reason: String(frame.data.reason ?? 'events were missed'),
        });
        return;
      case 'evicted':
        log.warn('SwitchEventStream: evicted', {
          event: 'switch_stream_evicted',
          reason: frame.data.reason,
        });
        onEvicted(String(frame.data.reason ?? 'connection closed'));
        return;
      default:
        await onEvent(frame.data as unknown as AgentBridgeEvent);
    }
  }

  /**
   * The single heartbeat. Proves we are alive and reports the cursor.
   *
   * A 404 or 409 means we are not receiving — the connection expired, or it has
   * no stream attached. Both are recovered by reopening, which resumes from the
   * cursor. Failing quietly here is the one thing that must not happen: a client
   * that has stopped receiving while believing it is connected is exactly the
   * bug this transport exists to remove.
   *
   * While beats succeed the cadence is fixed and short — the server declares the
   * connection dead without them. While they fail it backs off, because a beat
   * that has already missed the TTL cannot save the connection: reopening the
   * stream is what re-establishes it, and that loop is doing its own retrying.
   * Hammering a dead endpoint every two seconds forever is what this avoids —
   * an endpoint that is simply gone (a managed server's port after the stack was
   * destroyed) should cost a trickle of requests and a handful of log lines, not
   * a permanent stream of both.
   */
  private async beatLoop(): Promise<void> {
    const { log, signal, connectionId } = this.deps;
    let failures = 0;
    let backoff = BEAT_INTERVAL_MS;

    const fail = (error: unknown): void => {
      failures += 1;
      // Report the first failure, then on a curve: powers of two, so a
      // permanent outage costs a handful of lines rather than one per beat.
      if ((failures & (failures - 1)) === 0) {
        log.warn('SwitchEventStream: heartbeat failed', {
          event: 'switch_beat_failed',
          endpoint: this.deps.creds.apiEndpoint,
          failures,
          error: String(error),
        });
      }
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };

    while (!signal.aborted) {
      try {
        const resp = await this.post('connection/beat', {
          connection_id: connectionId,
          cursor: this.cursor,
        });
        if (resp.status === 404 || resp.status === 409) {
          // Not an outage: the server answered. We are simply not attached, so
          // reopen at the normal cadence rather than backing off.
          log.warn('SwitchEventStream: heartbeat rejected — reopening', {
            event: 'switch_beat_rejected',
            status: resp.status,
            connectionId,
          });
          this.reopen();
          failures = 0;
          backoff = BEAT_INTERVAL_MS;
        } else if (!resp.ok) {
          fail(new Error(`HTTP ${resp.status}`));
        } else {
          if (failures > 0) {
            log.warn('SwitchEventStream: heartbeat recovered', {
              event: 'switch_beat_recovered',
              afterFailures: failures,
            });
          }
          failures = 0;
          backoff = BEAT_INTERVAL_MS;
        }
      } catch (error) {
        if (signal.aborted) return;
        fail(error);
      }
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

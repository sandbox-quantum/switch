import { contractRange } from './artifacts';
import { ReattachFence } from './reattach-fence';
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
/**
 * How long a reopen waits for a beat already in flight before disowning it.
 *
 * A beat answered inside this window is still believed, so a takeover that
 * lands while the socket happens to be reopening is acted on. Past it the
 * answer cannot be told apart from one our own reopen provoked, and the reopen
 * matters more: it is what restores delivery, and the server gives the
 * connection six seconds without a beat.
 */
export const BEAT_SETTLE_LIMIT_MS = 1000;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
/**
 * How long an open socket has to last before it counts as a working stream.
 *
 * A successful handshake is not evidence of one. A stream that opens and is
 * closed again immediately — the shape of a contested connection — would
 * otherwise reset the backoff on every attempt, so the curve never leaves its
 * first step and the two clients bounce off each other at one reconnect a
 * second indefinitely. A healthy stream lives for minutes.
 */
const STABLE_STREAM_MS = 30_000;

/** How long a placements update waits for the stream to be attached. */
const PLACEMENTS_WAIT_MS = 15_000;

/** Switch answered a placements update with anything but success. */
export class PlacementsRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string
  ) {
    super(`Switch refused the session placements (HTTP ${status}): ${detail}`);
    this.name = 'PlacementsRefusedError';
  }
}

export type StreamScope = 'single' | 'all';
export type DeliveryFilter = 'all' | 'addressed';

/**
 * Why a stream ended, in the form a caller can branch on.
 *
 * The prose that comes with it is for a human reading a log and may be
 * reworded at any time. Branch on `code`.
 *
 * - `taken_over` — another client attached to this connection id. **Terminal.**
 *   Reopening is itself a takeover, so a displaced client that retries is how
 *   two clients trade one connection back and forth forever.
 * - `heartbeat_lapsed` — we stopped ticking. Recoverable: reopen and resume.
 * - `closed` — the server ended it for some other reason; `roomId` names the
 *   room when it was about one.
 * - `credentials_rejected` — decided here rather than sent: every reopen would
 *   carry the same token. Terminal.
 */
export interface Eviction {
  code: string;
  reason: string;
  roomId: string | null;
}

export const EVICTION_TAKEN_OVER = 'taken_over';
export const EVICTION_HEARTBEAT_LAPSED = 'heartbeat_lapsed';
export const EVICTION_CLOSED = 'closed';
export const EVICTION_CREDENTIALS_REJECTED = 'credentials_rejected';

/**
 * Read the code off an `evicted` frame, falling back to its prose.
 *
 * A revision-1 server sends prose and no code. Rather than leave every consumer
 * matching strings — the bug this replaces, where one of them matched the short
 * heartbeat wording, missed the long one, and killed a watcher that only needed
 * to reconnect — the one remaining match lives here at the edge, against the
 * three phrasings that server actually produced. It goes when `accepts` rises
 * past revision 1.
 */
function evictionCode(data: Record<string, unknown>): string {
  const code = data.code;
  if (typeof code === 'string' && code.length > 0) return code;
  const reason = String(data.reason ?? '');
  if (reason.startsWith('heartbeat lapsed')) return EVICTION_HEARTBEAT_LAPSED;
  if (reason.startsWith('another stream attached')) return EVICTION_TAKEN_OVER;
  return EVICTION_CLOSED;
}

/**
 * Read the code off a refusal — a rejected heartbeat or a rejected reattach.
 *
 * Every refusal shares one status, and they call for opposite responses: being
 * superseded is terminal, because attaching is itself a takeover, while the
 * rest are recovered by reopening. A server that sends no code — one built
 * before the refusals were distinguishable — yields null, and null keeps the
 * reopen it has always had.
 */
export function refusalCode(body: string): string | null {
  try {
    const detail = (JSON.parse(body) as { detail?: unknown }).detail;
    if (typeof detail !== 'object' || detail === null) return null;
    const code = (detail as { code?: unknown }).code;
    return typeof code === 'string' && code.length > 0 ? code : null;
  } catch {
    return null;
  }
}

/** Resolves when any of these signals aborts, so a wait can be given up on. */
export function until(...signals: AbortSignal[]): Promise<void> {
  const any = AbortSignal.any(signals);
  if (any.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    any.addEventListener('abort', () => resolve(), { once: true });
  });
}

export interface EventStreamLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** A contract `Command`, as relayed; the receiver validates the rest. */
export interface SessionCommand {
  sessionId: string;
  commandId: string;
  [key: string]: unknown;
}

export interface ApprovalOutcome {
  session_id: string;
  request_id: string;
  state: 'answered' | 'expired';
  answer: string | null;
  answered_by: string | null;
  answered_at: string | null;
}

function approvalOutcome(data: Record<string, unknown>): ApprovalOutcome | null {
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  const sessionId = text(data.session_id);
  const requestId = text(data.request_id);
  if (!sessionId || !requestId || (data.state !== 'answered' && data.state !== 'expired'))
    return null;
  return {
    session_id: sessionId,
    request_id: requestId,
    state: data.state,
    answer: text(data.answer),
    answered_by: text(data.answered_by),
    answered_at: text(data.answered_at),
  };
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
  /** A hint to fetch a session's durable command queue; independent of rooms/cursors. */
  onCommands?: (sessionIds: string[]) => Promise<void> | void;
  /**
   * A person answered one of this agent's approval requests, or it expired.
   * Sent again until the session reports it delivered, so it may repeat.
   * Only a connection speaking agent-protocol 4 with scope `all` receives it.
   */
  onApprovalOutcome?: (outcome: ApprovalOutcome) => Promise<void> | void;
  /**
   * A command for one of this agent's sessions, sent by its owner from Switch
   * Console. Switch keeps no copy: whoever receives it is where it lives.
   * Only a connection speaking agent-protocol 5 with scope `all` receives it.
   */
  onSessionCommand?: (command: SessionCommand) => Promise<void> | void;
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
  /**
   * Another connection of this agent took over a room this one held, and
   * `sessionId` names which of this connection's sessions it was placed with,
   * where the server knew. What remembers that placement has to drop it.
   */
  onRoomReleased?: (info: { roomId: string; sessionId: string | null }) => Promise<void> | void;
  /**
   * The server confirmed an open: the first, and every reconnect after it.
   * Where state the server holds only in memory is restated.
   */
  onConnected?: () => void;
  /**
   * An open failed, or an open stream ended, and the stream is about to wait
   * and try again. Not fired for a deliberate reopen, nor once the stream has
   * stopped for good (that is `onEvicted`, or the caller's own signal).
   */
  onDisconnected?: (info: { error: string }) => void;
  /** Fired when the server reports missed events it cannot replay. */
  onGap(info: {
    fromSequence: number;
    reason: string;
    /** The rooms that lost events. Absent from a server that predates naming them. */
    rooms?: string[];
    resumedAt?: number;
    cursorReset?: boolean;
  }): void | Promise<void>;
  /** Fired when another stream took this connection over, or it was closed.
   * A `taken_over` eviction has already halted both loops before this runs:
   * there is nothing left to reconnect, only something to report. */
  onEvicted(eviction: Eviction): void;
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
  /** Aborts the connection for good. Distinct from the caller's signal: some
   * refusals can never be retried into a success, and both loops have to end. */
  private readonly halt = new AbortController();
  private rooms: string[];
  /**
   * Declared on every open, so it can be changed by reopening the socket. What
   * a connection may do on the agent's behalf is a setting a person can turn
   * off while it is connected, and the server only hears it here.
   */
  private spawnCapable: boolean;
  /** What the socket currently being opened actually declared, which is only
   * the value above while no change is waiting to be carried. */
  private declaredSpawnCapable: boolean;
  /**
   * Which incarnation of the connection id the server last told us we are.
   *
   * Sent on every beat so the server can refuse a tick from a client that has
   * been displaced: sharing the id is what makes takeover work, and it is also
   * what makes the loser's beat indistinguishable from the winner's.
   *
   * Kept across a dropped socket rather than cleared. The connection outlives
   * its socket, so a client whose socket merely dropped is still the holder,
   * and nulling this would have it beat unfenced — or, worse, stop beating and
   * lose the connection it still owns. Null only before the first
   * `connection_state`, and against a server too old to send one.
   */
  private generation: number | null = null;
  /**
   * The barrier between the heartbeat and the socket it beats for.
   *
   * The heartbeat waits on it before every tick, so no beat is sent between an
   * open and the frame naming the incarnation that open made: there is nothing
   * current to fence such a tick with, and a stale incarnation is worse than
   * none — the server reads it as a takeover and we would stand down over our
   * own reconnect. Nothing is lost by waiting, since a beat with no stream
   * attached is refused anyway, and a server too old to carry an incarnation
   * still sends the frame.
   *
   * It also disowns a beat that was already in flight when the open began, for
   * the same reason from the other end: that answer was decided about the
   * incarnation we have just replaced.
   */
  private readonly fence = new ReattachFence();

  constructor(deps: SwitchEventStreamDeps) {
    this.deps = deps;
    this.rooms = [...deps.rooms];
    this.cursor = deps.startCursor ?? 0;
    this.spawnCapable = deps.spawnCapable === true;
    this.declaredSpawnCapable = this.spawnCapable;
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
    // Not if the claim revealed we no longer hold the connection: reopening is
    // a takeover, and standing down only to reattach would undo it.
    if (this.halt.signal.aborted) return;
    this.reopen();
  }

  /**
   * Redeclare whether this connection will start a session on demand.
   *
   * The declaration only travels on an open, so the socket is reopened to carry
   * it. That is a reattach rather than a takeover — the incarnation goes with
   * it — so the connection itself survives and nothing else about it changes.
   * Without this a person turning automatic sessions off would leave the server
   * still promising a session this connection is no longer going to start.
   */
  setSpawnCapable(capable: boolean): void {
    if (capable === this.spawnCapable) return;
    this.spawnCapable = capable;
    this.redeclare();
  }

  /**
   * Reopen to carry the current declaration — but only from a socket the server
   * has already named an incarnation for.
   *
   * A reattach claims the incarnation this client believes it holds, and the
   * open that makes the next one is answered asynchronously. Reopening again
   * before that answer arrives claims the incarnation before it, which the
   * server has already moved past and refuses as a takeover — so two changes in
   * quick succession would permanently stand down the agent's only connection.
   * The confirmation carries whatever the declaration has settled on by then
   * instead, and a change that cancels itself out carries nothing. This is the
   * same hazard the heartbeat's fence exists for, from the other side.
   *
   * Nothing to fence before the first `connection_state`, or against a server
   * too old to send one: with no incarnation to claim the reopen is a plain
   * attach, which cannot be refused for being stale.
   */
  private redeclare(): void {
    if (this.declaredSpawnCapable === this.spawnCapable) return;
    if (this.generation !== null && !this.fence.admitting) return;
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

  /** A rejected credential is not an outage: every reopen would carry the same
   * token, so end both loops and tell the owner once. */
  private rejectCredentials(status: number, body: string): void {
    if (this.halt.signal.aborted) return;
    const detail = body.slice(0, 500);
    this.deps.log.error('SwitchEventStream: the server rejected our credentials — stopping', {
      event: 'switch_stream_credentials_rejected',
      status,
      detail,
    });
    this.halt.abort();
    this.deps.onEvicted({
      code: EVICTION_CREDENTIALS_REJECTED,
      reason: `Switch rejected the agent credentials (HTTP ${status})${detail ? `: ${detail}` : ''}`,
      roomId: null,
    });
  }

  /**
   * Give the connection up to the client that now holds it.
   *
   * Ends both loops and reports through the same callback an `evicted` frame
   * does, with the same code, so whatever records the stand-down does not have
   * to care which door the news came through.
   */
  private standDown(): void {
    if (this.halt.signal.aborted) return;
    this.deps.log.warn('SwitchEventStream: the connection was taken over — standing down', {
      event: 'switch_beat_superseded',
      connectionId: this.deps.connectionId,
    });
    this.halt.abort();
    this.deps.onEvicted({
      code: EVICTION_TAKEN_OVER,
      reason: 'another client took this connection over; this one stood down',
      roomId: null,
    });
  }

  private async subscribe(roomId: string): Promise<void> {
    // Not before the stream has told us which incarnation we are. Claiming
    // nothing is how a client too old to have one gets through, so sending it
    // in the window before the first frame would put us through the same door
    // — and that window is exactly when we might already have been displaced
    // without knowing it. A server too old to carry an incarnation still sends
    // the frame, so waiting costs such a client nothing.
    await Promise.race([this.fence.reached, until(this.deps.signal, this.halt.signal)]);
    if (this.halt.signal.aborted) return;
    const resp = await this.post('connection/subscribe', {
      connection_id: this.deps.connectionId,
      room_id: roomId,
      // Claimed against the incarnation we hold, because this runs *before*
      // the reopen and so before the open's own check. A connection id
      // outlives a takeover: without this a client that has already been
      // displaced would rewrite the winner's rooms — and evict whoever holds
      // the room it asks for — and being refused the open afterwards would
      // come too late to undo any of it.
      generation: this.generation,
    });
    if (!resp.ok) {
      const body = await resp.text();
      if (resp.status === 409 && refusalCode(body) === EVICTION_TAKEN_OVER) {
        // Not this connection's client any more. Terminal, like every other
        // door onto a takeover: there is nothing to repoint.
        this.standDown();
        return;
      }
      // 409 means another live connection of this agent already holds the room
      // — usually a stale session. Loud: quietly carrying on would leave us
      // attached to a stream that will never deliver that room's events.
      throw new Error(`subscribe to ${roomId} failed: HTTP ${resp.status}`);
    }
  }

  /**
   * State which room each of this connection's sessions is placed in, replacing
   * whatever Switch held for it.
   *
   * Fenced like a subscribe, and for the same reason: sent before the stream
   * has named its incarnation, or by a client that has been displaced, it
   * would rewrite the placements of whoever holds the connection now. Waits
   * up to `PLACEMENTS_WAIT_MS` for the stream to be attached, then refuses.
   * Raises on any answer but success; a takeover also stands the stream down.
   */
  async replacePlacements(placements: Record<string, string>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attached = await Promise.race([
      this.fence.reached.then(() => true),
      until(this.deps.signal, this.halt.signal).then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), PLACEMENTS_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (!attached || this.halt.signal.aborted)
      throw new Error('the connection to Switch is not open, so it cannot take placements');
    const resp = await this.post('connection/placements', {
      connection_id: this.deps.connectionId,
      placements,
      generation: this.generation,
    });
    if (resp.ok) return;
    const body = await resp.text();
    if (resp.status === 409 && refusalCode(body) === EVICTION_TAKEN_OVER) this.standDown();
    throw new PlacementsRefusedError(resp.status, body.slice(0, 500));
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
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.deps.signal, this.halt.signal]),
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

    /** Wait before reopening, and widen the wait.
     *
     * Every ending an open socket can have comes through here — a transport
     * error and a clean close alike. The clean close is the one that used to be
     * free: the server ends the stream, the read loop finishes, and the next
     * open went out with no delay at all. That is a storm precisely when the
     * server is ending streams on purpose.
     */
    const pace = async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };

    while (!signal.aborted && !this.halt.signal.aborted) {
      const socketAbort = new AbortController();
      this.socketAbort = socketAbort;
      // Closed before the open rather than after it lands: it is this open
      // that makes the new incarnation, so the heartbeat has to be held from
      // here until the frame naming it arrives. A beat already in flight is
      // given a moment to come back and be believed, and disowned after that.
      await this.fence.detaching(BEAT_SETTLE_LIMIT_MS);
      if (signal.aborted || this.halt.signal.aborted) return;
      let openedAt = 0;
      let failure: unknown = null;
      try {
        const params = new URLSearchParams({
          connection_id: connectionId,
          scope,
          filter,
          start_from:
            this.cursor > 0 || this.deps.startCursor !== undefined ? String(this.cursor) : 'head',
          // What we are and what we speak, declared on the connect we already
          // make (CHOO-1865). A client that says nothing records as unknown
          // server-side, and a declaration cannot be backfilled after the fact
          // — every release that ships silent is a permanent blind spot.
          protocol: String(AGENT_PROTOCOL.speaks),
          protocol_accepts: String(AGENT_PROTOCOL.accepts),
          client: RUNTIME_ARTIFACT,
          client_version: RUNTIME_VERSION,
        });
        this.declaredSpawnCapable = this.spawnCapable;
        if (this.declaredSpawnCapable) params.set('spawn_capable', 'true');
        if (this.rooms.length) params.set('rooms', this.rooms.join(','));
        // Reattaching, so say which incarnation we believe we still are and
        // let the server refuse us if we are wrong. An attach is a takeover,
        // and a client that missed its own eviction — a partition, a dropped
        // socket, a beat whose refusal never arrived — would otherwise take
        // the connection straight back off whoever legitimately holds it. The
        // first open of this object's life sends nothing, which is how a
        // deliberate takeover still works: it has no incarnation to claim.
        if (this.generation !== null) params.set('expected_generation', String(this.generation));

        const resp = await fetch(`${creds.apiEndpoint}/agents/${creds.agentId}/events?${params}`, {
          headers: {
            Authorization: `Bearer ${creds.token}`,
            Accept: 'text/event-stream',
            ...(this.cursor > 0 ? { 'Last-Event-ID': String(this.cursor) } : {}),
          },
          signal: AbortSignal.any([socketAbort.signal, signal, this.halt.signal]),
        });

        if (!resp.ok || !resp.body) {
          const body = await resp.text();
          // Reopening without the refused room is a different request from the
          // one that just failed, and the declared set strictly shrinks, so
          // this cannot spin: retry now rather than serving the backoff a
          // transport failure earned.
          if (this.dropRefusedRooms(resp.status, body)) continue;
          if (resp.status === 401 || resp.status === 403) {
            this.rejectCredentials(resp.status, body);
            return;
          }
          if (resp.status === 409 && refusalCode(body) === EVICTION_TAKEN_OVER) {
            // The reattach was refused because someone else holds the
            // connection now, and nothing was disturbed in refusing it. This
            // is the only place the loser can be told once its socket and its
            // heartbeat have both stopped being able to reach it.
            this.standDown();
            return;
          }
          throw new Error(`HTTP ${resp.status}: ${body}`);
        }

        openedAt = Date.now();
        log.debug('SwitchEventStream: stream open', {
          event: 'switch_stream_open',
          connectionId,
          cursor: this.cursor,
          rooms: this.rooms,
        });

        for await (const frame of readSse(resp.body, socketAbort.signal)) {
          await this.handleFrame(frame);
          if (frame.id) this.cursor = Math.max(this.cursor, Number(frame.id) || 0);
        }
      } catch (error) {
        failure = error;
      }

      if (signal.aborted || this.halt.signal.aborted) return;
      // A deliberate reopen (repoint) aborts the socket. Not an ending to
      // count, and not one to wait out — reopening at once is the point of it.
      if (socketAbort.signal.aborted) continue;

      // Only a stream that lasted proves the endpoint is healthy. Resetting on
      // the handshake alone would let an immediately-closed stream clear the
      // curve it is supposed to be climbing.
      if (openedAt > 0 && Date.now() - openedAt >= STABLE_STREAM_MS) {
        if (failures > 0) {
          log.warn('SwitchEventStream: stream recovered', {
            event: 'switch_stream_recovered',
            afterFailures: failures,
          });
          failures = 0;
        }
        backoff = INITIAL_BACKOFF_MS;
      }

      failures += 1;
      const error = failure === null ? 'the server closed the stream' : String(failure);
      if ((failures & (failures - 1)) === 0) {
        log.warn('SwitchEventStream: stream ended — reopening', {
          event: 'switch_stream_error',
          endpoint: creds.apiEndpoint,
          failures,
          error,
          backoffMs: backoff,
        });
      }
      this.deps.onDisconnected?.({ error });
      await pace();
    }
  }

  private async handleFrame(frame: SseFrame): Promise<void> {
    const { log, onGap, onEvicted, onEvent } = this.deps;
    switch (frame.event) {
      case 'connection_state':
        if (typeof frame.data.generation === 'number') this.generation = frame.data.generation;
        log.debug('SwitchEventStream: connection established', {
          event: 'switch_stream_connected',
          rooms: frame.data.rooms,
          generation: this.generation,
          // What the server says it is (CHOO-1865). Recorded, not acted on —
          // logging it is what makes "which versions are actually talking to
          // each other" answerable from a bug report rather than a guess.
          server: frame.data.server ?? null,
        });
        this.reportRooms(frame.data.rooms);
        this.fence.attached();
        this.redeclare();
        this.deps.onConnected?.();
        return;
      case 'room_released': {
        const roomId = frame.data.room_id;
        const sessionId = frame.data.session_id ?? null;
        if (typeof roomId === 'string' && (sessionId === null || typeof sessionId === 'string')) {
          log.warn('SwitchEventStream: another connection took a room over', {
            event: 'switch_stream_room_released',
            roomId,
            sessionId,
          });
          await this.deps.onRoomReleased?.({ roomId, sessionId });
        } else
          log.warn('SwitchEventStream: unreadable room release dropped', {
            event: 'switch_stream_bad_release',
          });
        return;
      }
      case 'session_commands':
        if (
          Array.isArray(frame.data.session_ids) &&
          frame.data.session_ids.every((id) => typeof id === 'string')
        )
          await this.deps.onCommands?.(frame.data.session_ids as string[]);
        return;
      case 'subscription_changed':
        log.debug('SwitchEventStream: subscription changed', {
          event: 'switch_stream_subscription',
          rooms: frame.data.rooms,
        });
        this.reportRooms(frame.data.rooms);
        return;
      case 'gap': {
        const rooms = Array.isArray(frame.data.rooms) ? frame.data.rooms.map(String) : undefined;
        log.warn('SwitchEventStream: gap — events missed', {
          event: 'switch_stream_gap',
          fromSequence: frame.data.from_sequence,
          reason: frame.data.reason,
          rooms: rooms ?? null,
        });
        const resumedAt = frame.data.resumed_at;
        if (resumedAt !== undefined && (!Number.isSafeInteger(resumedAt) || Number(resumedAt) < 0))
          throw new Error('Switch returned an invalid gap resume cursor.');
        await onGap({
          fromSequence: Number(frame.data.from_sequence ?? 0),
          reason: String(frame.data.reason ?? 'events were missed'),
          ...(rooms === undefined ? {} : { rooms }),
          ...(resumedAt === undefined
            ? {}
            : { resumedAt: Number(resumedAt), cursorReset: Number(resumedAt) < this.cursor }),
        });
        if (resumedAt !== undefined) this.cursor = Number(resumedAt);
        return;
      }
      case 'evicted': {
        const code = evictionCode(frame.data);
        log.warn('SwitchEventStream: evicted', {
          event: 'switch_stream_evicted',
          code,
          reason: frame.data.reason,
          roomId: frame.data.room_id ?? null,
        });
        // Halt before reporting: a takeover is the one ending that reopening
        // cannot recover, because reopening is itself a takeover. Both loops
        // end here, and nothing the callback does can restart them.
        if (code === EVICTION_TAKEN_OVER) this.halt.abort();
        onEvicted({
          code,
          reason: String(frame.data.reason ?? 'connection closed'),
          roomId: typeof frame.data.room_id === 'string' ? frame.data.room_id : null,
        });
        return;
      }
      case 'session_command': {
        const sessionId = frame.data.sessionId;
        if (typeof sessionId === 'string' && typeof frame.data.commandId === 'string')
          await this.deps.onSessionCommand?.({ ...frame.data, sessionId } as SessionCommand);
        else
          log.warn('SwitchEventStream: unreadable session command dropped', {
            event: 'switch_stream_bad_command',
          });
        return;
      }
      case 'approval_outcome': {
        const outcome = approvalOutcome(frame.data);
        if (outcome) await this.deps.onApprovalOutcome?.(outcome);
        else
          log.warn('SwitchEventStream: unreadable approval outcome dropped', {
            event: 'switch_stream_bad_outcome',
          });
        return;
      }
      default:
        if (typeof frame.data.type !== 'string') {
          // A frame this runtime does not know and cannot read as a room event.
          log.warn('SwitchEventStream: unknown frame dropped', {
            event: 'switch_stream_unknown_frame',
            frame: frame.event,
          });
          return;
        }
        await onEvent(frame.data as unknown as AgentBridgeEvent);
    }
  }

  /**
   * The single heartbeat. Proves we are alive and reports the cursor.
   *
   * A 404 or 409 means we are not receiving — the connection expired, or it has
   * no stream attached. Both are recovered by reopening, which resumes from the
   * cursor, and both count as a beat that did not land. The exception is the
   * 409 that says another client has taken the connection over, which no
   * reopen recovers because a reopen is itself a takeover: that one ends here.
   * For the rest the remedy is a reopen, and a reopen that keeps being refused
   * is a client that cannot succeed and must not be retried at full rate
   * forever. Failing quietly here is the one thing that must not happen: a
   * client that has stopped receiving while believing it is connected is
   * exactly the bug this transport exists to remove.
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

    /** Count a beat that did not land and slow the loop down. Returns whether
     * to report this one: the first, then powers of two, so a permanent
     * failure costs a handful of lines rather than one per beat. */
    const slowDown = (): boolean => {
      failures += 1;
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      return (failures & (failures - 1)) === 0;
    };

    const fail = (error: unknown): void => {
      if (!slowDown()) return;
      log.warn('SwitchEventStream: heartbeat failed', {
        event: 'switch_beat_failed',
        endpoint: this.deps.creds.apiEndpoint,
        failures,
        error: String(error),
        backoffMs: backoff,
      });
    };

    /**
     * One beat, as a value rather than a throw.
     *
     * A beat the fence disowns must have no outcome at all, and an exception
     * is an outcome — it would slow the loop down over a request the reattach
     * itself invalidated. So the whole exchange, body included, happens inside
     * the flight the fence is timing, and comes back as something to ignore or
     * act on once it is known which.
     */
    const beat = async (): Promise<
      | { answered: true; status: number; ok: boolean; body: string }
      | { answered: false; error: unknown }
    > => {
      try {
        const resp = await this.post('connection/beat', {
          connection_id: connectionId,
          cursor: this.cursor,
          generation: this.generation,
        });
        return { answered: true, status: resp.status, ok: resp.ok, body: await resp.text() };
      } catch (error) {
        return { answered: false, error };
      }
    };

    while (!signal.aborted && !this.halt.signal.aborted) {
      // Every pass, not only the first: a reconnect makes a new incarnation,
      // and the tick has to name the one the server is on. Nothing may be
      // awaited between passing the gate and registering the flight, or the
      // beat could be sent under an incarnation later than the one recorded.
      await Promise.race([this.fence.reached, until(signal, this.halt.signal)]);
      if (signal.aborted || this.halt.signal.aborted) return;
      const tick = await this.fence.tick(beat);
      if (signal.aborted || this.halt.signal.aborted) return;

      if (!tick.current) {
        // A reattach began while this was in flight, so the answer describes
        // an incarnation we are no longer on and cannot be told apart from
        // one that arrived late about our own reopen. Inert: no stand-down,
        // no reopen, no cursor, and no mark against the beat rate either.
        log.debug('SwitchEventStream: heartbeat answer discarded — reattached in flight', {
          event: 'switch_beat_stale',
          connectionId,
        });
      } else if (!tick.value.answered) {
        fail(tick.value.error);
      } else {
        const { status, ok, body } = tick.value;
        if (status === 401 || status === 403) {
          this.rejectCredentials(status, body);
          return;
        }
        if (status === 409 && refusalCode(body) === EVICTION_TAKEN_OVER) {
          // The other door onto a takeover. A displaced client whose socket
          // dropped before the `evicted` frame reached it learns here instead,
          // and must end the same way: reopening is a takeover, so a loser
          // that reopens takes the connection straight back off the winner.
          this.standDown();
          return;
        }
        if (status === 404 || status === 409) {
          // The server answered, so this is not an outage — but it is not a
          // beat that landed either: we are not attached, and only a reopen
          // fixes that. Reopen, and slow down all the same. A reopen that
          // keeps being refused is a client that cannot currently succeed,
          // and it must not spend the endpoint at full rate while it fails.
          const report = slowDown();
          this.reopen();
          if (report) {
            log.warn('SwitchEventStream: heartbeat rejected — reopening', {
              event: 'switch_beat_rejected',
              status,
              connectionId,
              failures,
              backoffMs: backoff,
            });
          }
        } else if (!ok) {
          fail(new Error(`HTTP ${status}`));
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
      }
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

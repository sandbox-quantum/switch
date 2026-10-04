import { contractRange } from './artifacts';
import { ReattachFence } from './reattach-fence';
import type { AgentBridgeEvent, SwitchCredentials } from './types';
import { RUNTIME_ARTIFACT, RUNTIME_VERSION } from './version';

/** This artifact's own range for the contract it speaks to Switch over. */
const AGENT_PROTOCOL = contractRange('agent-protocol', RUNTIME_ARTIFACT);

/**
 * The agent bridge's connection (CHOO-1857), client side.
 *
 * One WebSocket per connection, tied to a connection id we choose. It carries
 * the events down and the heartbeat both ways: the server sends `ping` every
 * heartbeat interval and we answer `pong` with our cursor, which is what keeps
 * the connection alive. The token is checked once, when the socket opens. The
 * connection outlives its socket: losing the socket stops delivery but does not
 * end the connection, so reconnecting within the heartbeat TTL keeps the room
 * slot and the role lease and resumes from the cursor.
 *
 * Every event carries a sequence number, and a reconnect names the last one we
 * handled, so we get exactly what we missed. A gap is never silent: if the
 * server cannot serve our cursor it says so, and `onGap` fires so the caller
 * can tell the agent to re-read context rather than carry on believing it saw
 * everything.
 */

/** How long a request on the side (a room claim, placements) may take. */
const REQUEST_TIMEOUT_MS = 4000;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
/**
 * The close code a server sends when it is restarting (uvicorn sends it to
 * every open socket on shutdown).
 *
 * A restart is the one ending we know is short, and the doubling backoff fits
 * it badly: the socket closes as shutdown begins, so the first retries are
 * refused while the server is down and the next one lands seconds after it is
 * back. For a while after this code we retry at a short, randomised interval
 * instead, which brings the agent back within a second of the server and
 * spreads a fleet of agents over that second rather than one instant.
 */
const SERVICE_RESTART = 1012;
const RESTART_WINDOW_MS = 60_000;
const RESTART_RETRY_MIN_MS = 250;
const RESTART_RETRY_SPREAD_MS = 500;
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
 * - `heartbeat_lapsed` — we stopped answering pings. Recoverable: reopen and resume.
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
 * Read the code off a refusal — a rejected open or reattach.
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
   * A `taken_over` eviction has already halted the connection before this runs:
   * there is nothing left to reconnect, only something to report. */
  onEvicted(eviction: Eviction): void;
  log: EventStreamLogger;
  /** Aborts the connection. */
  signal: AbortSignal;
}

/**
 * The server refused to open the connection: a `refused` frame, or a close
 * code of 4000 plus an HTTP status. `body` is shaped like the HTTP error body
 * the same refusal would have had (`{"detail": ...}`), so the remedies that
 * read it do not care which transport it came over.
 */
export class OpenRefused extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`HTTP ${status}: ${body}`);
    this.name = 'OpenRefused';
  }
}

/** One frame off the socket: `{event, data, id}`, `id` being its sequence number. */
export type SocketFrame = { event: string; id?: string; data: Record<string, unknown> };

/** Node's WebSocket, which, unlike a browser's, takes request headers. */
type HeaderedWebSocket = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

export class SwitchEventStream {
  private readonly deps: SwitchEventStreamDeps;
  /** Highest sequence number received. Sent with every pong and as
   * `start_from` when reopening. Seeded from `startCursor` when the caller
   * needs to begin behind head rather than at it. */
  private cursor: number;
  /** Aborts only the current socket, so a reconnect can replace it without
   * tearing down the connection. */
  private socketAbort: AbortController | null = null;
  /** Aborts the connection for good. Distinct from the caller's signal: some
   * refusals can never be retried into a success, and the loop has to end. */
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
   * Sent as `expected_generation` on every reopen, so the server refuses a
   * reattach from a client that has been displaced: sharing the id is what
   * makes takeover work, and it is also what makes the loser's reopen
   * indistinguishable from the winner's.
   *
   * Kept across a dropped socket rather than cleared. The connection outlives
   * its socket, so a client whose socket merely dropped is still the holder,
   * and nulling this would have it reopen unfenced and take the connection
   * back off whoever holds it now. Null only before the first
   * `connection_state`.
   */
  private generation: number | null = null;
  /**
   * Closed from the moment an open starts until the frame naming the
   * incarnation that open made arrives.
   *
   * A reopen asked for in between waits on it (see `reopen`): there is nothing
   * current to claim, and a stale incarnation is worse than none, since the
   * server reads it as a takeover and we would stand down over our own
   * reconnect.
   */
  private readonly fence = new ReattachFence();
  /**
   * Reopens asked for, and how many of those the open now in progress was
   * built after — so a reopen asked for mid-open is carried out once that open
   * is answered, never by cancelling it. See `reopen`.
   */
  private reopensWanted = 0;
  /** Until when the server is taken to be restarting (see `SERVICE_RESTART`). */
  private restartingUntil = 0;
  private openCarries = 0;

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
   * same hazard the fence exists for.
   *
   * Nothing to fence before the first `connection_state`: with no incarnation
   * to claim the reopen is a plain attach, which cannot be refused for being
   * stale.
   */
  private redeclare(): void {
    if (this.declaredSpawnCapable === this.spawnCapable) return;
    if (this.generation !== null && !this.fence.admitting) return;
    this.reopen();
  }

  /**
   * Replace the socket — but never by cancelling an open the server has not
   * answered yet.
   *
   * An open is a request the server acts on as soon as it arrives: it makes a
   * new incarnation of the connection there and then. Cancelling it
   * client-side does not undo that, it only stops us reading the answer that
   * names the new incarnation. The next open then claims the incarnation
   * before it, which the server has moved past, and is refused as a takeover
   * — terminal. The client stands down, and the "other client" it yielded to
   * was its own cancelled request.
   *
   * So a reopen asked for while an open is in flight is remembered instead,
   * and carried out when that open's `connection_state` arrives, by which time
   * we know the incarnation to claim. An open that was already built after the
   * request carries it and needs no second one.
   */
  private reopen(): void {
    this.reopensWanted += 1;
    if (!this.fence.admitting) return;
    // Held from this instant, not from when the stream loop gets round to its
    // own `detaching`, so a second reopen asked for straight after this one
    // waits for the incarnation it makes rather than claiming the old one.
    this.fence.closeAdmission();
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
   * token, so end the connection and tell the owner once. */
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
   * Whether a takeover refusal for a request sent under `sent` describes a
   * reopen of our own.
   *
   * A request carries the incarnation it was sent under, and the server
   * refuses it as taken over once the connection has moved past that. But
   * this client reopens its own socket — after an eviction, a dropped socket, a
   * repoint — and a request in flight across that reopen is refused the same
   * way, naming as the new holder the incarnation this client now is. Standing
   * down on that gives the connection up to ourselves, for good. A real
   * takeover after our reopen is still caught: the server tells the socket we
   * now hold with an `evicted` frame.
   */
  private supersededOurselves(sent: number | null): boolean {
    return sent !== null && this.generation !== null && this.generation !== sent;
  }

  /**
   * Give the connection up to the client that now holds it.
   *
   * Ends the connection and reports through the same callback an `evicted` frame
   * does, with the same code, so whatever records the stand-down does not have
   * to care which door the news came through.
   */
  private standDown(): void {
    if (this.halt.signal.aborted) return;
    this.deps.log.warn('SwitchEventStream: the connection was taken over — standing down', {
      event: 'switch_stream_superseded',
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
    const generation = this.generation;
    const resp = await this.post('connection/subscribe', {
      connection_id: this.deps.connectionId,
      room_id: roomId,
      // Claimed against the incarnation we hold, because this runs *before*
      // the reopen and so before the open's own check. A connection id
      // outlives a takeover: without this a client that has already been
      // displaced would rewrite the winner's rooms — and evict whoever holds
      // the room it asks for — and being refused the open afterwards would
      // come too late to undo any of it.
      generation,
    });
    if (!resp.ok) {
      const body = await resp.text();
      if (resp.status === 409 && refusalCode(body) === EVICTION_TAKEN_OVER) {
        if (this.supersededOurselves(generation))
          throw new Error(
            `subscribe to ${roomId} was answered for an incarnation this connection has since reopened past; ask again`
          );
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
    const generation = this.generation;
    const resp = await this.post('connection/placements', {
      connection_id: this.deps.connectionId,
      placements,
      generation,
    });
    if (resp.ok) return;
    const body = await resp.text();
    if (
      resp.status === 409 &&
      refusalCode(body) === EVICTION_TAKEN_OVER &&
      !this.supersededOurselves(generation)
    )
      this.standDown();
    throw new PlacementsRefusedError(resp.status, body.slice(0, 500));
  }

  private post(path: string, body: unknown, timeoutMs = REQUEST_TIMEOUT_MS) {
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
   * as well as a beginning.
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
      if (Date.now() < this.restartingUntil) {
        const wait = RESTART_RETRY_MIN_MS + Math.random() * RESTART_RETRY_SPREAD_MS;
        await new Promise((r) => setTimeout(r, wait));
        return;
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };

    while (!signal.aborted && !this.halt.signal.aborted) {
      const socketAbort = new AbortController();
      this.socketAbort = socketAbort;
      // Closed before the open rather than after it lands: it is this open
      // that makes the new incarnation, so a reopen has to wait from here
      // until the frame naming it arrives.
      await this.fence.detaching(0);
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
        this.openCarries = this.reopensWanted;
        if (this.declaredSpawnCapable) params.set('spawn_capable', 'true');
        if (this.rooms.length) params.set('rooms', this.rooms.join(','));
        // Reattaching, so say which incarnation we believe we still are and
        // let the server refuse us if we are wrong. An attach is a takeover,
        // and a client that missed its own eviction — a partition, a dropped
        // socket, an eviction frame that never arrived — would otherwise take
        // the connection straight back off whoever legitimately holds it. The
        // first open of this object's life sends nothing, which is how a
        // deliberate takeover still works: it has no incarnation to claim.
        if (this.generation !== null) params.set('expected_generation', String(this.generation));

        const url = `${creds.apiEndpoint.replace(/^http/, 'ws')}/agents/${creds.agentId}/connection/ws?${params}`;
        for await (const frame of this.readSocket(url, socketAbort.signal, () => {
          openedAt = Date.now();
          this.restartingUntil = 0;
          log.debug('SwitchEventStream: connection open', {
            event: 'switch_stream_open',
            connectionId,
            cursor: this.cursor,
            rooms: this.rooms,
          });
        })) {
          await this.handleFrame(frame);
          if (frame.id) this.cursor = Math.max(this.cursor, Number(frame.id) || 0);
        }
      } catch (error) {
        if (error instanceof OpenRefused) {
          const { status, body } = error;
          // Reopening without the refused room is a different request from the
          // one that just failed, and the declared set strictly shrinks, so
          // this cannot spin: retry now rather than serving the backoff a
          // transport failure earned.
          if (this.dropRefusedRooms(status, body)) continue;
          if (status === 401 || status === 403) {
            this.rejectCredentials(status, body);
            return;
          }
          if (status === 409 && refusalCode(body) === EVICTION_TAKEN_OVER) {
            // The reattach was refused because someone else holds the
            // connection now, and nothing was disturbed in refusing it.
            this.standDown();
            return;
          }
        }
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

  /**
   * Open the connection's socket and yield its frames until it closes.
   *
   * The heartbeat is answered here, as each `ping` arrives, not queued behind
   * the frames: handling an event can take as long as the agent likes, and
   * the server must not decide we are gone while it does. The pong carries
   * the cursor as it stands, which is the last event fully handled.
   */
  private async *readSocket(
    url: string,
    abort: AbortSignal,
    onOpen: () => void
  ): AsyncGenerator<SocketFrame> {
    const Socket = (globalThis as { WebSocket?: HeaderedWebSocket }).WebSocket;
    if (!Socket) {
      throw new Error(
        `this runtime needs Node 22 or newer to connect to Switch (it has ${process.version}, with no WebSocket)`
      );
    }
    const socket = new Socket(url, {
      headers: { Authorization: `Bearer ${this.deps.creds.token}` },
    });
    const pending: SocketFrame[] = [];
    let refused: unknown = null;
    let closed: { code: number; reason: string } | null = null;
    let opened = false;
    let wake: (() => void) | null = null;
    const notify = (): void => {
      const resolve = wake;
      wake = null;
      resolve?.();
    };
    socket.addEventListener('open', () => {
      opened = true;
      onOpen();
    });
    socket.addEventListener('message', (message: MessageEvent) => {
      let parsed: { event?: unknown; data?: unknown; id?: unknown };
      try {
        parsed = JSON.parse(String(message.data)) as typeof parsed;
      } catch {
        return;
      }
      if (parsed.event === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', cursor: this.cursor }));
        return;
      }
      if (parsed.event === 'refused') {
        refused = (parsed.data as { detail?: unknown } | undefined)?.detail ?? null;
        return;
      }
      if (typeof parsed.event !== 'string') return;
      pending.push({
        event: parsed.event,
        data: (parsed.data as Record<string, unknown> | undefined) ?? {},
        ...(parsed.id !== undefined ? { id: String(parsed.id) } : {}),
      });
      notify();
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      closed = { code: event.code, reason: event.reason };
      if (event.code === SERVICE_RESTART) this.restartingUntil = Date.now() + RESTART_WINDOW_MS;
      notify();
    });
    socket.addEventListener('error', () => notify());
    const stop = (): void => socket.close(1000);
    abort.addEventListener('abort', stop, { once: true });
    try {
      for (;;) {
        while (pending.length > 0) yield pending.shift() as SocketFrame;
        if (closed !== null || abort.aborted) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const ending = closed as { code: number; reason: string } | null;
      if (ending !== null && ending.code >= 4000 && ending.code < 5000) {
        throw new OpenRefused(
          ending.code - 4000,
          JSON.stringify({ detail: refused ?? ending.reason })
        );
      }
      if (!opened && !abort.aborted) {
        throw new Error(
          `could not connect to Switch (socket closed with ${ending?.code ?? 'no code'}): the server is unreachable, or older than this runtime and has no agent WebSocket`
        );
      }
    } finally {
      abort.removeEventListener('abort', stop);
      if (socket.readyState === socket.CONNECTING || socket.readyState === socket.OPEN) {
        socket.close(1000);
      }
    }
  }

  private async handleFrame(frame: SocketFrame): Promise<void> {
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
        // A reopen asked for while this open was in flight, for something this
        // open was built too early to carry. Now that we know the incarnation
        // to claim, it is safe to replace the socket — and done before the
        // gate opens, so nothing else is sent on a socket about to be dropped.
        if (this.reopensWanted > this.openCarries) {
          this.socketAbort?.abort();
          return;
        }
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
        // cannot recover, because reopening is itself a takeover. The
        // connection ends here, and nothing the callback does can restart them.
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
}

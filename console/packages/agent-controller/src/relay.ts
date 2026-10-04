import { createHash, randomBytes, randomInt } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { z } from 'zod';
import { errorMessage, type Logger } from './log';
import type {
  AgentApprovalOutcomeFrame,
  AgentEventFrame,
  AgentGapFrame,
  AgentSessionCommandFrame,
  AgentWorkerClosedFrame,
  AgentWorkerFrame,
  WorkerIdentity,
} from './schemas';

/**
 * The controller's local relay: what each managed agent's host uses as
 * `SWITCH_API_ENDPOINT`, on a loopback port, with a token minted here for each
 * agent.
 *
 * Every call an agent host makes is forwarded to Switch with the controller's
 * access token, the agent named in `X-Switch-Agent-Id`, and the calling
 * session's room in `X-Switch-Room-Id`.
 *
 * An isolated agent's host runs in a process of its own, so it also hears its
 * events here: Switch delivers every agent's events on the one controller
 * stream, and the relay serves an isolated agent's to it as its own per-agent
 * stream, reproducing the agent protocol (`GET /agents/{id}/events` with its
 * frames, ids and resume, the heartbeat, placements and room claims). A shared
 * agent's host runs in the controller's process and hears its events from the
 * `AgentHub` instead; the room of its calls comes from there too.
 *
 * A cloud agent's host opens its stream as a worker (it sends
 * `X-Switch-Worker-Capability` and the host identity). The relay has Core
 * admit it on the controller's connection before the stream opens, passes a
 * refusal back as Core sent it, writes the `worker_attached` payload as the
 * stream's second frame, and from then on replays the worker's protocol-7
 * frames (`agent.worker` on the controller stream) on that stream. A worker
 * stream needs the controller stream: it is refused with 503 while that is
 * down, and ended when it drops, so the worker opens it again once Core can
 * admit it.
 */

/** The agent-protocol revisions the relay serves, as switch-core declares its own. */
export const RELAY_AGENT_PROTOCOL = { speaks: 7, accepts: 1 } as const;
/** From this revision a client names its connection incarnation on every beat and room request. */
const FENCED_PROTOCOL_REVISION = 2;
const APPROVAL_OUTCOME_PROTOCOL_REVISION = 4;
const SESSION_COMMAND_PROTOCOL_REVISION = 5;
const ROOM_RELEASED_PROTOCOL_REVISION = 6;
const MAX_CONNECTIONS_PER_AGENT = 32;
const MAX_JSON_BODY_BYTES = 256 * 1024;

/** Every token the relay mints starts with this, which tells it apart from a Switch credential. */
export const RELAY_TOKEN_PREFIX = 'swlr_';

export type RelayTiming = {
  /** A connection with no beat for this long is closed, as Switch closes one. */
  heartbeatTtlMs: number;
  /** What `connection_state` tells the client to beat on. */
  heartbeatIntervalS: number;
  sweepMs: number;
  keepaliveMs: number;
};

export const DEFAULT_RELAY_TIMING: RelayTiming = {
  heartbeatTtlMs: 6_000,
  heartbeatIntervalS: 2,
  sweepMs: 1_000,
  keepaliveMs: 15_000,
};

/**
 * How the relay has Core admit a cloud agent's worker, and let it go: on the
 * controller's connection, which the controller holds. `unavailable` means
 * there is no controller connection to attach on right now.
 */
export interface WorkerLink {
  attach(agentId: string, worker: WorkerIdentity): Promise<WorkerAttachResult>;
  detach(agentId: string, worker: { connectionId: string; generation: number }): void;
}

export type WorkerAttachResult =
  | { ok: true; attached: Record<string, unknown> }
  | { ok: false; kind: 'worker'; status: number; body: string }
  | { ok: false; kind: 'controller'; status: number; code: string; message: string }
  | { ok: false; kind: 'unavailable'; message: string };

/** Where a request that is not connection bookkeeping goes. */
export interface Forwarder {
  forward(
    req: IncomingMessage,
    res: ServerResponse,
    target: { agentId: string; roomId: string | null; path: string }
  ): Promise<void>;
}

export type RelayDeps = {
  log: Logger;
  /** The room of a call for a shared agent (one whose host runs in the controller), from the calling session. */
  sharedRoomFor: (agentId: string, sessionId: string | null) => string | null;
  version: string;
  forwarder: Forwarder;
  workers: WorkerLink;
  /** An agent's confirmed cursor moved; the controller persists it and beats it upstream. */
  onCursor: (agentId: string, cursor: number) => void;
  /** Something `attached()` reads changed. */
  onChange: () => void;
  now: () => number;
  timing: RelayTiming;
  /** The most events held per agent for local resume; past it the oldest go, and say so. */
  bufferLimit: number;
};

type Declaration = {
  speaks: number | null;
  accepts: number | null;
  artifact: string | null;
  version: string | null;
};

type LocalStream = {
  res: ServerResponse;
  generation: number;
  /** The rooms the client was last told it covers. */
  told: Set<string>;
};

type LocalConnection = {
  id: string;
  agentId: string;
  scope: 'single' | 'all';
  filter: 'all' | 'addressed';
  spawnCapable: boolean;
  /** The last sequence written out (or skipped); null until the agent's head is known. */
  cursor: number | null;
  /** The last sequence the client confirmed on a beat, never moving back. */
  confirmed: number | null;
  generation: number;
  lastBeat: number;
  stream: LocalStream | null;
  rooms: Set<string>;
  released: Map<string, string | null>;
  declaration: Declaration;
  /** Core admitted this connection as the agent's cloud worker, at its current generation. */
  worker: boolean;
};

type Buffered =
  | { kind: 'event'; seq: number; type: string; roomId: string; notifiable: boolean; data: object }
  | { kind: 'gap'; seq: number; data: Record<string, unknown> };

type AgentState = {
  agentId: string;
  /** Core attached the agent to the controller stream. */
  attached: boolean;
  /** The rooms the agent belongs to, as Core last said; null before it has. */
  rooms: Set<string> | null;
  /** The highest sequence known for this agent. */
  head: number | null;
  /** Below or at this, the relay holds nothing: a cursor here gets a gap. */
  droppedThrough: number;
  /** The cursor the controller resumes the agent from upstream. */
  confirmed: number | null;
  buffer: Buffered[];
  /** The last time Core reset the agent's numbering (a Core restart). */
  reset: { reason: string; rooms: string[] } | null;
  connections: Map<string, LocalConnection>;
  /** Each session's room, and the connection that placed it there. */
  placements: Map<string, { roomId: string; owner: string }>;
  overflowing: boolean;
};

class HttpRefusal extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown
  ) {
    super(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
}

/** A refusal from Switch, passed back with its status and body as they came. */
class RawRefusal extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`HTTP ${status}`);
  }
}

function coded(status: number, code: string, message: string): HttpRefusal {
  return new HttpRefusal(status, { code, message });
}

function notOpen(connectionId: string): HttpRefusal {
  return new HttpRefusal(
    404,
    `connection ${connectionId} is not open; reconnect and resume from your cursor`
  );
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Whether a client filtering to what addresses the agent is sent this event, as Switch decides. */
export function isNotifiable(type: string, payload: Record<string, unknown>): boolean {
  if (type === 'message') return payload.addressed === true;
  if (type === 'room_join') return payload.listening === true;
  if (type === 'command') return false;
  return type.startsWith('task_');
}

const beatSchema = z.object({
  connection_id: z.string().min(1),
  cursor: z.number().int().nonnegative().default(0),
  generation: z.number().int().nullish(),
});
const roomRequestSchema = z.object({
  connection_id: z.string().min(1),
  room_id: z.string().min(1),
  takeover: z.boolean().default(false),
  generation: z.number().int().nullish(),
});
const placementsSchema = z.object({
  connection_id: z.string().min(1),
  placements: z.record(z.string().min(1), z.string().min(1)),
  generation: z.number().int().nullish(),
});

const LOCAL_ROUTE =
  /^\/agents\/([^/]+)\/(events|connection\/(?:beat|placements|subscribe|unsubscribe))$/;
/**
 * The prefixes forwarded to Switch. Anything else, the management routes above
 * all, stays here. `/hosted/...` is a cloud agent's: its provider credential
 * and status, its repository credential and its session operations, never
 * its machine's routes.
 */
const FORWARDED =
  /^\/(agents\/[^/]+\/.+|agent-sessions\/.+|sessions\/.+|hosted\/(?:provider-credential|provider-status|github-credential|operations\/[^/]+\/(?:claim|result))|version|health)$/;
/** `/agents/<segment>/...` routes whose segment is not an agent. */
const AGENTLESS_SEGMENTS = new Set(['rooms', 'feature-flags']);

export class LocalRelay {
  private server: Server | null = null;
  private port = 0;
  private readonly sockets = new Set<Socket>();
  private readonly tokens = new Map<string, string>();
  private readonly tokenOf = new Map<string, string>();
  private readonly agents = new Map<string, AgentState>();
  private readonly connections = new Map<string, LocalConnection>();
  /**
   * Starts anywhere, as Switch's does, so a client still holding an
   * incarnation from before a restart cannot name one this relay issues.
   */
  private incarnation = randomInt(2 ** 31);
  private ready = false;
  private upstream = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  /**
   * Worker frames that arrived for a worker whose attach is still being
   * answered, by `connection:generation`: they are written once its
   * `worker_attached` is.
   */
  private readonly attaching = new Map<string, { event: string; data: unknown }[]>();

  constructor(private readonly deps: RelayDeps) {}

  /** Listens on 127.0.0.1: on `preferredPort` when it is free, so running watchers find it again. */
  async start(preferredPort: number | null): Promise<number> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        this.deps.log.error('The relay failed a request', {
          path: req.url,
          error: errorMessage(error),
        });
        if (!res.headersSent) this.send(res, 500, { detail: errorMessage(error) });
        else res.destroy();
      });
    });
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    const listen = (port: number) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
    try {
      await listen(preferredPort ?? 0);
    } catch (error) {
      if (preferredPort === null || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE')
        throw error;
      this.deps.log.warn(
        'The relay port the agents were given is taken; using a new one. Running agents are restarted to pick it up.',
        { port: preferredPort }
      );
      await listen(0);
    }
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    this.timers = [
      setInterval(() => this.sweep(), this.deps.timing.sweepMs),
      setInterval(() => this.keepalive(), this.deps.timing.keepaliveMs),
    ];
    for (const timer of this.timers) timer.unref();
    return this.port;
  }

  get endpoint(): string {
    if (!this.server) throw new Error('The relay is not listening.');
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Stops serving. Streams are cut without an `evicted` frame: the watchers
   * outlive the controller, and a dropped socket is what tells them to keep
   * retrying until it is back.
   */
  async close(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * Unknown tokens are told to retry (503) until this is called: right after
   * a restart a watcher can reach the relay before the controller has read
   * back its token, and a 401 would stop it for good.
   */
  setReady(): void {
    this.ready = true;
  }

  // -- Agents and tokens ------------------------------------------------------

  /** Accepts `token` for the agent, replacing any token it had. */
  register(agentId: string, token: string): void {
    const previous = this.tokenOf.get(agentId);
    if (previous) this.tokens.delete(previous);
    const hash = hashToken(token);
    this.tokens.set(hash, agentId);
    this.tokenOf.set(agentId, hash);
    this.agent(agentId);
  }

  /** A new token for the agent, replacing any it had. */
  mint(agentId: string): string {
    const token = `${RELAY_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    this.register(agentId, token);
    return token;
  }

  isRegistered(agentId: string, token: string): boolean {
    return this.tokenOf.get(agentId) === hashToken(token);
  }

  /**
   * Forgets what is held for the agent's own stream, keeping its token: its
   * host now runs in the controller's process.
   */
  forgetStreams(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    for (const conn of agent.connections.values()) {
      conn.stream?.res.destroy();
      this.connections.delete(conn.id);
    }
    this.agents.delete(agentId);
    this.deps.onChange();
  }

  /** Forgets the agent: its token stops working and its streams are cut. */
  unregister(agentId: string): void {
    const hash = this.tokenOf.get(agentId);
    if (hash) this.tokens.delete(hash);
    this.tokenOf.delete(agentId);
    const agent = this.agents.get(agentId);
    if (!agent) return;
    for (const conn of agent.connections.values()) {
      conn.stream?.res.destroy();
      this.connections.delete(conn.id);
    }
    this.agents.delete(agentId);
    this.deps.onChange();
  }

  /** Where the controller resumes an agent from, as persisted. */
  setCursor(agentId: string, cursor: number): void {
    const agent = this.agent(agentId);
    agent.confirmed = cursor;
    agent.head = cursor;
    agent.droppedThrough = cursor;
  }

  /** Each agent's confirmed cursor, for the upstream beat and reopen. */
  cursors(): Record<string, number> {
    const cursors: Record<string, number> = {};
    for (const agent of this.agents.values())
      if (agent.confirmed !== null) cursors[agent.agentId] = agent.confirmed;
    return cursors;
  }

  /**
   * For each agent with a session placed in a room by one of its live local
   * connections, those rooms, sorted. Agents with none are left out.
   */
  sessionRooms(): Record<string, string[]> {
    const placements: Record<string, string[]> = {};
    for (const agent of this.agents.values()) {
      const rooms = new Set<string>();
      for (const placed of agent.placements.values()) {
        const owner = this.connections.get(placed.owner);
        if (owner && owner.agentId === agent.agentId && this.alive(owner)) rooms.add(placed.roomId);
      }
      if (rooms.size) placements[agent.agentId] = [...rooms].sort();
    }
    return placements;
  }

  /** The agent's events flow on the controller stream and its watcher is connected here. */
  attached(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent || !this.upstream || !agent.attached) return false;
    return [...agent.connections.values()].some((conn) => conn.stream && this.alive(conn));
  }

  // -- What arrives on the controller stream ----------------------------------

  setUpstream(connected: boolean): void {
    if (!connected) this.endWorkerStreams(null, 'the controller lost its stream to Switch');
    if (this.upstream === connected) return;
    this.upstream = connected;
    this.deps.onChange();
  }

  /**
   * The controller stream (re)attached. Switch attaches every bound agent
   * afresh on each stream, with `agent.attached`, so none counts as attached
   * until it says so again. Workers attached on the stream before it are
   * Switch's no longer, so their streams end and they attach again.
   */
  streamAttached(): void {
    this.endWorkerStreams(null, 'the controller reconnected to Switch');
    for (const agent of this.agents.values()) agent.attached = false;
    this.upstream = true;
    this.deps.onChange();
  }

  /** A frame for a cloud agent's worker: written on its stream as it came. */
  workerFrame(frame: AgentWorkerFrame): void {
    const key = `${frame.connection_id}:${frame.generation}`;
    const waiting = this.attaching.get(key);
    if (waiting) {
      waiting.push({ event: frame.event, data: frame.data });
      return;
    }
    const conn = this.workerConnection(frame);
    if (!conn) {
      this.deps.log.debug('Dropped a worker frame for a worker that is not attached here', {
        agentId: frame.agent_id,
        connectionId: frame.connection_id,
        event: frame.event,
      });
      return;
    }
    this.write(conn, frame.event, frame.data);
  }

  /** Switch ended a worker's attachment: its stream is evicted with Switch's code. */
  workerClosed(frame: AgentWorkerClosedFrame): void {
    const conn = this.workerConnection(frame);
    if (!conn) return;
    conn.worker = false;
    this.deps.log.warn('Switch ended a worker’s attachment', {
      agentId: frame.agent_id,
      code: frame.code,
    });
    this.evict(conn, frame.code, frame.reason);
  }

  private workerConnection(frame: {
    agent_id: string;
    connection_id: string;
    generation: number;
  }): LocalConnection | null {
    const conn = this.connections.get(frame.connection_id);
    if (
      !conn ||
      conn.agentId !== frame.agent_id ||
      conn.generation !== frame.generation ||
      !conn.worker ||
      !conn.stream
    )
      return null;
    return conn;
  }

  /**
   * Ends the worker streams (every agent's, or one agent's): no `evicted`
   * frame, so each worker reconnects and attaches again.
   */
  private endWorkerStreams(agentId: string | null, why: string): void {
    for (const conn of this.connections.values()) {
      if (!conn.worker || (agentId !== null && conn.agentId !== agentId)) continue;
      conn.worker = false;
      const stream = conn.stream;
      if (!stream) continue;
      this.deps.log.info('Ending a worker stream so it attaches again', {
        agentId: conn.agentId,
        why,
      });
      conn.stream = null;
      stream.res.end();
    }
  }

  attach(agentId: string, fromSeq: number, rooms: string[]): void {
    const agent = this.agent(agentId);
    agent.attached = true;
    this.setRooms(agentId, rooms);
    if (agent.head === null) agent.head = fromSeq;
    else if (fromSeq > agent.head) {
      // Switch starts the agent past what the relay holds: whatever lay
      // between is not coming, and a watcher behind it is told so.
      agent.head = fromSeq;
      agent.droppedThrough = Math.max(agent.droppedThrough, fromSeq);
    }
    for (const conn of agent.connections.values())
      if (conn.cursor === null) {
        conn.cursor = agent.head;
        conn.confirmed ??= agent.head;
      }
    this.deps.log.info('Agent attached to the controller stream', { agentId, fromSeq });
    this.pumpAll(agent);
    this.deps.onChange();
  }

  detach(agentId: string, reason: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.attached = false;
    this.endWorkerStreams(agentId, `Switch detached the agent (${reason})`);
    this.deps.log.warn('Agent detached from the controller stream', { agentId, reason });
    this.deps.onChange();
  }

  /** The agent's membership changed: rooms it left stop being covered here. */
  setRooms(agentId: string, rooms: string[]): void {
    const agent = this.agent(agentId);
    agent.rooms = new Set(rooms);
    for (const conn of agent.connections.values()) {
      for (const room of conn.rooms) if (!agent.rooms.has(room)) conn.rooms.delete(room);
      this.pump(conn);
    }
  }

  /**
   * A domain event: buffered for local resume, and written to every stream
   * that covers it. One the relay already has (Switch replays from where the
   * connection opened each time the stream reattaches) is dropped.
   */
  ingest(frame: AgentEventFrame): void {
    const { agent_id: agentId, seq } = frame;
    const data = { ...frame.event, sequence: seq };
    const agent = this.agent(agentId);
    if (agent.head !== null && seq <= agent.head) return;
    agent.buffer.push({
      kind: 'event',
      seq,
      type: data.type,
      roomId: data.room_id,
      notifiable: isNotifiable(data.type, data.payload),
      data,
    });
    for (const conn of agent.connections.values())
      if (conn.cursor === null) {
        conn.cursor = seq - 1;
        conn.confirmed ??= seq - 1;
      }
    agent.head = seq;
    this.pumpAll(agent);
    this.trim(agent);
  }

  /**
   * Switch could not serve the agent's cursor. A reset (Switch restarted, so
   * its numbering went back: `all_rooms`, resuming below what the relay
   * holds) clears what is held and goes to every stream now. A gap resuming
   * past what the relay holds takes its place in the buffer, so each stream
   * meets it in order. One resuming at or below it describes events the relay
   * already has — a reattached stream starting from where the connection
   * opened — and is not passed on.
   */
  gap(frame: AgentGapFrame): void {
    const { agent_id: agentId, ...data } = frame;
    const agent = this.agent(agentId);
    const resumedAt = data.resumed_at;
    if (resumedAt === undefined) {
      for (const conn of agent.connections.values()) this.write(conn, 'gap', data);
      return;
    }
    if (agent.head !== null && resumedAt <= agent.head && data.all_rooms !== true) {
      this.deps.log.debug('Dropped a gap behind what the relay already holds', {
        agentId,
        resumedAt,
        head: agent.head,
      });
      return;
    }
    if (agent.head !== null && resumedAt < agent.head) {
      agent.buffer = [];
      agent.head = resumedAt;
      agent.droppedThrough = resumedAt;
      agent.reset = { reason: data.reason, rooms: data.rooms ?? [] };
      agent.confirmed = resumedAt;
      this.deps.onCursor(agentId, resumedAt);
      for (const conn of agent.connections.values()) {
        if (conn.confirmed !== null) conn.confirmed = Math.min(conn.confirmed, resumedAt);
        if (!conn.stream) continue;
        this.write(conn, 'gap', data);
        conn.cursor = resumedAt;
      }
      return;
    }
    agent.buffer.push({ kind: 'gap', seq: resumedAt, data });
    agent.head = resumedAt;
    this.pumpAll(agent);
    this.trim(agent);
  }

  /** A room control, for the session placed in its room. */
  sessionCommand(frame: AgentSessionCommandFrame): void {
    const { agent_id: agentId, command } = frame;
    const origin = command.origin as { roomId?: unknown } | undefined;
    const roomId = frame.room_id ?? (typeof origin?.roomId === 'string' ? origin.roomId : null);
    const agent = this.agents.get(agentId);
    const sessionId = agent && roomId ? this.sessionIn(agent, roomId) : null;
    if (!agent || !sessionId) {
      this.deps.log.warn(
        'Dropped a room control: no session of the agent is placed in its room here',
        { agentId, roomId, commandId: command.commandId }
      );
      return;
    }
    const watchers = this.watchers(agent, SESSION_COMMAND_PROTOCOL_REVISION);
    if (!watchers.length) {
      this.deps.log.warn('Dropped a room control: the agent has no watcher connected', {
        agentId,
        roomId,
        commandId: command.commandId,
      });
      return;
    }
    for (const conn of watchers) this.write(conn, 'session_command', { ...command, sessionId });
  }

  approvalOutcome(frame: AgentApprovalOutcomeFrame): void {
    const { agent_id: agentId, outcome } = frame;
    const agent = this.agents.get(agentId);
    const watchers = agent ? this.watchers(agent, APPROVAL_OUTCOME_PROTOCOL_REVISION) : [];
    if (!watchers.length) {
      this.deps.log.warn(
        'An approval outcome arrived while the agent has no watcher connected; Switch sends it again until it is delivered',
        { agentId, requestId: outcome.request_id }
      );
      return;
    }
    for (const conn of watchers) this.write(conn, 'approval_outcome', outcome);
  }

  // -- HTTP -------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url ?? '';
    if (!raw.startsWith('/') || raw.startsWith('//'))
      return this.send(res, 400, { detail: 'The relay serves origin-form paths only.' });
    const url = new URL(raw, 'http://relay.invalid');
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const agentId = token ? this.tokens.get(hashToken(token)) : undefined;
    if (!agentId) {
      if (!this.ready)
        return this.send(res, 503, {
          detail: 'The agents controller is starting; retry in a moment.',
        });
      return this.send(res, 401, {
        detail:
          'This token is not one the agents controller issued, or its agent is no longer assigned to this machine.',
      });
    }
    try {
      const local = LOCAL_ROUTE.exec(url.pathname);
      if (local) {
        const named = decodeURIComponent(local[1]!);
        if (named !== agentId)
          throw new HttpRefusal(403, `authenticated as agent ${agentId}, not ${named}`);
        return await this.handleLocal(req, res, agentId, local[2]!, url);
      }
      this.checkForwardable(url, raw, agentId);
      await this.deps.forwarder.forward(req, res, {
        agentId,
        roomId: this.roomFor(agentId, req),
        path: `${url.pathname}${url.search}`,
      });
    } catch (error) {
      if (error instanceof RawRefusal) return this.sendRaw(res, error.status, error.body);
      if (!(error instanceof HttpRefusal)) throw error;
      this.send(res, error.status, { detail: error.detail });
    }
  }

  private checkForwardable(url: URL, raw: string, agentId: string): void {
    const rawPath = raw.split('?')[0]!;
    if (/%2f|%5c/i.test(rawPath) || !FORWARDED.test(url.pathname))
      throw new HttpRefusal(404, `The agents controller does not relay ${url.pathname}.`);
    const segment = /^\/agents\/([^/]+)\//.exec(url.pathname)?.[1];
    if (segment === undefined) return;
    const named = decodeURIComponent(segment);
    if (named !== agentId && !AGENTLESS_SEGMENTS.has(named))
      throw new HttpRefusal(403, `authenticated as agent ${agentId}, not ${named}`);
  }

  private async handleLocal(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: string,
    route: string,
    url: URL
  ): Promise<void> {
    if (route === 'events') {
      if (req.method !== 'GET') throw new HttpRefusal(405, 'Method Not Allowed');
      if (!(req.headers.accept ?? '').includes('text/event-stream'))
        throw new HttpRefusal(
          406,
          'The agents controller relays the event stream only; ask for text/event-stream.'
        );
      return await this.openStream(req, res, agentId, url);
    }
    if (req.method !== 'POST') throw new HttpRefusal(405, 'Method Not Allowed');
    const body = await readJson(req);
    switch (route) {
      case 'connection/beat':
        return this.send(res, 200, this.beat(agentId, parse(beatSchema, body)));
      case 'connection/placements':
        return this.send(res, 200, this.placements(agentId, parse(placementsSchema, body)));
      case 'connection/subscribe':
        return this.send(res, 200, this.subscribe(agentId, parse(roomRequestSchema, body)));
      case 'connection/unsubscribe':
        return this.send(res, 200, this.unsubscribe(agentId, parse(roomRequestSchema, body)));
      default:
        throw new HttpRefusal(404, 'Not Found');
    }
  }

  private async openStream(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: string,
    url: URL
  ): Promise<void> {
    const query = url.searchParams;
    const connectionId = query.get('connection_id');
    if (!connectionId)
      throw new HttpRefusal(
        400,
        'connection_id is required to open an event stream; generate a UUID and reuse it when reconnecting so the connection survives the drop'
      );
    const scope = query.get('scope') ?? 'single';
    if (scope !== 'single' && scope !== 'all')
      throw new HttpRefusal(400, `scope must be 'single' or 'all', got '${scope}'`);
    const filter = query.get('filter') ?? 'all';
    if (filter !== 'all' && filter !== 'addressed')
      throw new HttpRefusal(400, `filter must be 'all' or 'addressed', got '${filter}'`);
    const agent = this.agent(agentId);
    const lastEventId = req.headers['last-event-id'];
    const rawCursor =
      (typeof lastEventId === 'string' && lastEventId) || query.get('start_from') || 'head';
    let cursor: number | null;
    if (rawCursor === 'head') cursor = agent.head;
    else {
      cursor = Number(rawCursor);
      if (!Number.isSafeInteger(cursor))
        throw new HttpRefusal(
          400,
          `start_from must be 'head' or a sequence number, got '${rawCursor}'`
        );
      cursor = Math.max(cursor, 0);
    }
    const declaration = declarationOf(query);
    if (
      declaration.speaks !== null &&
      declaration.accepts !== null &&
      !(
        declaration.accepts <= RELAY_AGENT_PROTOCOL.speaks &&
        RELAY_AGENT_PROTOCOL.accepts <= declaration.speaks
      )
    )
      throw new HttpRefusal(409, {
        message: `agent-protocol ${declaration.accepts}-${declaration.speaks} does not overlap the ${RELAY_AGENT_PROTOCOL.accepts}-${RELAY_AGENT_PROTOCOL.speaks} the agents controller serves`,
        contract: 'agent-protocol',
        server: { version: null, ...RELAY_AGENT_PROTOCOL },
        client: { speaks: declaration.speaks, accepts: declaration.accepts },
        remedy: 'Update the agents controller, or the agent runtime, so their ranges overlap.',
      });
    const expectedRaw = query.get('expected_generation');
    const expected = expectedRaw === null ? null : Number(expectedRaw);
    const spawnCapable = query.get('spawn_capable') === 'true';

    const capability = header(req, 'x-switch-worker-capability');
    const generation = ++this.incarnation;
    let attached: Record<string, unknown> | null = null;
    if (capability !== null) {
      const known = this.connections.get(connectionId);
      if (known && known.agentId !== agentId)
        throw new HttpRefusal(409, notOpen(connectionId).detail);
      if (known && expected !== null && expected !== known.generation)
        throw coded(
          409,
          'taken_over',
          `connection ${connectionId} has been reopened since incarnation ${expected} and is now at ${known.generation}; another client holds it, so this reattach was refused and the connection was left untouched`
        );
      attached = await this.admitWorker(agentId, {
        connection_id: connectionId,
        generation,
        spawn_capable: spawnCapable,
        protocol: declaration.speaks,
        protocol_accepts: declaration.accepts,
        capability,
        boot_id: header(req, 'x-switch-host-boot-id'),
        instance_id: header(req, 'x-switch-host-instance-id'),
        state_version: integerHeader(req, 'x-switch-worker-state-version'),
      });
    }
    const owed = this.attaching.get(`${connectionId}:${generation}`) ?? [];
    this.attaching.delete(`${connectionId}:${generation}`);
    try {
      this.commitStream(req, res, agentId, url, {
        connectionId,
        scope,
        filter,
        cursor,
        declaration,
        expected,
        spawnCapable,
        generation,
        attached,
        owed,
      });
    } catch (error) {
      // Core holds the worker this open attached; the stream never opened.
      if (attached !== null) this.deps.workers.detach(agentId, { connectionId, generation });
      throw error;
    }
  }

  private commitStream(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: string,
    url: URL,
    open: {
      connectionId: string;
      scope: 'single' | 'all';
      filter: 'all' | 'addressed';
      cursor: number | null;
      declaration: Declaration;
      expected: number | null;
      spawnCapable: boolean;
      generation: number;
      attached: Record<string, unknown> | null;
      owed: { event: string; data: unknown }[];
    }
  ): void {
    const { connectionId, scope, filter, cursor, declaration, expected, spawnCapable } = open;
    const { generation, attached, owed } = open;
    const query = url.searchParams;
    const agent = this.agent(agentId);
    let conn = this.connections.get(connectionId);
    if (conn && conn.agentId !== agentId) throw new HttpRefusal(409, notOpen(connectionId).detail);
    if (conn && !this.alive(conn)) {
      this.closeConnection(conn, null);
      conn = undefined;
    }
    if (conn) {
      if (expected !== null && expected !== conn.generation)
        throw coded(
          409,
          'taken_over',
          `connection ${connectionId} has been reopened since incarnation ${expected} and is now at ${conn.generation}; another client holds it, so this reattach was refused and the connection was left untouched`
        );
      if (conn.stream)
        this.evict(
          conn,
          'taken_over',
          'another stream attached to this connection and took it over'
        );
    } else {
      if (agent.connections.size >= MAX_CONNECTIONS_PER_AGENT)
        throw new HttpRefusal(
          409,
          `agent ${agentId} already holds ${MAX_CONNECTIONS_PER_AGENT} connections; close one before opening another`
        );
      conn = {
        id: connectionId,
        agentId,
        scope,
        filter,
        spawnCapable: false,
        cursor: null,
        confirmed: null,
        generation: 0,
        lastBeat: 0,
        stream: null,
        rooms: new Set(),
        released: new Map(),
        declaration,
        worker: false,
      };
      this.connections.set(connectionId, conn);
      agent.connections.set(connectionId, conn);
    }
    conn.scope = scope;
    conn.filter = filter;
    conn.spawnCapable = spawnCapable;
    conn.declaration = declaration;
    conn.cursor = cursor;
    conn.confirmed = cursor;
    conn.lastBeat = this.deps.now();
    conn.generation = generation;
    conn.worker = attached !== null;

    for (const roomId of (query.get('rooms') ?? '').split(',').filter(Boolean)) {
      if (agent.rooms && !agent.rooms.has(roomId)) {
        this.closeConnection(conn, null);
        throw new HttpRefusal(403, `agent ${agentId} is not a member of room ${roomId}`);
      }
      this.claim(conn, roomId, true);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const stream: LocalStream = { res, generation: conn.generation, told: new Set(conn.rooms) };
    conn.stream = stream;
    const owner = conn;
    res.on('close', () => {
      if (attached !== null)
        this.deps.workers.detach(agentId, { connectionId, generation: stream.generation });
      if (owner.stream === stream) {
        owner.stream = null;
        owner.worker = false;
        this.deps.onChange();
      }
    });
    this.write(conn, 'connection_state', {
      connection_id: conn.id,
      agent_id: agentId,
      generation: conn.generation,
      scope: conn.scope,
      filter: conn.filter,
      spawn_capable: conn.spawnCapable,
      rooms: [...conn.rooms].sort(),
      cursor: conn.cursor ?? 0,
      protocol: RELAY_AGENT_PROTOCOL.speaks,
      heartbeat_interval_seconds: this.deps.timing.heartbeatIntervalS,
      server: {
        version: null,
        contracts: { 'agent-protocol': { ...RELAY_AGENT_PROTOCOL } },
        relay: { artifact: 'switch-agent-controller', version: this.deps.version },
      },
      client: declaration,
    });
    if (attached !== null) {
      this.write(conn, 'worker_attached', attached);
      for (const frame of owed) this.write(conn, frame.event, frame.data);
    }
    if (agent.reset && conn.cursor !== null && agent.head !== null && conn.cursor > agent.head) {
      this.write(conn, 'gap', {
        from_sequence: agent.head,
        resumed_at: agent.head,
        rooms: [...conn.rooms].sort(),
        all_rooms: true,
        reason: agent.reset.reason,
      });
      conn.cursor = agent.head;
      conn.confirmed = agent.head;
    }
    this.pump(conn);
    this.deps.onChange();
  }

  /**
   * Has Core admit the worker before its stream opens. A refusal of the
   * worker itself goes back as Core sent it, so the worker acts on Core's
   * code exactly as it would on its own stream; anything else (no
   * controller stream, the agent not bound here yet) is a 503 it retries.
   */
  private async admitWorker(
    agentId: string,
    worker: WorkerIdentity
  ): Promise<Record<string, unknown>> {
    if (!this.upstream)
      throw new HttpRefusal(
        503,
        'The agents controller is not connected to Switch; retry in a moment.'
      );
    const key = `${worker.connection_id}:${worker.generation}`;
    this.attaching.set(key, []);
    let result: WorkerAttachResult;
    try {
      result = await this.deps.workers.attach(agentId, worker);
    } catch (error) {
      this.attaching.delete(key);
      throw new HttpRefusal(
        503,
        `The agents controller could not attach this worker: ${errorMessage(error)}; retry in a moment.`
      );
    }
    if (result.ok) return result.attached;
    this.attaching.delete(key);
    if (result.kind === 'worker') throw new RawRefusal(result.status, result.body);
    if (result.kind === 'controller')
      this.deps.log.warn('Switch would not attach a worker on this controller', {
        agentId,
        code: result.code,
      });
    throw new HttpRefusal(
      503,
      `${result.message}; the agents controller retries once it can attach this worker.`
    );
  }

  private beat(
    agentId: string,
    body: z.infer<typeof beatSchema>
  ): { ok: true; rooms: string[]; cursor: number } {
    const conn = this.live(agentId, body.connection_id);
    this.fence(conn, body.generation ?? null, 'heartbeat');
    if (!conn.stream)
      throw coded(
        409,
        'no_stream',
        `connection ${conn.id} has no stream attached; reopen the event stream`
      );
    conn.lastBeat = this.deps.now();
    const agent = this.agent(agentId);
    const cursor = agent.head === null ? body.cursor : Math.min(body.cursor, agent.head);
    if (conn.cursor !== null && cursor > conn.cursor) conn.cursor = cursor;
    if (conn.confirmed !== null && cursor > conn.confirmed) conn.confirmed = cursor;
    this.confirm(agent);
    this.trim(agent);
    return { ok: true, rooms: [...conn.rooms].sort(), cursor: conn.cursor ?? cursor };
  }

  private placements(agentId: string, body: z.infer<typeof placementsSchema>) {
    const conn = this.current(agentId, body.connection_id, body.generation ?? null);
    const agent = this.agent(agentId);
    const rooms = Object.values(body.placements);
    for (const roomId of new Set(rooms))
      if (agent.rooms && !agent.rooms.has(roomId))
        throw new HttpRefusal(403, `agent ${agentId} is not a member of room ${roomId}`);
    const twice = [...new Set(rooms.filter((room, index) => rooms.indexOf(room) !== index))];
    if (twice.length)
      throw new HttpRefusal(
        400,
        `placements name room(s) ${twice.sort().join(', ')} for more than one session; one session of an agent acts in a room`
      );
    const released: { connection_id: string; room_id: string; session_id: string | null }[] = [];
    const previousRooms = new Set<string>();
    for (const [sessionId, placed] of agent.placements)
      if (placed.owner === conn.id) {
        previousRooms.add(placed.roomId);
        agent.placements.delete(sessionId);
      }
    for (const [sessionId, roomId] of Object.entries(body.placements)) {
      agent.placements.delete(sessionId);
      for (const [other, placed] of agent.placements) {
        if (placed.roomId !== roomId) continue;
        agent.placements.delete(other);
        const loser = this.connections.get(placed.owner);
        if (loser && loser !== conn && loser.agentId === agentId) {
          this.notifyReleased(loser, roomId, other);
          released.push({ connection_id: loser.id, room_id: roomId, session_id: other });
        }
      }
      agent.placements.set(sessionId, { roomId, owner: conn.id });
    }
    for (const roomId of new Set(rooms)) {
      const evicted = this.claim(conn, roomId, true);
      if (evicted && !released.some((r) => r.connection_id === evicted.id && r.room_id === roomId))
        released.push({ connection_id: evicted.id, room_id: roomId, session_id: null });
    }
    for (const roomId of previousRooms) if (!rooms.includes(roomId)) conn.rooms.delete(roomId);
    for (const other of agent.connections.values()) this.pump(other);
    return {
      ok: true,
      placements: this.connectionPlacements(conn),
      rooms: [...conn.rooms].sort(),
      released,
    };
  }

  private subscribe(agentId: string, body: z.infer<typeof roomRequestSchema>) {
    const conn = this.current(agentId, body.connection_id, body.generation ?? null);
    const agent = this.agent(agentId);
    if (agent.rooms && !agent.rooms.has(body.room_id))
      throw new HttpRefusal(403, `agent ${agentId} is not a member of room ${body.room_id}`);
    const departing =
      conn.scope === 'single' ? [...conn.rooms].filter((r) => r !== body.room_id) : [];
    const evicted = this.claim(conn, body.room_id, body.takeover);
    for (const roomId of departing) conn.rooms.delete(roomId);
    for (const other of agent.connections.values()) this.pump(other);
    return {
      ok: true,
      rooms: [...conn.rooms].sort(),
      evicted_connection_id: evicted?.id ?? null,
      warning: evicted
        ? `Room ${body.room_id} was being attended by connection ${evicted.id} of this agent. That connection no longer receives the room's messages; this one does.`
        : null,
    };
  }

  private unsubscribe(agentId: string, body: z.infer<typeof roomRequestSchema>) {
    const conn = this.current(agentId, body.connection_id, body.generation ?? null);
    conn.rooms.delete(body.room_id);
    for (const other of this.agent(agentId).connections.values()) this.pump(other);
    return { ok: true, rooms: [...conn.rooms].sort() };
  }

  // -- Connections ------------------------------------------------------------

  private agent(agentId: string): AgentState {
    let agent = this.agents.get(agentId);
    if (!agent) {
      agent = {
        agentId,
        attached: false,
        rooms: null,
        head: null,
        droppedThrough: 0,
        confirmed: null,
        buffer: [],
        reset: null,
        connections: new Map(),
        placements: new Map(),
        overflowing: false,
      };
      this.agents.set(agentId, agent);
    }
    return agent;
  }

  private alive(conn: LocalConnection): boolean {
    return this.deps.now() - conn.lastBeat < this.deps.timing.heartbeatTtlMs;
  }

  /** The agent's open connection by id, or the 404 Switch answers for one that is not. */
  private live(agentId: string, connectionId: string): LocalConnection {
    const conn = this.connections.get(connectionId);
    if (!conn || conn.agentId !== agentId) throw notOpen(connectionId);
    if (!this.alive(conn)) {
      this.closeConnection(conn, 'heartbeat_lapsed');
      throw notOpen(connectionId);
    }
    return conn;
  }

  /** Refuses a request from a client that is not, or cannot show it is, the connection's holder. */
  private fence(conn: LocalConnection, generation: number | null, what: string): void {
    if (generation === null) {
      if ((conn.declaration.speaks ?? 0) >= FENCED_PROTOCOL_REVISION)
        throw coded(
          409,
          'unfenced',
          `connection ${conn.id} is held by a client speaking agent-protocol ${conn.declaration.speaks}, which names the connection incarnation on every ${what}; this one named none`
        );
      return;
    }
    if (generation !== conn.generation)
      throw coded(
        409,
        'taken_over',
        `connection ${conn.id} was reopened since incarnation ${generation} and is now at ${conn.generation}; another client holds it, so this ${what} was refused`
      );
  }

  private current(agentId: string, connectionId: string, generation: number | null) {
    const conn = this.live(agentId, connectionId);
    this.fence(conn, generation, 'room request');
    return conn;
  }

  /** Takes a room for `conn`, from whichever sibling held it. Returns that sibling. */
  private claim(conn: LocalConnection, roomId: string, takeover: boolean): LocalConnection | null {
    const agent = this.agent(conn.agentId);
    let evicted: LocalConnection | null = null;
    for (const sibling of agent.connections.values()) {
      if (sibling === conn || !sibling.rooms.has(roomId) || !this.alive(sibling)) continue;
      if (!takeover)
        throw new HttpRefusal(
          409,
          `room ${roomId} is already held by connection ${sibling.id} for this agent; close it or pass takeover`
        );
      sibling.rooms.delete(roomId);
      this.notifyReleased(sibling, roomId, this.placedBy(agent, sibling, roomId));
      evicted = sibling;
    }
    conn.released.delete(roomId);
    conn.rooms.add(roomId);
    return evicted;
  }

  private notifyReleased(conn: LocalConnection, roomId: string, sessionId: string | null): void {
    if ((conn.declaration.speaks ?? 0) < ROOM_RELEASED_PROTOCOL_REVISION) return;
    if (sessionId !== null || !conn.released.has(roomId)) conn.released.set(roomId, sessionId);
  }

  private placedBy(agent: AgentState, conn: LocalConnection, roomId: string): string | null {
    for (const [sessionId, placed] of agent.placements)
      if (placed.roomId === roomId && placed.owner === conn.id) return sessionId;
    return null;
  }

  private connectionPlacements(conn: LocalConnection): Record<string, string> {
    const placements: Record<string, string> = {};
    for (const [sessionId, placed] of this.agent(conn.agentId).placements)
      if (placed.owner === conn.id) placements[sessionId] = placed.roomId;
    return placements;
  }

  private sessionIn(agent: AgentState, roomId: string): string | null {
    for (const [sessionId, placed] of agent.placements)
      if (placed.roomId === roomId) return sessionId;
    return null;
  }

  /**
   * The room a forwarded call is made in: the calling session's placement when
   * the call names a session, otherwise the single room of the connection it
   * names. Null when neither says, and Switch answers as it does for a caller
   * bound to no room.
   */
  roomFor(agentId: string, req: Pick<IncomingMessage, 'headers'>): string | null {
    const agent = this.agents.get(agentId);
    const sessionId = header(req, 'x-switch-session-id');
    if (!agent || agent.connections.size === 0) return this.deps.sharedRoomFor(agentId, sessionId);
    if (sessionId) return agent.placements.get(sessionId)?.roomId ?? null;
    const connectionId = header(req, 'x-switch-connection-id');
    const conn = connectionId ? agent.connections.get(connectionId) : undefined;
    if (conn && conn.rooms.size === 1) return [...conn.rooms][0]!;
    return null;
  }

  private covers(conn: LocalConnection, roomId: string): boolean {
    if (conn.rooms.has(roomId)) return true;
    if (conn.scope === 'single') return false;
    for (const sibling of this.agent(conn.agentId).connections.values())
      if (sibling !== conn && sibling.rooms.has(roomId) && this.alive(sibling)) return false;
    return true;
  }

  /** The scope-`all` connections with a stream that take frames of this revision. */
  private watchers(agent: AgentState, revision: number): LocalConnection[] {
    return [...agent.connections.values()].filter(
      (conn) =>
        conn.scope === 'all' &&
        conn.stream !== null &&
        this.alive(conn) &&
        (conn.declaration.speaks ?? 0) >= revision
    );
  }

  /** The lowest cursor any live connection has confirmed, never moving back. */
  private confirm(agent: AgentState): void {
    const confirmed = [...agent.connections.values()]
      .filter((conn) => conn.confirmed !== null && this.alive(conn))
      .map((conn) => conn.confirmed!);
    if (!confirmed.length) return;
    const lowest = Math.min(...confirmed);
    if (agent.confirmed !== null && lowest <= agent.confirmed) return;
    agent.confirmed = lowest;
    this.deps.onCursor(agent.agentId, lowest);
  }

  /** Drops what every live connection has confirmed, and the oldest past the limit. */
  private trim(agent: AgentState): void {
    const confirmed = [...agent.connections.values()]
      .filter((conn) => this.alive(conn))
      .map((conn) => conn.confirmed ?? -1);
    const floor = confirmed.length ? Math.min(...confirmed) : -1;
    let drop = 0;
    while (drop < agent.buffer.length && agent.buffer[drop]!.seq <= floor) drop++;
    let overflow = false;
    if (agent.buffer.length - drop > this.deps.bufferLimit) {
      drop = agent.buffer.length - this.deps.bufferLimit;
      overflow = true;
    }
    if (drop > 0) {
      agent.droppedThrough = Math.max(agent.droppedThrough, agent.buffer[drop - 1]!.seq);
      agent.buffer.splice(0, drop);
    }
    if (overflow && !agent.overflowing)
      this.deps.log.warn(
        'The relay is holding more events than it keeps for an agent whose watcher is not reading; the oldest are dropped, and the watcher is told when it reconnects',
        { agentId: agent.agentId, limit: this.deps.bufferLimit }
      );
    agent.overflowing = overflow;
  }

  // -- Writing ----------------------------------------------------------------

  private write(conn: LocalConnection, event: string, data: unknown, id?: number): void {
    const stream = conn.stream;
    if (!stream) return;
    const lines = id === undefined ? '' : `id: ${id}\n`;
    stream.res.write(`${lines}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private pumpAll(agent: AgentState): void {
    for (const conn of agent.connections.values()) this.pump(conn);
  }

  /** Writes what the connection is owed: room changes, then every event past its cursor. */
  private pump(conn: LocalConnection): void {
    const stream = conn.stream;
    if (!stream) return;
    for (const [roomId, sessionId] of conn.released)
      this.write(conn, 'room_released', { room_id: roomId, session_id: sessionId });
    conn.released.clear();
    if (conn.rooms.size !== stream.told.size || [...conn.rooms].some((r) => !stream.told.has(r))) {
      stream.told = new Set(conn.rooms);
      this.write(conn, 'subscription_changed', {
        rooms: [...conn.rooms].sort(),
        reason: 'subscription updated',
      });
    }
    // A session connection with no room yet must not read: it would skip,
    // and so lose, every event before the room it is about to claim.
    if (conn.cursor === null || (conn.scope === 'single' && conn.rooms.size === 0)) return;
    const agent = this.agent(conn.agentId);
    if (conn.cursor < agent.droppedThrough) {
      this.write(conn, 'gap', {
        from_sequence: conn.cursor,
        resumed_at: agent.droppedThrough,
        rooms: [...conn.rooms].sort(),
        all_rooms: true,
        reason: 'the agents controller no longer holds events this far back; re-read room context',
      });
      conn.cursor = agent.droppedThrough;
    }
    for (let index = firstAfter(agent.buffer, conn.cursor); index < agent.buffer.length; index++) {
      const item = agent.buffer[index]!;
      if (item.kind === 'gap')
        this.write(conn, 'gap', { ...item.data, from_sequence: conn.cursor });
      else if (this.covers(conn, item.roomId) && (conn.filter === 'all' || item.notifiable))
        this.write(conn, item.type, item.data, item.seq);
      conn.cursor = item.seq;
    }
  }

  private evict(conn: LocalConnection, code: string, reason: string): void {
    const stream = conn.stream;
    if (!stream) return;
    this.write(conn, 'evicted', { code, reason, room_id: null });
    conn.stream = null;
    stream.res.end();
  }

  /** Ends a connection; with a code, its open stream is told why first. */
  private closeConnection(conn: LocalConnection, code: 'heartbeat_lapsed' | null): void {
    conn.worker = false;
    if (code)
      this.evict(conn, code, 'heartbeat lapsed; reopen the stream and resume from your cursor');
    else conn.stream?.res.end();
    conn.stream = null;
    this.connections.delete(conn.id);
    this.agents.get(conn.agentId)?.connections.delete(conn.id);
    this.deps.onChange();
  }

  private sweep(): void {
    for (const conn of [...this.connections.values()])
      if (!this.alive(conn)) {
        this.deps.log.debug('Closing a local connection whose heartbeat lapsed', {
          agentId: conn.agentId,
          connectionId: conn.id,
        });
        this.closeConnection(conn, 'heartbeat_lapsed');
      }
  }

  private keepalive(): void {
    for (const conn of this.connections.values()) conn.stream?.res.write(': keepalive\n\n');
  }

  private sendRaw(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }
}

function header(req: Pick<IncomingMessage, 'headers'>, name: string): string | null {
  const value = req.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  return text ? text : null;
}

function integerHeader(req: Pick<IncomingMessage, 'headers'>, name: string): number | null {
  const text = header(req, name);
  if (text === null) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function declarationOf(query: URLSearchParams): Declaration {
  const integer = (name: string) => {
    const raw = query.get(name);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  };
  const speaks = integer('protocol');
  return {
    speaks,
    accepts: integer('protocol_accepts') ?? speaks,
    artifact: query.get('client'),
    version: query.get('client_version'),
  };
}

/** The index of the first buffered item past `cursor`. */
function firstAfter(buffer: Buffered[], cursor: number): number {
  let low = 0;
  let high = buffer.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (buffer[middle]!.seq <= cursor) low = middle + 1;
    else high = middle;
  }
  return low;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BODY_BYTES) throw new HttpRefusal(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpRefusal(400, 'The request body is not JSON.');
  }
}

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new HttpRefusal(
      422,
      result.error.issues.map((issue) => ({
        loc: ['body', ...issue.path.map(String)],
        msg: issue.message,
      }))
    );
  return result.data;
}

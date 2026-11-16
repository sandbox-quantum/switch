import type {
  AgentBridgeEvent,
  ApprovalOutcome,
  SessionCommand,
} from '@sandboxaq/switch-agent-runtime-box';
import type { AgentEventStream, AgentStreamDeps } from '@switch-console/agent-providers-box';
import { errorCode, errorMessage, type Logger } from './log';
import type {
  AgentApprovalOutcomeFrame,
  AgentEventFrame,
  AgentGapFrame,
  AgentSessionCommandFrame,
} from './schemas';

/**
 * Hands each managed agent's events from the controller stream to its agent host,
 * which runs in this process, and keeps what the controller tells Switch for
 * it: how far the agent host has got (its confirmed cursor) and which room each of
 * its sessions works in (its placements).
 *
 * Every agent's events arrive on the one controller stream, whether or not its
 * host is running. They are held here until the agent host takes them, up to
 * `bufferLimit`; the cursor moves only once the agent host has taken an event, so
 * a controller that restarts resumes each agent from what its agent host really
 * had.
 */

export type AgentHubDeps = {
  log: Logger;
  /** An agent's confirmed cursor moved; the controller persists it and beats it upstream. */
  onCursor: (agentId: string, cursor: number) => void;
  /** Something `attached()` reads changed. */
  onChange: () => void;
  /** The most events held per agent while its agent host is not taking them; past it the oldest go, and it is told. */
  bufferLimit: number;
  /**
   * Something arrived that a suspended agent (`setSuspended`) must start its
   * agent host for: an addressed event or a room control. Called once per
   * arrival while it stays suspended; the caller decides what to start.
   */
  onWake?: (agentId: string, why: WakeReason) => void;
  /**
   * A room control kept for a suspended agent will not reach an agent host
   * after all: kept too long, past the limit, or dropped because the agent
   * was stopped, removed, or could not be started. One a newer of its kind
   * replaced is not dropped: the newer runs. For the room to be told (the
   * "couldn't reset" line), rather than hear nothing.
   */
  onHeldCommandDropped?: (agentId: string, roomId: string, command: SessionCommand) => void;
  /** The agent's agent host took an addressed event (its handler resolved). */
  onAddressedTaken?: (agentId: string, event: AgentBridgeEvent) => void;
  now?: () => number;
  /**
   * Has Switch tell the room, as the agent, that its `!reset` could not be
   * done. For a reset Switch left the box to announce (`roomTold:
   * false`) that no session here can take.
   */
  resetRefused?: (
    agentId: string,
    notice: { roomId: string; threadId: string | null; commandId: string }
  ) => Promise<unknown>;
};

export type WakeReason = 'event' | 'room_control';

/** The most room controls kept for a suspended agent until its agent host is back. */
export const HELD_COMMAND_LIMIT = 20;
/**
 * How long a room control is kept for a suspended agent: past it, it is
 * dropped rather than run on a start long after.
 */
export const HELD_COMMAND_MAX_AGE_MS = 10 * 60_000;
/** The longest `hold` waits for the event being handed over before it gives up. */
export const HOLD_TIMEOUT_MS = 30_000;

/** A room control kept for a suspended agent: the latest of each kind per room. */
type HeldCommand = { command: SessionCommand; key: string; at: number };

type Buffered =
  | { kind: 'event'; seq: number; notifiable: boolean; data: AgentBridgeEvent }
  | { kind: 'gap'; seq: number; data: GapData };

type GapData = {
  from_sequence: number;
  resumed_at?: number;
  rooms?: string[];
  all_rooms?: boolean;
  reason: string;
};

/** The agent host, as the stream it opened. */
type AgentHostLink = {
  deps: AgentStreamDeps;
  started: boolean;
  /** The last sequence handed to the agent host (or skipped); null until the agent's head is known. */
  cursor: number | null;
  connected: boolean;
  delivering: boolean;
  /** The pump's run while `delivering`, for `hold` to wait out. */
  pumping: Promise<void> | null;
  closed: boolean;
};

type AgentState = {
  agentId: string;
  /** Core attached the agent to the controller stream. */
  attached: boolean;
  /** The rooms the agent belongs to, as Core last said; null before it has. */
  rooms: Set<string> | null;
  /** The highest sequence known for this agent. */
  head: number | null;
  /**
   * Where Switch first attached the agent to this controller. An agent host
   * that starts with no cursor of its own (a new agent's first run) starts
   * here, so what addressed the agent while its host was coming up (a
   * template's kickoff, posted the moment the agent exists) is not skipped.
   */
  attachedFrom: number | null;
  /** An agent host has started for it since the controller started. */
  hostStarted: boolean;
  /** At or below this, nothing is held: an agent host starting there is told of a gap. */
  droppedThrough: number;
  /** The cursor the controller resumes the agent from upstream. */
  confirmed: number | null;
  buffer: Buffered[];
  /** Core reset the agent's numbering (it restarted). */
  /**
   * Core reset the agent's numbering (it restarted), resuming at `resumedAt`.
   * `owed` while no agent host has been told: one that starts later holds a
   * cursor from the old numbering, so it is told and starts at `resumedAt`.
   */
  reset: { reason: string; rooms: string[]; resumedAt: number; owed: boolean } | null;
  /** Each of its sessions' room, as its agent host last stated. */
  placements: Map<string, string>;
  /** Rooms its agent host placed a session in that it is not in, each said once. */
  refusedRooms: Set<string>;
  host: AgentHostLink | null;
  overflowing: boolean;
  /** Where the last agent host to close had got to; null before one has. */
  lastHostCursor: number | null;
  /**
   * Its agent host was stopped on purpose until something needs it (a
   * resting agent, or one the memory guard stopped): what it must start
   * for calls `onWake`, and the hub takes what no agent host would be handed.
   */
  suspended: boolean;
  /**
   * While suspended: how far the hub has taken events for it, past what
   * the last agent host reached, over the unaddressed ones no agent host is
   * handed. The next agent host starts here at the earliest. Null when not
   * suspended since its last agent host started.
   */
  idleCursor: number | null;
  /** The hub hands its agent host nothing more until released (`hold`). */
  holding: boolean;
  /** Room controls that arrived while it was suspended, for its next agent host. */
  heldCommands: HeldCommand[];
  /** When its agent host last took an addressed event; null before one has. */
  lastAddressedAt: number | null;
};

/** Whether an agent host filtering to what addresses the agent is handed this event, as Switch decides. */
export function isNotifiable(type: string, payload: Record<string, unknown>): boolean {
  if (type === 'message') return payload.addressed === true;
  if (type === 'room_join') return payload.listening === true;
  if (type === 'command') return false;
  return type.startsWith('task_');
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

export class AgentHub {
  private readonly agents = new Map<string, AgentState>();
  private upstream = false;

  constructor(private readonly deps: AgentHubDeps) {}

  // -- What the controller tells Switch ---------------------------------------

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

  /** Where Core attached the agent on the controller stream, while it is attached. */
  attachment(agentId: string): { fromSeq: number; rooms: string[] } | null {
    const agent = this.agents.get(agentId);
    if (!agent?.attached || agent.head === null) return null;
    return { fromSeq: agent.head, rooms: [...(agent.rooms ?? [])] };
  }

  /** The agent's events flow on the controller stream and its agent host is taking them. */
  attached(agentId: string): boolean {
    return this.agents.get(agentId)?.host?.connected ?? false;
  }

  /**
   * Switch has the agent attached on a connected controller stream, whether
   * or not an agent host is taking its events: what a suspended agent reports
   * as attached, since its events are held here for its next agent host.
   */
  streamCarries(agentId: string): boolean {
    return this.upstream && (this.agents.get(agentId)?.attached ?? false);
  }

  /**
   * The room a call made for the agent is made in: the calling session's
   * placement when the call names a session, otherwise the agent's only
   * placed room. Null when neither says, and Switch answers as it does for a
   * caller bound to no room.
   */
  roomFor(agentId: string, sessionId: string | null): string | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    if (sessionId) return agent.placements.get(sessionId) ?? null;
    const rooms = new Set(agent.placements.values());
    return rooms.size === 1 ? [...rooms][0]! : null;
  }

  /** Forgets the agent: it is no longer assigned here. Its host has been stopped. */
  forget(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (agent.host) agent.host.closed = true;
    this.agents.delete(agentId);
    this.deps.onChange();
  }

  // -- Suspending an agent whose agent host is stopped on purpose ----------

  /**
   * Marks the agent's agent host as stopped on purpose until something needs
   * it, or no longer so. While suspended, an addressed event or a room
   * control calls `onWake`, and the hub takes the unaddressed events itself
   * (they are never handed to an agent host), so a long rest in a busy room
   * neither overflows what is held nor meets the next agent host with a gap.
   * Unsuspending to start it (a wake) leaves where the hub got to, and the
   * room controls it keeps, for the next agent host's start; with `drop`
   * (its owner stopped it, it was removed, or something else starts it now)
   * the room controls go, so none runs on a start long after.
   */
  setSuspended(agentId: string, suspended: boolean, options: { drop?: boolean } = {}): void {
    const agent = suspended ? this.agent(agentId) : this.agents.get(agentId);
    if (!agent) return;
    if (!suspended && options.drop) this.dropCommands(agent, agent.heldCommands.splice(0));
    if (agent.suspended === suspended) return;
    agent.suspended = suspended;
    if (!suspended) {
      // Not stopped after all (its stop failed): its running host goes on from its own cursor.
      if (this.running(agent)) agent.idleCursor = null;
      return;
    }
    agent.idleCursor =
      this.running(agent)?.cursor ??
      agent.lastHostCursor ??
      agent.confirmed ??
      agent.attachedFrom ??
      null;
    this.advanceIdle(agent);
    this.trim(agent);
    // What came in while it was being stopped is owed a start now.
    if (this.waiting(agentId)) this.deps.onWake?.(agentId, 'event');
  }

  suspended(agentId: string): boolean {
    return this.agents.get(agentId)?.suspended ?? false;
  }

  /**
   * Stops handing the agent's agent host anything, at once: resolves true
   * once the event it is handing over now, if any, has been taken, or false
   * if that takes longer than `timeoutMs` (the fence stays up either way;
   * `release` lifts it). What arrives meanwhile stays held here, its cursor
   * unmoved. An event whose handing over never finishes is not confirmed,
   * so the next agent host is handed it again.
   */
  async hold(agentId: string, timeoutMs: number = HOLD_TIMEOUT_MS): Promise<boolean> {
    const agent = this.agent(agentId);
    agent.holding = true;
    const pumping = agent.host?.pumping;
    if (!pumping) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([pumping.then(() => true as const), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  release(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent || !agent.holding) return;
    agent.holding = false;
    const host = this.running(agent);
    if (host?.connected) this.flushCommands(agent, host);
    this.pump(agent);
  }

  /**
   * Whether anything is held for the agent that its agent host would be
   * handed or told: an addressed event or a gap past where it stands, or a
   * room control kept while it was suspended.
   */
  waiting(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    this.pruneCommands(agent);
    if (agent.heldCommands.length) return true;
    const host = this.running(agent);
    const from = host
      ? host.cursor
      : (agent.idleCursor ?? agent.lastHostCursor ?? agent.confirmed ?? null);
    const start = from === null ? 0 : firstAfter(agent.buffer, from);
    return agent.buffer.slice(start).some((item) => item.kind === 'gap' || item.notifiable);
  }

  /** When the agent's agent host last took an addressed event; null before one has. */
  lastAddressedAt(agentId: string): number | null {
    return this.agents.get(agentId)?.lastAddressedAt ?? null;
  }

  // -- What arrives on the controller stream ----------------------------------

  setUpstream(connected: boolean): void {
    if (this.upstream === connected) return;
    this.upstream = connected;
    this.refreshAll();
  }

  /**
   * The controller stream (re)attached. Switch attaches every bound agent
   * afresh on each stream, with `agent.attached`, so none counts as attached
   * until it says so again.
   */
  streamAttached(): void {
    for (const agent of this.agents.values()) agent.attached = false;
    this.upstream = true;
    this.refreshAll();
  }

  attach(agentId: string, fromSeq: number, rooms: string[]): void {
    const agent = this.agent(agentId);
    agent.attached = true;
    agent.rooms = new Set(rooms);
    if (agent.attachedFrom === null) agent.attachedFrom = fromSeq;
    if (agent.head === null) agent.head = fromSeq;
    else if (fromSeq > agent.head) {
      // Switch starts the agent past what is held here: whatever lay between
      // is not coming, and an agent host behind it is told so.
      agent.head = fromSeq;
      agent.droppedThrough = Math.max(agent.droppedThrough, fromSeq);
    }
    if (agent.host?.started && agent.host.cursor === null) agent.host.cursor = agent.head;
    this.deps.log.info('Agent attached to the controller stream', { agentId, fromSeq });
    this.refresh(agent);
    this.pump(agent);
  }

  detach(agentId: string, reason: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.attached = false;
    this.deps.log.warn('Agent detached from the controller stream', { agentId, reason });
    this.refresh(agent);
  }

  setRooms(agentId: string, rooms: string[]): void {
    const agent = this.agent(agentId);
    agent.rooms = new Set(rooms);
    // A room the agent is out of (deleted, or the agent taken out), as Switch
    // says: a session placed there no longer attends it, and its agent host
    // forgets the placement rather than state it again and again.
    for (const [sessionId, roomId] of [...agent.placements]) {
      if (agent.rooms.has(roomId)) continue;
      agent.placements.delete(sessionId);
      this.deps.onChange();
      const host = agent.host;
      if (!host || host.closed) continue;
      void Promise.resolve(host.deps.onRoomGone?.({ roomId, sessionId })).catch((error: unknown) =>
        this.deps.log.warn('The agent host could not drop a session placement in a room it left', {
          agentId,
          roomId,
          error: errorMessage(error),
        })
      );
    }
  }

  /**
   * A domain event: held until the agent host takes it. One already held (Switch
   * replays from where the connection opened each time the stream
   * reattaches) is dropped.
   */
  ingest(frame: AgentEventFrame): void {
    const { agent_id: agentId, seq } = frame;
    const agent = this.agent(agentId);
    if (agent.head !== null && seq <= agent.head) return;
    const data = { ...frame.event, sequence: seq } as unknown as AgentBridgeEvent;
    const notifiable = isNotifiable(frame.event.type, frame.event.payload);
    agent.buffer.push({ kind: 'event', seq, notifiable, data });
    if (agent.host?.started && agent.host.cursor === null) agent.host.cursor = seq - 1;
    agent.head = seq;
    this.pump(agent);
    this.advanceIdle(agent);
    this.trim(agent);
    if (notifiable && agent.suspended && !this.running(agent)) this.deps.onWake?.(agentId, 'event');
  }

  /**
   * Switch could not serve the agent's cursor. A reset (Switch restarted, so
   * its numbering went back: resuming below what is held) clears what is held
   * and goes to the agent host now. A gap resuming past what is held takes its
   * place in the buffer, so the agent host meets it in order. One resuming at or
   * below it describes events already held — a reattached stream starting
   * from where the connection opened — and is not passed on.
   */
  gap(frame: AgentGapFrame): void {
    const { agent_id: agentId, ...rest } = frame;
    const data: GapData = {
      from_sequence: rest.from_sequence,
      reason: rest.reason,
      ...(rest.resumed_at === undefined ? {} : { resumed_at: rest.resumed_at }),
      ...(rest.rooms === undefined ? {} : { rooms: rest.rooms }),
      ...(rest.all_rooms === undefined ? {} : { all_rooms: rest.all_rooms }),
    };
    const agent = this.agent(agentId);
    const resumedAt = data.resumed_at;
    if (resumedAt === undefined) {
      void this.tell(agent, data);
      return;
    }
    if (agent.head !== null && resumedAt <= agent.head && data.all_rooms !== true) {
      this.deps.log.debug('Dropped a gap behind what the controller already holds', {
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
      const told = Boolean(agent.host?.started && !agent.host.closed);
      agent.reset = { reason: data.reason, rooms: data.rooms ?? [], resumedAt, owed: !told };
      agent.confirmed = resumedAt;
      // Switch's numbering went back: where earlier agent hosts got to no longer applies.
      agent.lastHostCursor = null;
      if (agent.idleCursor !== null) agent.idleCursor = resumedAt;
      this.deps.onCursor(agentId, resumedAt);
      const host = agent.host;
      if (host?.started && !host.closed) {
        void this.tell(agent, data);
        host.cursor = resumedAt;
      }
      return;
    }
    agent.buffer.push({ kind: 'gap', seq: resumedAt, data });
    agent.head = resumedAt;
    this.pump(agent);
    this.trim(agent);
    // A gap must reach an agent host in order, and the hub cannot take the
    // chatter past it for a suspended agent, so it is a reason to start one.
    if (agent.suspended && !this.running(agent)) this.deps.onWake?.(agentId, 'event');
  }

  /** Tells the room a reset Switch left to the box could not be done; others are left as they were. */
  refuseReset(agentId: string, roomId: string, command: RelayedControl) {
    if (!unannouncedReset(command) || !this.deps.resetRefused) return;
    const origin = command.origin as { threadId?: unknown } | undefined;
    void this.deps
      .resetRefused(agentId, {
        roomId,
        threadId: typeof origin?.threadId === 'string' ? origin.threadId : null,
        commandId: command.commandId,
      })
      .catch((error: unknown) =>
        this.deps.log.warn('Could not tell a room its reset could not be done', {
          agentId,
          roomId,
          commandId: command.commandId,
          error: errorName(error),
        })
      );
  }

  /**
   * A room control (`!reset`, `!compact`, `!interrupt`), for whichever of the
   * agent's sessions works in its room: the agent host decides which.
   */
  sessionCommand(frame: AgentSessionCommandFrame): void {
    const { agent_id: agentId, command } = frame;
    const origin = command.origin as { roomId?: unknown } | undefined;
    const roomId = frame.room_id ?? (typeof origin?.roomId === 'string' ? origin.roomId : null);
    const agent = this.agents.get(agentId);
    const host = agent ? this.running(agent) : null;
    if (roomId && agent && (agent.holding || (agent.suspended && !host))) {
      // Its agent host is being stopped, or was stopped on purpose: kept for
      // the next one (or this one, if it is not stopped after all), which a
      // suspended agent starts for it. Held in memory only, like the events.
      const relayed = { ...command, sessionId: null, roomId } as unknown as SessionCommand;
      // The latest of each kind per room only: a `!reset` sent twice runs once.
      const body = (command as { body?: { type?: unknown } }).body;
      const key = `${roomId}\u0000${typeof body?.type === 'string' ? body.type : command.commandId}`;
      this.pruneCommands(agent);
      agent.heldCommands = agent.heldCommands.filter((held) => held.key !== key);
      agent.heldCommands.push({ command: relayed, key, at: this.now() });
      if (agent.heldCommands.length > HELD_COMMAND_LIMIT) {
        this.dropCommands(agent, agent.heldCommands.splice(0, 1));
        this.deps.log.warn('Dropped the oldest room control kept for a suspended agent', {
          agentId,
          limit: HELD_COMMAND_LIMIT,
        });
      }
      this.deps.log.info('Kept a room control for a suspended agent until its host starts', {
        agentId,
        roomId,
        commandId: command.commandId,
      });
      if (agent.suspended && !host) this.deps.onWake?.(agentId, 'room_control');
      return;
    }
    if (!roomId || !host?.deps.onSessionCommand) {
      this.deps.log.warn(
        roomId
          ? 'Dropped a room control: the agent host is not running'
          : 'Dropped a room control that names no room',
        { agentId, roomId, commandId: command.commandId }
      );
      if (roomId) this.refuseReset(agentId, roomId, command);
      return;
    }
    // Every session of the agent here keeps its room while it rests, so none
    // placed there means none can take it, and the room hears so rather than
    // nothing.
    if (unannouncedReset(command) && ![...agent!.placements.values()].includes(roomId)) {
      this.deps.log.warn('Dropped a room reset: no session of the agent works in its room', {
        agentId,
        roomId,
        commandId: command.commandId,
      });
      this.refuseReset(agentId, roomId, command);
      return;
    }
    const relayed = { ...command, sessionId: null, roomId } as unknown as SessionCommand;
    void Promise.resolve(host.deps.onSessionCommand(relayed)).catch((error: unknown) =>
      this.deps.log.error('The agent host failed a room control', {
        agentId,
        commandId: command.commandId,
        error: errorMessage(error),
      })
    );
  }

  approvalOutcome(frame: AgentApprovalOutcomeFrame): void {
    const { agent_id: agentId } = frame;
    const agent = this.agents.get(agentId);
    const host = agent ? this.running(agent) : null;
    const outcome = approvalOutcome(frame.outcome);
    if (!outcome) {
      this.deps.log.warn('Dropped an unreadable approval outcome', { agentId });
      return;
    }
    if (!host?.deps.onApprovalOutcome) {
      this.deps.log.warn(
        'An approval outcome arrived while the agent host is not running; Switch sends it again until it is delivered',
        { agentId, requestId: outcome.request_id }
      );
      return;
    }
    void Promise.resolve(host.deps.onApprovalOutcome(outcome)).catch((error: unknown) =>
      this.deps.log.error('The agent host failed an approval outcome', {
        agentId,
        requestId: outcome.request_id,
        error: errorMessage(error),
      })
    );
  }

  // -- The agent host's end ------------------------------------------------------

  /**
   * The stream the agent's host hears its events on. One agent host per agent:
   * a newer one replaces an older still open, which hears nothing more.
   */
  open(agentId: string, deps: AgentStreamDeps): AgentEventStream {
    const agent = this.agent(agentId);
    if (agent.host) this.closeHost(agent, agent.host);
    const host: AgentHostLink = {
      deps,
      started: false,
      cursor: null,
      connected: false,
      delivering: false,
      pumping: null,
      closed: false,
    };
    agent.host = host;
    agent.placements.clear();
    deps.signal.addEventListener(
      'abort',
      () => {
        this.closeHost(agent, host);
        if (agent.host === host) {
          agent.host = null;
          agent.placements.clear();
        }
        this.deps.onChange();
      },
      { once: true }
    );
    return {
      // Switch keeps no record of an agent's sessions: the agent host says when it starts one.
      announcesSessionStarts: true,
      // The relay names each call's room from these placements (`roomFor`).
      placementsNameCallRooms: true,
      start: () => {
        if (host.started || host.closed) return;
        host.started = true;
        host.cursor = this.startCursor(agent, deps.startCursor);
        agent.idleCursor = null;
        agent.hostStarted = true;
        // An agent host that was not running when Core reset the numbering
        // holds a cursor from before it. It starts where the new numbering
        // resumed, not at the newest event, which would skip what arrived
        // since: for a resting agent, the message it was started for.
        const reset = agent.reset;
        if (reset && host.cursor !== null && (reset.owed || host.cursor > (agent.head ?? 0))) {
          void this.tell(agent, {
            from_sequence: reset.resumedAt,
            resumed_at: reset.resumedAt,
            rooms: reset.rooms,
            all_rooms: true,
            reason: reset.reason,
          });
          host.cursor = reset.resumedAt;
          reset.owed = false;
        }
        this.refresh(agent);
        this.pump(agent);
      },
      // Switch decides who may start a session from the agent's binding, not
      // from what an agent host on this machine declares.
      setSpawnCapable: () => {},
      // A session placed in a room the agent is not in (any more: the room was
      // deleted, or the agent taken out) is left out and named back; the rest
      // are placed. Refusing the whole set for one gone room left every other
      // session of the agent unplaced, and its room tools answered "not
      // connected" though the session had just connected.
      replacePlacements: async (placements) => {
        if (host.closed || agent.host !== host)
          throw new Error(
            `this agent host no longer holds agent ${agentId}'s stream on the agent controller; a newer one does`
          );
        const refusedRooms = [...new Set(Object.values(placements))]
          .filter((roomId) => agent.rooms !== null && !agent.rooms.has(roomId))
          .sort();
        const kept = Object.entries(placements).filter(
          ([, roomId]) => !refusedRooms.includes(roomId)
        );
        const rooms = kept.map(([, roomId]) => roomId);
        const twice = [...new Set(rooms.filter((room, index) => rooms.indexOf(room) !== index))];
        if (twice.length)
          throw new Error(
            `placements name room(s) ${twice.sort().join(', ')} for more than one session; one session of an agent acts in a room`
          );
        for (const roomId of refusedRooms) {
          if (agent.refusedRooms.has(roomId)) continue;
          agent.refusedRooms.add(roomId);
          this.deps.log.warn('Left out a session placement in a room the agent is not in', {
            agentId,
            roomId,
          });
        }
        agent.placements = new Map(kept);
        this.deps.onChange();
        return { refusedRooms };
      },
    };
  }

  // -- Internals --------------------------------------------------------------

  private agent(agentId: string): AgentState {
    let agent = this.agents.get(agentId);
    if (!agent) {
      agent = {
        agentId,
        attached: false,
        rooms: null,
        head: null,
        attachedFrom: null,
        hostStarted: false,
        droppedThrough: 0,
        confirmed: null,
        buffer: [],
        reset: null,
        placements: new Map(),
        refusedRooms: new Set(),
        host: null,
        overflowing: false,
        lastHostCursor: null,
        suspended: false,
        idleCursor: null,
        holding: false,
        heldCommands: [],
        lastAddressedAt: null,
      };
      this.agents.set(agentId, agent);
    }
    return agent;
  }

  /** Marks an agent host closed, keeping where it got to for the next one. */
  private closeHost(agent: AgentState, host: AgentHostLink): void {
    if (host.closed) return;
    host.closed = true;
    if (host.started && host.cursor !== null) agent.lastHostCursor = host.cursor;
  }

  /**
   * Where a starting agent host is handed events from. Its own cursor when
   * it has one. One with none (it never took an addressed event, so it saves
   * none) starts where the last agent host got to, or for a new agent's
   * first run where Switch first attached it; only with neither known (the
   * controller restarted since) at the newest event. Starting at the newest
   * event when the hub knows better would skip what arrived while no agent
   * host ran: after a crash, a restart, or a rest, the message it was started
   * for. An agent coming back from a suspension starts no earlier than where
   * the hub took events for it meanwhile.
   */
  private startCursor(agent: AgentState, own: number | undefined): number | null {
    const idle = agent.idleCursor;
    if (own !== undefined) return idle === null ? own : Math.max(own, idle);
    if (idle !== null) return idle;
    if (agent.lastHostCursor !== null) return agent.lastHostCursor;
    return !agent.hostStarted && agent.attachedFrom !== null ? agent.attachedFrom : agent.head;
  }

  /**
   * Takes, for a suspended agent with no agent host, the unaddressed events
   * past where it stands: up to the first addressed event or gap, which wait
   * for its next agent host. A running one does the same in `pump`.
   */
  private advanceIdle(agent: AgentState): void {
    if (!agent.suspended || agent.idleCursor === null || this.running(agent)) return;
    if (agent.idleCursor < agent.droppedThrough) return;
    for (let index = firstAfter(agent.buffer, agent.idleCursor); ; index++) {
      const item = agent.buffer[index];
      if (!item || item.kind === 'gap' || item.notifiable) return;
      agent.idleCursor = item.seq;
      this.confirm(agent, item.seq);
    }
  }

  /** Hands a newly connected agent host the room controls kept while it was suspended. */
  private flushCommands(agent: AgentState, host: AgentHostLink): void {
    this.pruneCommands(agent);
    if (!agent.heldCommands.length || !host.deps.onSessionCommand) return;
    const commands = agent.heldCommands.splice(0).map((held) => held.command);
    for (const command of commands)
      void Promise.resolve(host.deps.onSessionCommand(command)).catch((error: unknown) =>
        this.deps.log.error('The agent host failed a room control kept while it was suspended', {
          agentId: agent.agentId,
          commandId: (command as { commandId?: unknown }).commandId,
          error: errorCode(error),
        })
      );
  }

  /** Drops room controls kept longer than `HELD_COMMAND_MAX_AGE_MS`, and says so. */
  private pruneCommands(agent: AgentState): void {
    const now = this.now();
    const kept = agent.heldCommands.filter((held) => now - held.at < HELD_COMMAND_MAX_AGE_MS);
    if (kept.length === agent.heldCommands.length) return;
    this.deps.log.warn('Dropped room controls kept too long for a suspended agent', {
      agentId: agent.agentId,
      dropped: agent.heldCommands.length - kept.length,
      maxAgeMs: HELD_COMMAND_MAX_AGE_MS,
    });
    const dropped = agent.heldCommands.filter((held) => !kept.includes(held));
    agent.heldCommands = kept;
    this.dropCommands(agent, dropped);
  }

  private dropCommands(agent: AgentState, dropped: HeldCommand[]): void {
    for (const held of dropped) {
      const roomId = held.command.roomId;
      if (typeof roomId === 'string')
        this.deps.onHeldCommandDropped?.(agent.agentId, roomId, held.command);
    }
  }

  private running(agent: AgentState): AgentHostLink | null {
    const host = agent.host;
    return host && host.started && !host.closed ? host : null;
  }

  private refreshAll(): void {
    for (const agent of this.agents.values()) this.refresh(agent);
    this.deps.onChange();
  }

  /** Tells the agent host when it gains or loses the agent's connection. */
  private refresh(agent: AgentState): void {
    const host = this.running(agent);
    if (!host) return;
    const connected = this.upstream && agent.attached;
    if (connected === host.connected) return;
    host.connected = connected;
    if (connected) {
      host.deps.onConnected?.();
      this.flushCommands(agent, host);
    } else
      host.deps.onDisconnected?.({
        error: this.upstream
          ? 'Switch detached the agent from this controller.'
          : 'The controller is reconnecting to Switch.',
      });
    this.deps.onChange();
  }

  private async tell(agent: AgentState, data: GapData): Promise<void> {
    const host = this.running(agent);
    if (!host) return;
    const resumedAt = data.resumed_at;
    try {
      await host.deps.onGap({
        fromSequence: data.from_sequence,
        reason: data.reason,
        ...(data.rooms === undefined ? {} : { rooms: data.rooms }),
        ...(resumedAt === undefined
          ? {}
          : { resumedAt, cursorReset: resumedAt < (host.cursor ?? 0) }),
      });
    } catch (error) {
      this.deps.log.error('The agent host failed a gap', {
        agentId: agent.agentId,
        error: errorMessage(error),
      });
    }
  }

  /**
   * Hands the agent host, one at a time and in order, everything past its cursor.
   * Each event counts as taken once the agent host's handler resolves: it has
   * queued or journalled it by then.
   */
  private pump(agent: AgentState): void {
    const host = this.running(agent);
    if (!host || host.delivering || host.cursor === null || agent.holding) return;
    host.delivering = true;
    host.pumping = (async () => {
      try {
        while (agent.host === host && !host.closed && !agent.holding) {
          if (host.cursor! < agent.droppedThrough) {
            await this.tell(agent, {
              from_sequence: host.cursor!,
              resumed_at: agent.droppedThrough,
              rooms: [...(agent.rooms ?? [])].sort(),
              all_rooms: true,
              reason:
                'the agent controller no longer holds events this far back; re-read room context',
            });
            host.cursor = agent.droppedThrough;
          }
          const index = firstAfter(agent.buffer, host.cursor!);
          const item = agent.buffer[index];
          if (!item) break;
          if (item.kind === 'gap')
            await this.tell(agent, { ...item.data, from_sequence: host.cursor! });
          else if (item.notifiable) {
            await host.deps.onEvent(item.data);
            agent.lastAddressedAt = this.now();
            this.deps.onAddressedTaken?.(agent.agentId, item.data);
          }
          if (agent.host !== host || host.closed) break;
          host.cursor = item.seq;
          this.confirm(agent, item.seq);
        }
      } catch (error) {
        // The agent host has already recorded its own failure and is ending.
        this.deps.log.error(
          'The agent host failed an event; it stops, and resumes from its cursor',
          {
            agentId: agent.agentId,
            error: errorMessage(error),
          }
        );
      } finally {
        host.delivering = false;
        host.pumping = null;
        this.trim(agent);
      }
    })();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private confirm(agent: AgentState, cursor: number): void {
    if (agent.confirmed !== null && cursor <= agent.confirmed) return;
    agent.confirmed = cursor;
    this.deps.onCursor(agent.agentId, cursor);
  }

  /** Drops what the agent host has taken, and the oldest past the limit. */
  private trim(agent: AgentState): void {
    const floor = agent.confirmed ?? -1;
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
        'The controller is holding more events than it keeps for an agent whose host is not taking them; the oldest are dropped, and the agent host is told when it starts',
        { agentId: agent.agentId, limit: this.deps.bufferLimit }
      );
    agent.overflowing = overflow;
  }
}

/** A room control as Switch relayed it, or as the hub kept it. */
type RelayedControl = { commandId: string; [key: string]: unknown };

/** A `!reset` Switch relayed without announcing it, leaving the box to say how it went. */
function unannouncedReset(command: RelayedControl): boolean {
  const body = command.body as { type?: unknown } | undefined;
  return body?.type === 'session.reset' && command.roomTold === false;
}

/** An error's name or code for a log: never its message, which can carry a path. */
function errorName(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.name : 'unknown error';
}

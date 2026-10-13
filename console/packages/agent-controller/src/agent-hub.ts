import type {
  AgentBridgeEvent,
  ApprovalOutcome,
  SessionCommand,
  SwitchEventStreamDeps,
} from '@sandboxaq/switch-agent-runtime';
import type { AgentEventStream } from '@switch-console/agent-providers';
import { errorMessage, type Logger } from './log';
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
};

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
  deps: SwitchEventStreamDeps;
  started: boolean;
  /** The last sequence handed to the agent host (or skipped); null until the agent's head is known. */
  cursor: number | null;
  connected: boolean;
  delivering: boolean;
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
  /** At or below this, nothing is held: an agent host starting there is told of a gap. */
  droppedThrough: number;
  /** The cursor the controller resumes the agent from upstream. */
  confirmed: number | null;
  buffer: Buffered[];
  /** Core reset the agent's numbering (it restarted). */
  reset: { reason: string; rooms: string[] } | null;
  /** Each of its sessions' room, as its agent host last stated. */
  placements: Map<string, string>;
  host: AgentHostLink | null;
  overflowing: boolean;
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
    this.agent(agentId).rooms = new Set(rooms);
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
    agent.buffer.push({
      kind: 'event',
      seq,
      notifiable: isNotifiable(frame.event.type, frame.event.payload),
      data,
    });
    if (agent.host?.started && agent.host.cursor === null) agent.host.cursor = seq - 1;
    agent.head = seq;
    this.pump(agent);
    this.trim(agent);
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
      agent.reset = { reason: data.reason, rooms: data.rooms ?? [] };
      agent.confirmed = resumedAt;
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
    if (!roomId || !host?.deps.onSessionCommand) {
      this.deps.log.warn(
        roomId
          ? 'Dropped a room control: the agent host is not running'
          : 'Dropped a room control that names no room',
        { agentId, roomId, commandId: command.commandId }
      );
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
  open(agentId: string, deps: SwitchEventStreamDeps): AgentEventStream {
    const agent = this.agent(agentId);
    if (agent.host) agent.host.closed = true;
    const host: AgentHostLink = {
      deps,
      started: false,
      cursor: null,
      connected: false,
      delivering: false,
      closed: false,
    };
    agent.host = host;
    agent.placements.clear();
    deps.signal.addEventListener(
      'abort',
      () => {
        host.closed = true;
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
      start: () => {
        if (host.started || host.closed) return;
        host.started = true;
        host.cursor = deps.startCursor ?? agent.head;
        if (
          agent.reset &&
          host.cursor !== null &&
          agent.head !== null &&
          host.cursor > agent.head
        ) {
          void this.tell(agent, {
            from_sequence: agent.head,
            resumed_at: agent.head,
            rooms: agent.reset.rooms,
            all_rooms: true,
            reason: agent.reset.reason,
          });
          host.cursor = agent.head;
        }
        this.refresh(agent);
        this.pump(agent);
      },
      // Switch decides who may start a session from the agent's binding, not
      // from what an agent host on this machine declares.
      setSpawnCapable: () => {},
      replacePlacements: async (placements) => {
        if (host.closed || agent.host !== host) return;
        const rooms = Object.values(placements);
        for (const roomId of new Set(rooms))
          if (agent.rooms && !agent.rooms.has(roomId))
            throw new Error(`agent ${agentId} is not a member of room ${roomId}`);
        const twice = [...new Set(rooms.filter((room, index) => rooms.indexOf(room) !== index))];
        if (twice.length)
          throw new Error(
            `placements name room(s) ${twice.sort().join(', ')} for more than one session; one session of an agent acts in a room`
          );
        agent.placements = new Map(Object.entries(placements));
        this.deps.onChange();
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
        droppedThrough: 0,
        confirmed: null,
        buffer: [],
        reset: null,
        placements: new Map(),
        host: null,
        overflowing: false,
      };
      this.agents.set(agentId, agent);
    }
    return agent;
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
    if (connected) host.deps.onConnected?.();
    else
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
    if (!host || host.delivering || host.cursor === null) return;
    host.delivering = true;
    void (async () => {
      try {
        while (agent.host === host && !host.closed) {
          if (host.cursor! < agent.droppedThrough) {
            await this.tell(agent, {
              from_sequence: host.cursor!,
              resumed_at: agent.droppedThrough,
              rooms: [...(agent.rooms ?? [])].sort(),
              all_rooms: true,
              reason:
                'the agents controller no longer holds events this far back; re-read room context',
            });
            host.cursor = agent.droppedThrough;
          }
          const index = firstAfter(agent.buffer, host.cursor!);
          const item = agent.buffer[index];
          if (!item) break;
          if (item.kind === 'gap')
            await this.tell(agent, { ...item.data, from_sequence: host.cursor! });
          else if (item.notifiable) await host.deps.onEvent(item.data);
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
        this.trim(agent);
      }
    })();
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

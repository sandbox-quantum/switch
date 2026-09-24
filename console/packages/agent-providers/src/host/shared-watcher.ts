import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EVICTION_HEARTBEAT_LAPSED,
  EVICTION_TAKEN_OVER,
  SwitchEventStream,
} from '@sandboxaq/switch-agent-runtime';
import { z } from 'zod';
import type { Handoff } from './handoff';
import { Journal } from './journal';
import {
  ensureSharedProcess,
  liveSupervisor,
  sharedSessionRoot,
  sharedSessionsBase,
  type Supervision,
} from './launch';
import { releaseOwner, replaceOwner, withOwnershipLock } from './ownership-lock';
import { roomInputId } from './room-inbox';
import { type SessionRequest, SessionUnavailableError } from './session-channel';
import { readSharedCredentials, sharedConfigSchema, type SharedHostConfig } from './shared-config';
import { hostParked } from './shared-state';
import { readTakenOver, recordTakenOver } from './taken-over';
import { awaitWatchChange, readWatchFlags } from './watch-flags';

const assignmentSchema = z.strictObject({
  sequence: z.number().int().positive(),
  roomId: z.string().min(1),
  messageId: z.string().min(1),
  config: sharedConfigSchema,
});

/** Marks where the server's sequence numbering restarted. */
const restartSchema = z.strictObject({ restarted: z.literal(true), at: z.string().min(1) });

/** Marks a sequence whose routing decision has reached disk. */
const handledSchema = z.strictObject({ handled: z.number().int().positive() });

/**
 * Marks a sequence held because the room's owner is undecided. Nothing has been
 * routed and nothing started; the event waits for the session that holds the
 * room to say so.
 *
 * It carries whether the event arrived while the agent was allowed to start a
 * session, because that is the permission it is finally admitted under and the
 * setting can be turned off — or on — while it waits.
 */
const parkedSchema = z.strictObject({
  parked: z.number().int().positive(),
  roomId: z.string().min(1),
  messageId: z.string().min(1),
  spawning: z.boolean(),
  // The event as the stream delivered it, kept because nothing else keeps it:
  // the session's prompt is built from this copy when the room gets an owner.
  event: z.unknown().optional(),
});

/**
 * Marks a held delivery as dealt with, named by the room and message rather
 * than by the sequence it arrived on. A held event outlives the numbering it
 * was delivered under: the server can restart its sequence while the event
 * waits, and the position it held then means something else afterwards.
 */
const releasedSchema = z.strictObject({
  released: z.strictObject({
    roomId: z.string().min(1),
    messageId: z.string().min(1),
  }),
});
const recordSchema = z.union([
  assignmentSchema,
  restartSchema,
  handledSchema,
  parkedSchema,
  releasedSchema,
]);

type Assignment = z.infer<typeof assignmentSchema>;
type Held = Handoff & { spawning: boolean };
type WatchRecord = z.infer<typeof recordSchema>;

function restarted(record: WatchRecord): record is z.infer<typeof restartSchema> {
  return 'restarted' in record;
}

function isHandled(record: WatchRecord): record is z.infer<typeof handledSchema> {
  return 'handled' in record;
}

function isParked(record: WatchRecord): record is z.infer<typeof parkedSchema> {
  return 'parked' in record;
}

function isReleased(record: WatchRecord): record is z.infer<typeof releasedSchema> {
  return 'released' in record;
}

function isAssignment(record: WatchRecord): record is Assignment {
  return !restarted(record) && !isHandled(record) && !isParked(record) && !isReleased(record);
}

const delivery = (event: { roomId: string; messageId: string }): string =>
  JSON.stringify([event.roomId, event.messageId]);

/** How often a room with no session to take its messages is looked at again. */
const OWNERSHIP_RETRY_MS = 5000;

/** How long a message waits for its session's host to start and take it. */
const HOST_START_MS = 120000;

/** How often a room still waiting for an owner says so again. */
const HELD_DISCLOSURE_MS = 30000;

function sessionIdFor(agentId: string, roomId: string, messageId: string): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify([agentId, roomId, messageId]))
    .digest();
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function stopped(sessionId: string): Promise<boolean> {
  try {
    const text = await readFile(join(sharedSessionRoot(sessionId), 'inbox.jsonl'), 'utf8');
    if (text && !text.endsWith('\n'))
      throw new Error(
        'Watcher session journal has an incomplete record; recovery review is required.'
      );
    return text
      .split('\n')
      .slice(0, -1)
      .some((line) => JSON.parse(line).type === 'stopped');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * The same session, reachable over the connection this controller holds.
 *
 * A config saved before an agent had one inbound connection names the
 * session's own, which that session stops opening the moment it is started
 * from this build: left as it was, the worker would bind to a connection that
 * never returns. The identity is the agent's rather than the run's, so
 * replacing it is a correction rather than a change of routing.
 */
function reachableBy(config: SharedHostConfig, connectionId: string): SharedHostConfig {
  if (config.roomConnection?.connectionId === connectionId) return config;
  return { ...structuredClone(config), roomConnection: { connectionId } };
}

/**
 * This agent's sessions that are still running the build the watcher has just
 * superseded. A session is supervised independently of the watcher, so nothing
 * else finds them: they would go on answering their rooms with code the
 * deployment moved past until somebody restarted them by hand. Only a session
 * with a live supervisor counts — one that is not running was not left behind
 * by an upgrade, and starting it would reopen a session its owner had closed.
 */
export async function supersededSessions(
  agentId: string,
  supervision: Supervision
): Promise<{ root: string; config: SharedHostConfig }[]> {
  const base = sharedSessionsBase();
  let names: string[];
  try {
    names = await readdir(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: { root: string; config: SharedHostConfig }[] = [];
  for (const name of names) {
    const root = join(base, name);
    let config: SharedHostConfig;
    try {
      config = sharedConfigSchema.parse(
        JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
      );
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      // This is a sweep over every session on the machine, and the filter for
      // "is it even this agent's" is the line below — after the parse. So a
      // directory left by an older build, naming a provider this one no longer
      // has, used to abort the whole call and take auto-sessions down for an
      // agent that had nothing to do with it. One unreadable neighbour is not a
      // reason to stop; it is a reason to say so and carry on.
      console.warn(
        `Skipping session state at ${root}: its config could not be read (${
          error instanceof Error ? error.message : String(error)
        }). It will not be restarted.`
      );
      continue;
    }
    if (config.session.agentId !== agentId) continue;
    const running = await liveSupervisor(root);
    if (!running || running.build === supervision.build) continue;
    found.push({ root, config });
  }
  return found;
}

/** Restarts each superseded session from its saved state, on this connection. */
export async function replaceSupersededSessions(
  superseded: { root: string; config: SharedHostConfig }[],
  connectionId: string,
  supervision: Supervision
): Promise<void> {
  for (const { root, config } of superseded) {
    console.warn(
      `Session ${config.session.sessionId} is running a superseded build; restarting it from saved state.`
    );
    await ensureSharedProcess({
      root,
      config: reachableBy(config, connectionId),
      resuming: false,
      watcher: false,
      restart: false,
      supervision,
    });
  }
}

/**
 * Which session serves which room, and how far the watcher has got. Both the
 * assignment and the routing that follows it are on disk before the stream is
 * allowed past the event.
 */
export class SharedWatchAssignments {
  private constructor(private readonly journal: Journal<WatchRecord>) {}

  static async open(root: string): Promise<SharedWatchAssignments> {
    return new SharedWatchAssignments(
      await Journal.load(join(root, 'assignments.jsonl'), (value) => recordSchema.parse(value))
    );
  }

  /** Records written under the server's current numbering. */
  private get current(): WatchRecord[] {
    const records = this.journal.records;
    let index = records.length - 1;
    while (index >= 0 && !restarted(records[index]!)) index--;
    return records.slice(index + 1);
  }

  private get every(): Assignment[] {
    return this.journal.records.filter(isAssignment);
  }

  /** Held deliveries this journal has finished with, by room and message. */
  private get settled(): Set<string> {
    return new Set(
      this.journal.records.filter(isReleased).map((record) => delivery(record.released))
    );
  }

  /**
   * Where the stream reopens: the last sequence whose routing reached disk, and
   * never past an event still waiting for its room's owner.
   *
   * An assignment on its own is not a position. The watcher can die between
   * recording which session serves a room and handing that session the event,
   * and reopening past the event would leave nothing holding it: this is the
   * agent's single connection, so there is no second copy of what it was sent.
   * A held event is the same case, and the position stays behind it: the events
   * after it are served again and recognised as ones already dealt with. The
   * held event itself is kept in this journal rather than left to that replay,
   * because the server's buffer can be trimmed or renumbered while it waits.
   */
  get cursor(): number {
    let complete = 0;
    let assigned = 0;
    const parked = new Map<number, string>();
    const released = this.settled;
    for (const record of this.current) {
      if (isHandled(record)) complete = Math.max(complete, record.handled);
      else if (isParked(record)) parked.set(record.parked, delivery(record));
      // A held delivery's assignment is not a position. It can be made under a
      // numbering the sequence it names does not belong to, and the release
      // that closes it says where it got to.
      else if (isAssignment(record) && !released.has(delivery(record))) {
        // An assignment is only made once the one before it has been routed, so
        // a journal written before routing was recorded still resumes at its
        // last complete event instead of from the beginning.
        complete = Math.max(complete, assigned);
        assigned = record.sequence;
      }
    }
    const waiting: number[] = [];
    for (const [sequence, identity] of parked)
      if (released.has(identity)) complete = Math.max(complete, sequence);
      else waiting.push(sequence);
    return waiting.length ? Math.min(complete, Math.min(...waiting) - 1) : complete;
  }

  /**
   * The held deliveries still waiting for their room's owner, oldest first.
   *
   * Read across every numbering the journal has seen, because a held event
   * outlives them: the point of writing it down is that the server's copy may
   * be gone by the time the room has an owner again.
   */
  pending(): Held[] {
    const released = this.settled;
    const waiting = new Map<string, Held>();
    for (const record of this.journal.records) {
      if (!isParked(record)) continue;
      const identity = delivery(record);
      if (released.has(identity) || waiting.has(identity)) continue;
      waiting.set(identity, {
        sequence: record.parked,
        roomId: record.roomId,
        messageId: record.messageId,
        spawning: record.spawning,
        event: record.event,
      });
    }
    return [...waiting.values()];
  }

  /**
   * The session that serves a room: the one most recently assigned to it.
   *
   * This controller is the agent's only one — Switch lets a single connection
   * carry the agent's rooms — so what it has written down is the whole record.
   */
  ownerOf(roomId: string): SharedHostConfig | null {
    const assigned = this.every.filter((record) => record.roomId === roomId);
    return assigned.at(-1)?.config ?? null;
  }

  /** Records that the event has been routed, or decided not to be. */
  async handled(sequence: number): Promise<void> {
    await this.journal.append({ handled: sequence });
  }

  /** Records that a held event has been routed, or decided not to be. */
  async released(event: { roomId: string; messageId: string }): Promise<void> {
    await this.journal.append({
      released: { roomId: event.roomId, messageId: event.messageId },
    });
  }

  /** Records that the event is waiting for its room's owner to be decided. */
  async park(event: Handoff, spawning: boolean): Promise<void> {
    await this.journal.append({
      parked: event.sequence,
      roomId: event.roomId,
      messageId: event.messageId,
      spawning,
      ...(event.event === undefined ? {} : { event: event.event }),
    });
  }

  /**
   * Notes that the server restarted its numbering. Past sequence numbers no
   * longer identify an event, so they stop being read as a saved position or
   * matched for duplicates — but which session serves which room is kept.
   */
  async restart(): Promise<void> {
    await this.journal.append({ restarted: true, at: new Date().toISOString() });
  }

  /**
   * The session that answers this delivery, minted if there is none.
   *
   * Reached only once the room has no session and this controller may start
   * one. What that session is called is derived from the delivery, so a
   * controller asking twice about the same message names the same session
   * rather than a second one.
   */
  async assign(template: SharedHostConfig, event: Handoff): Promise<SharedHostConfig> {
    // A held delivery is recognised by the room and message it names. The
    // sequence it arrived on may belong to a numbering the server has since
    // restarted, where it now stands for somebody else's message.
    const waiting = new Set(this.pending().map(delivery));
    const assignments = this.current.filter(isAssignment);
    const duplicate = waiting.has(delivery(event))
      ? assignments.find((record) => delivery(record) === delivery(event))
      : assignments.find((record) => record.sequence === event.sequence);
    if (duplicate) {
      if (duplicate.roomId !== event.roomId || duplicate.messageId !== event.messageId)
        throw new Error('Watcher sequence changed message identity.');
      return duplicate.config;
    }
    if (!template.roomConnection?.connectionId)
      throw new Error('A watcher assignment needs the connection its agent is reached over.');
    const config = structuredClone(template);
    const sessionId = sessionIdFor(template.session.agentId, event.roomId, event.messageId);
    config.session = { ...config.session, sessionId, hostId: randomUUID(), epoch: randomUUID() };
    config.start.input.sessionId = sessionId;
    if (config.start.input.env.SWITCHDASH_SESSION_ID !== undefined)
      config.start.input.env.SWITCHDASH_SESSION_ID = sessionId;
    delete config.start.input.resume;
    delete config.grant;
    await mkdir(sharedSessionRoot(sessionId), { recursive: true });
    await this.journal.append({
      sequence: event.sequence,
      roomId: event.roomId,
      messageId: event.messageId,
      config,
    });
    return config;
  }

  sessions(): SharedHostConfig[] {
    return [
      ...new Map(
        this.every.map((record) => [record.config.session.sessionId, record.config])
      ).values(),
    ];
  }
}

export async function runSharedWatcher(
  root: string,
  template: SharedHostConfig,
  signal: AbortSignal,
  supervision: Supervision
): Promise<void> {
  const ownerPath = join(root, 'shared-owner.lock');
  const owner = { pid: process.pid, token: randomUUID() };
  await withOwnershipLock(root, async () => {
    try {
      const { pid } = z
        .object({ pid: z.number().int().positive() })
        .parse(JSON.parse(await readFile(ownerPath, 'utf8')));
      process.kill(pid, 0);
      throw new Error('The shared SDK watcher is already running.');
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    await replaceOwner(ownerPath, owner);
  });
  const stop = new AbortController();
  const abort = () => stop.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let fault: Error | null = null;
  let pending: Promise<void> = Promise.resolve();
  let retry: NodeJS.Timeout | null = null;
  const fail = (error: Error) => {
    fault = error;
    stop.abort(error);
  };
  try {
    if (!template.execution || !template.roomConnection)
      throw new Error('Shared watcher requires execution credentials and a connection identity.');
    const connectionId = template.roomConnection.connectionId;
    let flags = await readWatchFlags(root);
    if (!flags.enabled) return;
    // Not captured once: somebody can turn automatic sessions off while this
    // controller is connected, and the answer it gave on opening has to change
    // with them rather than wait for a restart nobody knows to perform.
    let spawn = flags.spawn;
    // Stood down after a takeover, and staying down. Starting would reopen the
    // connection, which is itself a takeover — the watcher would win it back
    // from whoever displaced it, and the two would trade the agent's one
    // controller connection between them for as long as both were running.
    const displaced = await readTakenOver(root);
    if (displaced) {
      console.warn(
        `Shared SDK watcher stood down at ${displaced.at} because another client took its connection (${displaced.reason}). It will not restart on its own; use Restart on the agent's Room watcher settings.`
      );
      return;
    }
    const credentials = await readSharedCredentials(template);
    const assignments = await SharedWatchAssignments.open(root);
    const launch = async (config: SharedHostConfig) => {
      // Both flags are re-read here rather than taken from whoever asked for the
      // launch. Everything that reaches this point was admitted earlier and may
      // have waited behind other work since — a queued event, or an assignment
      // later in the restore loop — and a session started after somebody turned
      // spawning off cannot be taken back.
      const now = await readWatchFlags(root);
      if (!now.enabled || !now.spawn || (await stopped(config.session.sessionId))) return;
      await ensureSharedProcess({
        root: sharedSessionRoot(config.session.sessionId),
        config: reachableBy(config, connectionId),
        resuming: false,
        watcher: false,
        restart: false,
        supervision,
      });
    };
    const superseded = await supersededSessions(template.session.agentId, supervision);
    await replaceSupersededSessions(superseded, connectionId, supervision);
    /** Every assigned session, except those that parked: they start when next needed. */
    const launchAssigned = async () => {
      for (const config of assignments.sessions())
        if (!(await hostParked(sharedSessionRoot(config.session.sessionId)))) await launch(config);
    };
    /**
     * Rooms with no session able to take their messages yet, and the events
     * waiting in the order they arrived. Only the room in question waits; the
     * ones behind a held event keep their place behind it, so a room is never
     * answered out of order.
     */
    const held = new Map<string, { events: Held[]; since: number }>();
    /**
     * Routes the event to the session serving its room, starting one where
     * the room has none and this controller may. False when neither can be
     * done yet and the event has to wait.
     *
     * The permission is the one the event arrived under rather than the one in
     * force when it is finally admitted: a room that was promised a session
     * when it was addressed should still get one.
     */
    const links = supervision.links;
    if (!links)
      throw new Error(
        'The room watcher needs to be the parent of its sessions to talk to them; it was given a supervision that starts them detached.'
      );
    /**
     * Ask the host of one of this agent's sessions, if it runs here. False
     * when it is not this agent's, or nothing is running it.
     */
    const askSession = async (sessionId: string, request: SessionRequest, what: string) => {
      const sessionRoot = sharedSessionRoot(sessionId);
      try {
        const saved = sharedConfigSchema.parse(
          JSON.parse(await readFile(join(sessionRoot, 'config.json'), 'utf8'))
        );
        if (saved.session.agentId !== template.session.agentId) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      try {
        await links.request(sessionRoot, request, 0);
        return true;
      } catch (error) {
        console.warn(`Could not pass ${what} to session ${sessionId}: ${String(error)}`);
        return false;
      }
    };
    /**
     * Per session, the messages handed to it and not yet acknowledged, sent
     * down the IPC pipe one at a time and in order. Each is parked in the
     * journal first and released on the host's acknowledgement, so one this
     * controller dies holding is routed again when it restarts.
     */
    const pumps = new Map<string, { queue: Handoff[]; running: boolean }>();
    const pump = (config: SharedHostConfig) => {
      const sessionId = config.session.sessionId;
      const entry = pumps.get(sessionId)!;
      if (entry.running) return;
      entry.running = true;
      void (async () => {
        const sessionRoot = sharedSessionRoot(sessionId);
        while (entry.queue.length && !stop.signal.aborted) {
          const event = entry.queue[0]!;
          try {
            await links.request(
              sessionRoot,
              { type: 'room', handoff: { ...event, event: event.event ?? null } },
              HOST_START_MS
            );
            entry.queue.shift();
            pending = pending.then(() => assignments.released(event));
            await pending;
          } catch (error) {
            if (!(error instanceof SessionUnavailableError)) throw error;
            // Not running, or it stopped before it answered: start it again
            // and hand the message over once it is back.
            console.warn(
              `Session ${sessionId} did not take message ${event.messageId} (${error.message}); starting it again.`
            );
            await launch(config);
            await new Promise((resolve) => setTimeout(resolve, OWNERSHIP_RETRY_MS));
          }
        }
        entry.running = false;
      })().catch((error: Error) => fail(error));
    };
    /**
     * Hands the event to the session: over the IPC pipe where this process is
     * its parent, otherwise through its handoff file. Starts the session if
     * nothing is running it, since the room is still its own.
     */
    const deliver = async (
      config: SharedHostConfig,
      event: Handoff,
      waiting: boolean
    ): Promise<boolean> => {
      const sessionId = config.session.sessionId;
      const sessionRoot = sharedSessionRoot(sessionId);
      if (!waiting) await assignments.park(event, false);
      const entry = pumps.get(sessionId) ?? { queue: [], running: false };
      pumps.set(sessionId, entry);
      if (!entry.queue.some((queuedEvent) => queuedEvent.messageId === event.messageId))
        entry.queue.push(event);
      if (!links.ready(sessionRoot)) await launch(config);
      pump(config);
      return true;
    };
    const admit = async (event: Handoff, spawning: boolean, waiting: boolean): Promise<boolean> => {
      const owner = assignments.ownerOf(event.roomId);
      if (owner && !(await stopped(owner.session.sessionId))) {
        await deliver(owner, event, waiting);
        return true;
      }
      if (!spawning) return false;
      const config = await assignments.assign(
        sharedConfigSchema.parse(JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))),
        event
      );
      await deliver(config, event, waiting);
      return true;
    };
    /**
     * Routes to the session Switch says has connected to the room, when it is
     * one of this agent's here. A session can move between rooms, or be one
     * Console started, so this is the fresher answer than the journal's.
     */
    const routePlaced = async (sessionId: string, event: Handoff): Promise<boolean> => {
      let saved: SharedHostConfig;
      try {
        saved = sharedConfigSchema.parse(
          JSON.parse(await readFile(join(sharedSessionRoot(sessionId), 'config.json'), 'utf8'))
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      if (saved.session.agentId !== template.session.agentId || (await stopped(sessionId)))
        return false;
      return deliver(saved, event, false);
    };
    const queued = (roomId: string, messageId: string): boolean =>
      held.get(roomId)?.events.some((entry) => entry.messageId === messageId) === true;
    const hold = async (event: Handoff, spawning: boolean) => {
      // The stream serves a held event again whenever it reopens behind it, and
      // this journal holds its own copy; neither is a second message.
      if (queued(event.roomId, event.messageId)) return;
      const waiting = held.get(event.roomId);
      if (waiting) waiting.events.push({ ...event, spawning });
      else {
        held.set(event.roomId, { events: [{ ...event, spawning }], since: Date.now() });
        console.warn(
          `No session of this agent can take room ${event.roomId}'s messages yet, and starting one is off; holding them until one can.`
        );
      }
      await assignments.park(event, spawning);
    };
    /** Looks at each held room again, and answers the ones that can now be. */
    const resolveHeld = async () => {
      for (const [roomId, waiting] of [...held]) {
        while (waiting.events.length) {
          const { spawning, ...event } = waiting.events[0]!;
          if (!(await admit(event, spawning || spawn, true))) break;
          waiting.events.shift();
        }
        if (!waiting.events.length) {
          held.delete(roomId);
          console.warn(
            `Room ${roomId} has a session again; the messages held for it were delivered.`
          );
        } else if (Date.now() - waiting.since >= HELD_DISCLOSURE_MS) {
          waiting.since = Date.now();
          console.warn(
            `Room ${roomId} still has no session to take its messages; ${waiting.events.length} message(s) are held and will be delivered when one can.`
          );
        }
      }
    };
    // What was held when the last watcher stopped is picked up from the journal,
    // which kept the events themselves: nothing else did.
    for (const pendingEvent of assignments.pending()) {
      const waiting = held.get(pendingEvent.roomId);
      if (waiting) waiting.events.push(pendingEvent);
      else {
        held.set(pendingEvent.roomId, { events: [pendingEvent], since: Date.now() });
        console.warn(
          `Room ${pendingEvent.roomId} was still waiting for a session when this controller last stopped; its messages are held until one can take them.`
        );
      }
    }
    if (held.size) await resolveHeld();
    if (spawn) await launchAssigned();
    const stream = new SwitchEventStream({
      creds: {
        agentId: credentials.SWITCH_AGENT_ID,
        apiEndpoint: credentials.SWITCH_API_ENDPOINT,
        token: credentials.SWITCH_API_TOKEN,
      },
      connectionId,
      scope: 'all',
      filter: 'addressed',
      spawnCapable: spawn,
      rooms: [],
      startCursor: assignments.cursor || undefined,
      signal: stop.signal,
      log: console,
      onApprovalOutcome: async (outcome) => {
        await askSession(outcome.session_id, { type: 'approvals' }, 'an approval answer');
      },
      // A room control (!reset, !interrupt) typed in one of the agent's rooms,
      // which only Switch sees. Handed to the session's host like any other.
      onSessionCommand: async (command) => {
        const taken = await askSession(
          command.sessionId,
          { type: 'command', command },
          `command ${command.commandId}`
        );
        if (!taken)
          console.warn(
            `Dropped command ${command.commandId}: session ${command.sessionId} is not running here.`
          );
      },
      onEvent: (event) => {
        // Read as the event arrives rather than when its turn comes: what is
        // done with it follows the setting it was delivered under, and work
        // queued ahead of it can take long enough for that to change.
        const spawning = spawn;
        pending = pending.then(async () => {
          const messageId = roomInputId(event);
          if (!messageId) return;
          const assignment: Handoff = {
            sequence: z.number().int().positive().parse(event.sequence),
            roomId: event.room_id,
            messageId,
            // The session builds its prompt from this; nothing else keeps it.
            event: { type: event.type, payload: event.payload, missed: event.missed ?? null },
          };
          const placed = event.session_id ?? null;
          // The connection is this agent's reachability; starting a session is
          // a separate permission it may not have. Without it a session that
          // already serves the room is still served — it has no connection of
          // its own to hear on — and a room with none goes unanswered. What a
          // room is told follows the agent's profile rather than this
          // declaration, so whoever sets the profile that promises a session is
          // the one keeping that honest.
          // Asked again here as well as on the timer: the answer a held room is
          // waiting for is written by a session that is doing other work, and
          // an event arriving is the cheapest evidence that time has passed.
          if (held.size) await resolveHeld();
          if (held.has(assignment.roomId)) return hold(assignment, spawning);
          if (placed && (await routePlaced(placed, assignment))) return;
          if (!(await admit(assignment, spawning, false))) await hold(assignment, spawning);
        });
        return pending.catch((error: Error) => {
          fail(error);
          throw error;
        });
      },
      // A gap is terminal for a session host, which has context to re-read. The
      // watcher has none: the events it missed are gone from the server, and
      // the sessions it starts read room context themselves. Stopping here
      // would end auto-start until someone deleted this journal by hand — and
      // a server restart resets the numbering, so it would happen again on
      // every reconnect.
      onGap: (gap) => {
        console.warn(
          `Shared SDK watcher delivery gap: ${gap.reason}. Resuming from the server's current position; rooms addressed during the gap must be re-addressed to start a session.`
        );
        if (!gap.cursorReset) return;
        pending = pending.then(() => assignments.restart());
        return pending.catch((error: Error) => {
          fail(error);
          throw error;
        });
      },
      onEvicted: ({ code, reason }) => {
        if (code === EVICTION_HEARTBEAT_LAPSED) {
          console.warn('Watcher heartbeat lapsed; reconnecting from the saved cursor.');
          return;
        }
        if (code === EVICTION_TAKEN_OVER) {
          // Not a failure: something else is now this agent's controller, and
          // it is entitled to be. Recorded and exited cleanly, so the
          // supervisor does not treat standing down as a crash to restart.
          console.warn(
            `Shared SDK watcher was taken over (${reason}); standing down until restarted.`
          );
          pending = pending.then(() =>
            recordTakenOver(root, {
              at: new Date().toISOString(),
              reason,
              connectionId,
            })
          );
          void pending.then(
            () => stop.abort(),
            (error: Error) => fail(error)
          );
          return;
        }
        fail(new Error(`Shared SDK watcher was evicted: ${reason}`));
      },
    });
    stream.start();
    // Queued behind the events rather than run beside them: the decision it
    // takes is the same one the handler takes, and two of them at once could
    // start a session for a room the other has just found an owner for.
    retry = setInterval(() => {
      if (!held.size) return;
      pending = pending.then(resolveHeld);
      void pending.catch((error: Error) => fail(error));
    }, OWNERSHIP_RETRY_MS);
    retry.unref();
    while (!stop.signal.aborted) {
      const changed = await awaitWatchChange(root, flags, stop.signal);
      if (!changed || !changed.enabled) break;
      flags = changed;
      spawn = flags.spawn;
      stream.setSpawnCapable(spawn);
      // What waited for permission to start a session is answered now rather
      // than on the next retry, and so is a session this controller was
      // already assigned and could not start.
      if (spawn) {
        pending = pending.then(resolveHeld);
        await pending;
        await launchAssigned();
      }
    }
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    stop.abort();
    if (retry) clearInterval(retry);
    signal.removeEventListener('abort', abort);
    await pending.catch(() => {});
    await releaseOwner(root, ownerPath, owner);
  }
  if (fault) throw fault;
}

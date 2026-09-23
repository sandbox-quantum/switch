import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EVICTION_HEARTBEAT_LAPSED,
  EVICTION_TAKEN_OVER,
  RoomAdmissionError,
  SwitchEventStream,
  SwitchRoomAdmissions,
  type RoomAdmission,
  type RoomReservation,
} from '@sandboxaq/switch-agent-runtime';
import { z } from 'zod';
import { declareHandoffCapability, handOff, readsHandoffs, type Handoff } from './handoff';
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
import { readSharedCredentials, sharedConfigSchema, type SharedHostConfig } from './shared-config';
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

/**
 * How often a room whose owner is undecided is asked about again. The same
 * cadence a session re-asserts its binding on, which is what the answer is
 * waiting for.
 */
const OWNERSHIP_RETRY_MS = 5000;

/** How often a room still waiting for an owner says so again. */
const HELD_DISCLOSURE_MS = 30000;

/**
 * How often the deliveries Switch is still holding are asked for.
 *
 * Slower than the retry above because it is not what makes a delivery
 * prompt — the event itself is — but what catches the ones no longer on any
 * local list: routed to a session that lost the room before it submitted, or
 * routed by a controller that has since restarted.
 */
const RESERVATION_SWEEP_MS = 30000;

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

/** How long a carry waits between attempts, before giving the watcher up. */
const CARRY_RETRY_MS = [1000, 3000, 9000];

/**
 * Has Switch record which of this agent's sessions is serving which room,
 * while the sessions that serve themselves are still doing so.
 *
 * A session started by a build that gave every session a connection of its own
 * holds its room on that connection and nowhere else. Switch knows which — it
 * is the one routing to it — but nothing has written it against the session,
 * so a restart brings the session back holding nothing and the room is
 * answered next by a session that knows none of the conversation. This is
 * where that is written down, and it has to happen before anything replaces
 * those workers: closing the connection is what destroys the evidence.
 *
 * Only one answer lets the upgrade go on: Switch deciding, for every session,
 * what it is serving. Being unreachable is not that answer, and neither is a
 * refusal, a reply that cannot be read, or a session Switch could not place —
 * an upgrade blocked is recoverable and a conversation replaced is not, so all
 * of them stop the watcher instead. Nothing has been replaced at that point:
 * every session is still serving its room exactly as it was before the watcher
 * started, and the next start finds the same evidence intact.
 *
 * Rooms Switch decided against are the exception, and they are the one case
 * that is genuinely decided: another session holds the room, or the agent is no
 * longer in it. Switch has written each of them into the session's own log, so
 * the upgrade goes on and they are named here as well.
 */
export async function carryLegacyRooms(
  admissions: SwitchRoomAdmissions,
  connectionId: string,
  signal: AbortSignal
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let undecided: string;
    try {
      const carried = await admissions.carryRooms(connectionId, signal);
      if (carried.unverifiable.length === 0) {
        for (const session of carried.sessions)
          for (const room of session.refused)
            console.warn(
              `Session ${session.sessionId} was serving room ${room.roomId} over a connection of its own, and Switch would not record the room against it (${room.reason}). The room will be answered by a new session.`
            );
        return;
      }
      undecided = `Switch could not establish what ${carried.unverifiable.join(', ')} is serving`;
    } catch (error) {
      if (!(error instanceof RoomAdmissionError)) throw error;
      if (!error.retryable)
        throw new Error(
          `Switch would not say what this agent's sessions are serving (${error.message}). They are still serving their rooms and have been left alone; the watcher stops here rather than replace them with nothing recorded.`
        );
      undecided = `Switch could not be asked what this agent's sessions are serving (${error.message})`;
    }
    const wait = CARRY_RETRY_MS[attempt];
    if (wait === undefined)
      throw new Error(
        `${undecided}. They are still serving their rooms and have been left alone; the watcher stops here rather than replace them with nothing recorded.`
      );
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, wait);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
    if (signal.aborted)
      throw new Error(
        `${undecided}, and the controller stopped before it could be asked again. The sessions are still serving their rooms and have been left alone.`
      );
  }
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
  pending(): { sequence: number; roomId: string; messageId: string; spawning: boolean }[] {
    const released = this.settled;
    const waiting = new Map<
      string,
      { sequence: number; roomId: string; messageId: string; spawning: boolean }
    >();
    for (const record of this.journal.records) {
      if (!isParked(record)) continue;
      const identity = delivery(record);
      if (released.has(identity) || waiting.has(identity)) continue;
      waiting.set(identity, {
        sequence: record.parked,
        roomId: record.roomId,
        messageId: record.messageId,
        spawning: record.spawning,
      });
    }
    return [...waiting.values()];
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
  async park(
    event: { sequence: number; roomId: string; messageId: string },
    spawning: boolean
  ): Promise<void> {
    await this.journal.append({
      parked: event.sequence,
      roomId: event.roomId,
      messageId: event.messageId,
      spawning,
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
   * Reached only once Switch has said the room is nobody's and granted the
   * right to start one session for it. What that session is called is derived
   * from the delivery, so a controller asking twice about the same message
   * names the same session rather than a second one.
   */
  async assign(
    template: SharedHostConfig,
    event: { sequence: number; roomId: string; messageId: string }
  ): Promise<SharedHostConfig> {
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
    // The right Switch granted, spent on this session's first claim so it is
    // created already holding the room. Kept with the assignment because the
    // launch it belongs to can be interrupted and retried.
    config.grant = { roomId: event.roomId, messageId: event.messageId };
    // Said here rather than left to the worker to say when it starts. The
    // event that caused this session is routed to it before it is started,
    // and the worker it will be started from is this bundle's, which reads
    // what it is handed; waiting for it to say so itself would drop that
    // event, and with it the message the session exists to answer.
    const sessionRoot = sharedSessionRoot(sessionId);
    await mkdir(sessionRoot, { recursive: true });
    await declareHandoffCapability(sessionRoot);
    await this.journal.append({ ...event, config });
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
  let sweeping: NodeJS.Timeout | null = null;
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
    // Which session of this agent holds a room is Switch's answer, not one to
    // be worked out from the session files on this disk: those outlive the
    // sessions that wrote them, and two controllers reading their own have
    // nothing to serialize against.
    const admissions = new SwitchRoomAdmissions({
      agentId: credentials.SWITCH_AGENT_ID,
      apiEndpoint: credentials.SWITCH_API_ENDPOINT,
      token: credentials.SWITCH_API_TOKEN,
    });
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
    /**
     * Starts the session Switch says still holds the room but has no host left
     * running it.
     *
     * A killed worker takes nothing away: its session is unfinished and the
     * room is still its own, so no other session can be started for it and the
     * messages wait for a host that nothing else is going to bring up. Only a
     * restart of that same session ends the wait.
     *
     * The session is the server's answer, never this journal's: the journal
     * says which session was started for a delivery, which is not the same as
     * the one holding the room now. What the journal supplies is the bundle to
     * start it from, and only where that bundle is the host Switch has on
     * record — a session whose host identity has moved on is being run
     * somewhere else, and one this controller has no bundle for is not its
     * session to start. Either way the delivery goes on waiting rather than
     * being answered by a second session for a room that already has one.
     */
    const revive = async (stalled: { sessionId: string; hostId: string }, roomId: string) => {
      const config = assignments
        .sessions()
        .find((saved) => saved.session.sessionId === stalled.sessionId);
      if (!config || config.session.hostId !== stalled.hostId) return;
      if (await liveSupervisor(sharedSessionRoot(stalled.sessionId))) return;
      console.warn(
        `Session ${stalled.sessionId} still holds room ${roomId} but nothing is running it; starting it again from its saved state.`
      );
      await launch(config);
    };
    /**
     * Puts the event in the inbox of the session that serves its room, for a
     * worker that has said it reads one.
     *
     * A worker that has not said so was started by an app that gave every
     * session a connection of its own, and is still serving itself from it.
     * Routing to it would put the event somewhere nothing reads, and an event
     * nobody admits is never committed, so it would be lost in silence rather
     * than refused. Written before the worker is started or woken, so the
     * decision is on disk before anything acts on it.
     */
    const route = async (sessionId: string, event: Handoff): Promise<boolean> => {
      const sessionRoot = sharedSessionRoot(sessionId);
      if (!(await readsHandoffs(sessionRoot))) return false;
      await handOff(sessionRoot, event);
      return true;
    };
    const superseded = await supersededSessions(template.session.agentId, supervision);
    /**
     * Switch is asked only where one of those sessions is serving itself over a
     * connection of its own. The controller's connection is derived from the
     * agent rather than the run, so a session saved by any build that shares
     * one already names this connection and has nothing to carry — and a Switch
     * too old to answer at all would otherwise stop the watcher here, on every
     * upgrade, for a question with no answer to give.
     */
    if (superseded.some(({ config }) => config.roomConnection?.connectionId !== connectionId))
      await carryLegacyRooms(admissions, connectionId, stop.signal);
    await replaceSupersededSessions(superseded, connectionId, supervision);
    const launchAssigned = async () => {
      for (const config of assignments.sessions()) await launch(config);
    };
    /**
     * Rooms whose owner is undecided, and the events waiting on it in the order
     * they arrived.
     *
     * Only the room in question waits. The events of every other room are dealt
     * with as they arrive, and the ones behind a held event keep their place
     * behind it, so a room is never answered out of order.
     */
    const held = new Map<
      string,
      { events: { event: Handoff; spawning: boolean }[]; since: number }
    >();
    /**
     * Deals with the event, or reports that its room's owner is still
     * undecided and it has to wait.
     *
     * The setting is the one the event arrived under rather than the one in
     * force when it is finally admitted: a session started after somebody
     * turned spawning off cannot be taken back, and a room that was promised a
     * session when it was addressed should still get one.
     *
     * A held event is closed by the room and message it names rather than by
     * the position it arrived on, which the server may since have renumbered.
     */
    const admit = async (event: Handoff, spawning: boolean, waiting: boolean): Promise<boolean> => {
      // Recorded before the session is started, because starting it is
      // recoverable — every assigned session is launched again when the
      // watcher restarts — where the routing decision is not.
      const settle = async () => {
        if (waiting) await assignments.released(event);
        else await assignments.handled(event.sequence);
      };
      let answer: RoomAdmission;
      try {
        answer = await admissions.admit({ ...event, spawning }, stop.signal);
      } catch (error) {
        if (!(error instanceof RoomAdmissionError)) throw error;
        if (error.retryable) {
          console.warn(
            `Switch could not be asked which session serves room ${event.roomId}: ${error.message} Message ${event.messageId} is held until it can.`
          );
          return false;
        }
        // Refused for what it is rather than for when it was asked, so asking
        // again answers the same. Held forever it would be a room gone quiet
        // with nothing saying why.
        console.error(
          `Switch will not admit message ${event.messageId} in room ${event.roomId}: ${error.message} It is not being delivered.`
        );
        await settle();
        return true;
      }
      if (answer.status === 'unavailable') {
        if (answer.stalled) await revive(answer.stalled, event.roomId);
        return false;
      }
      if (answer.status === 'owner') {
        if (!(await route(answer.sessionId, event)))
          console.error(
            `Room ${event.roomId} is served by session ${answer.sessionId} on host ${answer.hostId}, which does not read what this controller routes to it; message ${event.messageId} was not handed over. Switch is still holding it.`
          );
        await settle();
        return true;
      }
      const config = await assignments.assign(
        sharedConfigSchema.parse(JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))),
        event
      );
      if (!(await route(config.session.sessionId, event)))
        console.error(
          `Session ${config.session.sessionId} was started for room ${event.roomId} but does not read what this controller routes to it; message ${event.messageId} was not handed over. Switch is still holding it.`
        );
      await settle();
      await launch(config);
      return true;
    };
    /**
     * Has Switch verify and keep a delivery that cannot be routed yet.
     *
     * A message arriving behind one already waiting is answered in its turn,
     * not now — but the copy that answer is finally built from is only made
     * when Switch is asked, and by the time its turn comes the replay buffer
     * holding it can have been trimmed or renumbered. So the asking is done on
     * arrival and the routing is left until later.
     *
     * Asked without the permission to start a session whatever this controller
     * holds: a grant minted for a message that is not at the head of its
     * room's queue would block the one that is.
     *
     * Answers whether the delivery is finished with, as `admit` does. Only a
     * refusal finishes one here; anything else leaves it to wait.
     */
    const reserve = async (event: Handoff): Promise<boolean> => {
      try {
        await admissions.admit({ ...event, spawning: false }, stop.signal);
        return false;
      } catch (error) {
        if (!(error instanceof RoomAdmissionError)) throw error;
        if (error.retryable) {
          console.warn(
            `Switch could not be asked to keep message ${event.messageId} in room ${event.roomId}: ${error.message} It is held on this controller alone until its turn comes.`
          );
          return false;
        }
        console.error(
          `Switch will not keep message ${event.messageId} in room ${event.roomId}: ${error.message} It is not being delivered.`
        );
        await assignments.handled(event.sequence);
        return true;
      }
    };
    const queued = (roomId: string, messageId: string): boolean =>
      held.get(roomId)?.events.some((entry) => entry.event.messageId === messageId) === true;
    const hold = async (event: Handoff, spawning: boolean) => {
      // The server serves a held event again whenever the stream reopens behind
      // it, and this journal holds its own copy; neither is a second message.
      if (queued(event.roomId, event.messageId)) return;
      const waiting = held.get(event.roomId);
      if (waiting) waiting.events.push({ event, spawning });
      else {
        held.set(event.roomId, { events: [{ event, spawning }], since: Date.now() });
        console.warn(
          `Switch has no session of this agent able to take room ${event.roomId}'s messages yet; holding them until one can.`
        );
      }
      await assignments.park(event, spawning);
    };
    /** Re-asks who owns each held room, and answers the ones that now have one. */
    const resolveHeld = async () => {
      for (const [roomId, waiting] of [...held]) {
        while (
          waiting.events.length &&
          (await admit(waiting.events[0]!.event, waiting.events[0]!.spawning, true))
        )
          waiting.events.shift();
        if (!waiting.events.length) {
          held.delete(roomId);
          console.warn(
            `Room ${roomId} is settled again; the messages held for it were dealt with.`
          );
        } else if (Date.now() - waiting.since >= HELD_DISCLOSURE_MS) {
          waiting.since = Date.now();
          console.warn(
            `Room ${roomId} still has no session claiming it; ${waiting.events.length} message(s) are held and will be delivered when one does.`
          );
        }
      }
    };
    /**
     * Re-drives the deliveries Switch is still holding for this agent.
     *
     * Routed is not delivered. The session an event was handed to can lose the
     * room before it submits, or stop before it reads its inbox, and a
     * controller can restart between routing an event and anything admitting
     * it. Switch keeps the verified copy until a session commits it, so this
     * is what finally closes those gaps — and after a restart it is the only
     * thing that does, because nothing local records a delivery that was
     * routed and never committed.
     */
    const sweep = async () => {
      let reservations: RoomReservation[];
      try {
        reservations = await admissions.reservations(stop.signal);
      } catch (error) {
        if (!(error instanceof RoomAdmissionError)) throw error;
        console.warn(`Switch could not be asked what it is still holding: ${error.message}`);
        return;
      }
      for (const reservation of reservations) {
        const { roomId, messageId, sequence } = reservation;
        if (reservation.expired) {
          console.error(
            `Switch stopped promising message ${messageId} in room ${roomId} before any session took it; it is being given up and will not be delivered.`
          );
          try {
            await admissions.discard(reservation, stop.signal);
          } catch (error) {
            if (!(error instanceof RoomAdmissionError)) throw error;
            console.warn(`Switch kept message ${messageId}: ${error.message}`);
            continue;
          }
          await assignments.released(reservation);
          const waiting = held.get(roomId);
          if (!waiting) continue;
          waiting.events = waiting.events.filter((entry) => entry.event.messageId !== messageId);
          if (!waiting.events.length) held.delete(roomId);
          continue;
        }
        // One already waiting locally keeps the permission it arrived under
        // and its place behind the other messages for its room; re-driving it
        // here would answer it out of order and under the wrong one.
        if (queued(roomId, messageId)) continue;
        const event = { roomId, messageId, sequence };
        if (!(await admit(event, spawn, true))) await hold(event, spawn);
      }
    };
    // What was held when the last watcher stopped is picked up from the journal
    // rather than from the server. The stream reopens behind a held event, but
    // that buffer can be trimmed or renumbered while the event waits, and this
    // is the copy that cannot be. Each one keeps the permission it arrived
    // under, not the one this controller started with.
    for (const { spawning, ...event } of assignments.pending()) {
      const waiting = held.get(event.roomId);
      if (waiting) waiting.events.push({ event, spawning });
      else {
        held.set(event.roomId, { events: [{ event, spawning }], since: Date.now() });
        console.warn(
          `Room ${event.roomId} was still waiting for a session to claim it when this controller last stopped; its messages are held until one does.`
        );
      }
    }
    if (held.size) await resolveHeld();
    // Before the stream opens, so a delivery left unadmitted by the controller
    // this one replaces is picked up whether or not the server still has the
    // event in its buffer to serve again.
    await sweep();
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
      onEvent: (event) => {
        // Read as the event arrives rather than when its turn comes: what is
        // done with it follows the setting it was delivered under, and work
        // queued ahead of it can take long enough for that to change.
        const spawning = spawn;
        pending = pending.then(async () => {
          const messageId = roomInputId(event);
          if (!messageId) return;
          const assignment = {
            sequence: z.number().int().positive().parse(event.sequence),
            roomId: event.room_id,
            messageId,
          };
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
          if (held.has(assignment.roomId)) {
            if (await reserve(assignment)) return;
            return hold(assignment, spawning);
          }
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
    sweeping = setInterval(() => {
      pending = pending.then(sweep);
      void pending.catch((error: Error) => fail(error));
    }, RESERVATION_SWEEP_MS);
    sweeping.unref();
    while (!stop.signal.aborted) {
      const changed = await awaitWatchChange(root, flags, stop.signal);
      if (!changed || !changed.enabled) break;
      flags = changed;
      spawn = flags.spawn;
      stream.setSpawnCapable(spawn);
      // The rooms addressed while spawning was off were never journalled, so
      // there is nothing to catch up on — but a session this controller was
      // already assigned and could not start is started now.
      if (spawn) await launchAssigned();
    }
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    stop.abort();
    if (retry) clearInterval(retry);
    if (sweeping) clearInterval(sweeping);
    signal.removeEventListener('abort', abort);
    await pending.catch(() => {});
    await releaseOwner(root, ownerPath, owner);
  }
  if (fault) throw fault;
}

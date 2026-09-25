import { createHash, randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { join } from 'node:path';
import {
  EVICTION_HEARTBEAT_LAPSED,
  EVICTION_LAUNCH_SUPERSEDED,
  EVICTION_TAKEN_OVER,
  SwitchEventStream,
  WORKER_CAPABILITY_OBSOLETE,
} from '@sandboxaq/switch-agent-runtime';
import type { SwitchIdentity } from '@sandboxaq/switch-agent-runtime/hosted';
import { z } from 'zod';
import { WorkerObsoleteError } from './exit-codes';
import type { Handoff } from './handoff';
import {
  type CancelReason,
  FAILED_HOLD_MS,
  type HostedPort,
  type HostedWorker,
  type IdleReason,
  type MailboxAck,
  OperationRefusedError,
  type SessionCounts,
} from './hosted-worker';
import { Journal } from './journal';
import {
  ensureSharedProcess,
  liveSupervisor,
  sharedSessionRoot,
  sharedSessionsBase,
  type Supervision,
} from './launch';
import { releaseOwner, replaceOwner, withOwnershipLock } from './ownership-lock';
import { SessionPlacements } from './placements';
import { roomInputId } from './room-inbox';
import {
  SessionHostFailedError,
  type SessionRequest,
  SessionUnavailableError,
} from './session-channel';
import { readHostSessions } from './session-list';
import { readSharedCredentials, sharedConfigSchema, type SharedHostConfig } from './shared-config';
import { hostParked } from './shared-state';
import { readTakenOver, recordTakenOver } from './taken-over';
import { awaitWatchChange, readWatchFlags } from './watch-flags';
import {
  announceStartFailure,
  type PlaceOutcome,
  sessionToolAnswerer,
  type WatcherControl,
  type WatcherState,
} from './watcher-tools';

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
  // Offered from Switch's mailbox rather than the stream: its sequence is no
  // position in the stream's numbering.
  wake: z.literal(true).optional(),
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
    // Why it was dealt with without reaching a session; absent when a session took it.
    reason: z.string().min(1).optional(),
  }),
});
const mailboxAckSchema = z.strictObject({
  roomId: z.string().min(1),
  messageId: z.string().min(1),
  outcome: z.enum(['journaled', 'admitted', 'duplicate', 'refused', 'held', 'cancelled']),
  reason: z.string().min(1).optional(),
});
/** A hosted worker's mailbox ack, owed to Switch until it is confirmed. */
const ackOwedSchema = z.strictObject({ mailboxAck: mailboxAckSchema });
const ackConfirmedSchema = z.strictObject({ mailboxAcked: mailboxAckSchema });
const recordSchema = z.union([
  assignmentSchema,
  restartSchema,
  handledSchema,
  parkedSchema,
  releasedSchema,
  ackOwedSchema,
  ackConfirmedSchema,
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
  return 'config' in record;
}

const ackKey = (ack: MailboxAck): string =>
  JSON.stringify([ack.roomId, ack.messageId, ack.outcome]);

const delivery = (event: { roomId: string; messageId: string }): string =>
  JSON.stringify([event.roomId, event.messageId]);

/** How often a room with no session to take its messages is looked at again. */
const OWNERSHIP_RETRY_MS = 5000;

/** How long a message waits for its session's host to start and take it. */
const HOST_START_MS = 120000;

/** How often a room still waiting for an owner says so again. */
const HELD_DISCLOSURE_MS = 30000;

/** The thread a room message was posted in, or null for a top-level one. */
function threadOf(event: unknown): string | null {
  const parsed = z
    .object({ payload: z.object({ thread_id: z.string().min(1).nullish() }) })
    .safeParse(event);
  return parsed.success ? (parsed.data.payload.thread_id ?? null) : null;
}

/** A new session of the agent `template` configures, called `sessionId`. */
function sessionFrom(template: SharedHostConfig, sessionId: string): SharedHostConfig {
  const config = structuredClone(template);
  config.session = { ...config.session, sessionId, hostId: randomUUID(), epoch: randomUUID() };
  config.start.input.sessionId = sessionId;
  if (config.start.input.env.SWITCHDASH_SESSION_ID !== undefined)
    config.start.input.env.SWITCHDASH_SESSION_ID = sessionId;
  delete config.start.input.resume;
  delete config.grant;
  return config;
}

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

/**
 * Stops each session still running a superseded build. It is not started
 * again here: like every session, it starts under this build when it is next
 * needed (a room message, a command, or someone opening it).
 */
export async function stopSupersededSessions(
  superseded: { root: string; config: SharedHostConfig }[],
  supervision: Supervision
): Promise<void> {
  for (const { root, config } of superseded) {
    console.warn(
      `Session ${config.session.sessionId} is running a superseded build; stopping it until it is next needed.`
    );
    await supervision.stop(root);
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
      else if (isParked(record)) {
        if (!record.wake) parked.set(record.parked, delivery(record));
      }
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
   * Which session each room was last assigned to, one room per session: what
   * a watcher that predates `placements.json` routed by, and so what its
   * placements start from.
   */
  placements(): [sessionId: string, roomId: string][] {
    const rooms = new Map<string, string>();
    for (const record of this.every) {
      const sessionId = record.config.session.sessionId;
      for (const [placed, roomId] of rooms) if (roomId === record.roomId) rooms.delete(placed);
      rooms.set(sessionId, record.roomId);
    }
    return [...rooms];
  }

  /** Records that the event has been routed, or decided not to be. */
  async handled(sequence: number): Promise<void> {
    await this.journal.append({ handled: sequence });
  }

  /**
   * Records that a held event has been routed, or, with a `reason`, decided
   * not to be.
   */
  async released(
    event: { roomId: string; messageId: string },
    reason: string | null
  ): Promise<void> {
    await this.journal.append({
      released: {
        roomId: event.roomId,
        messageId: event.messageId,
        ...(reason === null ? {} : { reason }),
      },
    });
  }

  /** Records that the event is waiting for its room's owner to be decided. */
  async park(event: Handoff, spawning: boolean, wake: boolean): Promise<void> {
    await this.journal.append({
      parked: event.sequence,
      roomId: event.roomId,
      messageId: event.messageId,
      spawning,
      ...(event.event === undefined ? {} : { event: event.event }),
      ...(wake ? { wake: true as const } : {}),
    });
  }

  /** Whether this delivery was already journaled here, whatever came of it. */
  known(event: { roomId: string; messageId: string }): boolean {
    const identity = delivery(event);
    return this.journal.records.some(
      (record) =>
        (isParked(record) && delivery(record) === identity) ||
        (isReleased(record) && delivery(record.released) === identity)
    );
  }

  /**
   * What became of a delivery: still journaled and waiting, released (to a
   * session when `reason` is null), or unknown here.
   */
  deliveryState(event: {
    roomId: string;
    messageId: string;
  }): { state: 'journaled' } | { state: 'released'; reason: string | null } | { state: 'unknown' } {
    const identity = delivery(event);
    const released = this.journal.records.find(
      (record) => isReleased(record) && delivery(record.released) === identity
    );
    if (released && isReleased(released))
      return { state: 'released', reason: released.released.reason ?? null };
    return this.known(event) ? { state: 'journaled' } : { state: 'unknown' };
  }

  async recordAck(ack: MailboxAck): Promise<void> {
    await this.journal.append({ mailboxAck: ack });
  }

  /** Acks owed to Switch that it has not confirmed, oldest first. */
  unconfirmedAcks(): MailboxAck[] {
    const owed = new Map<string, MailboxAck>();
    for (const record of this.journal.records)
      if ('mailboxAck' in record) owed.set(ackKey(record.mailboxAck), record.mailboxAck);
      else if ('mailboxAcked' in record) owed.delete(ackKey(record.mailboxAcked));
    return [...owed.values()];
  }

  async confirmAcks(acks: MailboxAck[]): Promise<void> {
    for (const ack of acks) await this.journal.append({ mailboxAcked: ack });
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
    const sessionId = sessionIdFor(template.session.agentId, event.roomId, event.messageId);
    const config = sessionFrom(template, sessionId);
    await mkdir(sharedSessionRoot(sessionId), { recursive: true });
    await this.journal.append({
      sequence: event.sequence,
      roomId: event.roomId,
      messageId: event.messageId,
      config,
    });
    return config;
  }

  /** The config this journal assigned a session under, or null if it assigned none. */
  configOf(sessionId: string): SharedHostConfig | null {
    return (
      this.every.filter((record) => record.config.session.sessionId === sessionId).at(-1)?.config ??
      null
    );
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
  supervision: Supervision,
  control: WatcherControl,
  hosted: HostedWorker | null
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
  const unbind: (() => void)[] = [];
  const fail = (error: Error) => {
    fault = error;
    stop.abort(error);
  };
  /** What the watcher reports once it has stopped, unless it stopped on an error. */
  let ending: { state: WatcherState; detail: string | null } = {
    state: 'not-running',
    detail: null,
  };
  let thrown: unknown = null;
  try {
    if (!template.execution || !template.roomConnection)
      throw new Error('Shared watcher requires execution credentials and a connection identity.');
    const connectionId = template.roomConnection.connectionId;
    let flags = await readWatchFlags(root);
    if (!flags.enabled) {
      ending = { state: 'disabled', detail: null };
      return;
    }
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
      ending = { state: 'taken-over', detail: displaced.reason };
      return;
    }
    const credentials = await readSharedCredentials(template);
    const assignments = await SharedWatchAssignments.open(root);
    const links = supervision.links;
    if (!links)
      throw new Error(
        'The room watcher needs to be the parent of its sessions to talk to them; it was given a supervision that starts them detached.'
      );
    const agentId = template.session.agentId;
    const identity: SwitchIdentity = {
      endpoint: credentials.SWITCH_API_ENDPOINT,
      agentId: credentials.SWITCH_AGENT_ID,
      token: credentials.SWITCH_API_TOKEN,
    };
    const placements = await SessionPlacements.open(root, () => assignments.placements());
    control.report({ state: 'connecting', detail: null, placements: placements.snapshot() });
    unbind.push(placements.onChange((map) => control.report({ placements: map })));
    let stream: SwitchEventStream | null = null;
    let publishing: Promise<void> = Promise.resolve();
    /**
     * Tells Switch where every session is, replacing what it held: after each
     * change here and whenever the stream reconnects, since Switch keeps
     * placements in memory only. Nothing to say before the stream exists; its
     * first open says it.
     */
    const publish = (): Promise<void> => {
      const run = async () => {
        await stream?.replacePlacements(placements.snapshot());
      };
      publishing = publishing.then(run, run);
      return publishing;
    };
    const publishQuietly = () => {
      void publish().catch((error: unknown) => {
        console.warn(
          `Switch did not take this agent's session placements: ${error instanceof Error ? error.message : String(error)}. They are stated again on the next change or reconnect.`
        );
      });
    };
    /**
     * One of this agent's sessions here: its saved config, or the one this
     * watcher assigned it under when its host has not written one yet. Null
     * when it is neither.
     */
    const sessionConfig = async (sessionId: string): Promise<SharedHostConfig | null> => {
      let saved: SharedHostConfig;
      try {
        saved = sharedConfigSchema.parse(
          JSON.parse(await readFile(join(sharedSessionRoot(sessionId), 'config.json'), 'utf8'))
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return assignments.configOf(sessionId);
        throw error;
      }
      return saved.session.agentId === agentId ? saved : null;
    };
    // Before any session is started below: a host asks for its tools as soon
    // as its provider comes up.
    unbind.push(
      links.answer(agentId, sessionToolAnswerer({ identity, connectionId, placements, publish }))
    );
    // A host coming up — started from Console after it failed, say — takes
    // the messages that waited for it.
    unbind.push(
      links.onReady((readyRoot) => {
        for (const [sessionId, entry] of pumps) {
          if (sharedSessionRoot(sessionId) !== readyRoot) continue;
          if (entry.failed === null) continue;
          console.warn(
            `Session ${sessionId} is running again; handing it the ${entry.queue.length} room message(s) that waited for it.`
          );
          entry.failed = null;
          entry.failedAt = null;
          pump(entry.config);
        }
      })
    );
    unbind.push(
      links.onExit((_root, exited) => {
        if (!exited || exited.agentId !== agentId) return;
        pending = pending.then(async () => {
          if (placements.roomOf(exited.sessionId) === null) return;
          if (!(await stopped(exited.sessionId))) return;
          const roomId = await placements.unplace(exited.sessionId);
          console.warn(
            `Session ${exited.sessionId} was stopped, so room ${roomId} has no session attending it now.`
          );
          publishQuietly();
        });
        void pending.catch((error: Error) => fail(error));
      })
    );
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
    await stopSupersededSessions(superseded, supervision);
    /**
     * Rooms with no session able to take their messages yet, and the events
     * waiting in the order they arrived. Only the room in question waits; the
     * ones behind a held event keep their place behind it, so a room is never
     * answered out of order.
     */
    const held = new Map<string, { events: Held[]; since: number }>();
    /**
     * Ask the host of one of this agent's sessions, if it runs here. False
     * when it is not this agent's, or nothing is running it.
     */
    const askSession = async (sessionId: string, request: SessionRequest, what: string) => {
      const sessionRoot = sharedSessionRoot(sessionId);
      if (!(await sessionConfig(sessionId))) return false;
      try {
        await links.request(sessionRoot, request, 0);
        return true;
      } catch (error) {
        console.warn(`Could not pass ${what} to session ${sessionId}: ${String(error)}`);
        return false;
      }
    };
    /**
     * The room messages already answered with a start failure: each message
     * that runs into it is answered once, however often the host is retried.
     */
    const announced = new Set<string>();
    const announce = async (config: SharedHostConfig, event: Handoff, failure: string) => {
      const sessionId = config.session.sessionId;
      const key = `${sessionId}:${event.roomId}:${event.messageId}`;
      if (announced.has(key)) return;
      announced.add(key);
      try {
        if (hosted) {
          await hosted.notice({
            roomId: event.roomId,
            messageId: event.messageId,
            threadId: threadOf(event.event),
            reason: 'startup',
          });
          return;
        }
        // Switch answers the call from where it holds the session placed.
        await publish();
        await announceStartFailure({
          identity,
          connectionId,
          session: config.session,
          root: sharedSessionRoot(sessionId),
          cwd: config.start.input.cwd,
          threadId: threadOf(event.event),
          failure,
        });
      } catch (error) {
        console.error(
          `Could not tell room ${event.roomId} that session ${sessionId} failed to start (${failure}): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    };
    /**
     * Per session, the messages handed to it and not yet acknowledged, sent
     * down the IPC pipe one at a time and in order. Each is parked in the
     * journal first and released on the host's acknowledgement, so one this
     * controller dies holding is routed again when it restarts.
     *
     * `failed` is set when the host stopped on a failure it recorded: the
     * messages stay queued and the host is not started again until something
     * changes — another room message for it, or its host coming up because
     * somebody started it from Console.
     */
    type Pump = {
      queue: Handoff[];
      running: boolean;
      failed: string | null;
      /** When a hosted worker posted the failure, which starts its bounded hold. */
      failedAt: number | null;
      /** The queued messages already acked `held` to Switch. */
      heldAcked: Set<string>;
      config: SharedHostConfig;
    };
    const pumps = new Map<string, Pump>();
    const ack = async (
      event: { roomId: string; messageId: string },
      outcome: MailboxAck['outcome'],
      reason: string | null
    ) => {
      await hosted?.ack({
        roomId: event.roomId,
        messageId: event.messageId,
        outcome,
        ...(reason === null ? {} : { reason }),
      });
    };
    /** When a failed host's hold ends, Switch stops counting its queued messages. */
    const endHold = (entry: Pump, failedAt: number) => {
      pending = pending.then(async () => {
        if (entry.failedAt !== failedAt) return;
        for (const event of entry.queue) {
          if (entry.heldAcked.has(event.messageId)) continue;
          entry.heldAcked.add(event.messageId);
          await ack(event, 'held', null);
        }
        hosted?.changed();
      });
      void pending.catch((error: Error) => fail(error));
    };
    const pump = (config: SharedHostConfig) => {
      const sessionId = config.session.sessionId;
      const entry = pumps.get(sessionId)!;
      if (entry.running || entry.failed !== null) return;
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
            entry.heldAcked.delete(event.messageId);
            pending = pending.then(async () => {
              await assignments.released(event, null);
              await ack(event, 'admitted', null);
            });
            await pending;
            hosted?.changed();
          } catch (error) {
            if (error instanceof SessionHostFailedError) {
              entry.failed = error.failure;
              console.error(
                `Session ${sessionId} could not start: ${error.failure} Its ${entry.queue.length} room message(s) stay queued; it is started again when the room next addresses the agent or the session is restarted from Console.`
              );
              // Answer the newest message: it is the one somebody just sent.
              const announcing = announce(config, entry.queue.at(-1) ?? event, error.failure);
              if (hosted)
                void announcing.then(() => {
                  const failedAt = Date.now();
                  entry.failedAt = failedAt;
                  hosted.changed();
                  setTimeout(() => endHold(entry, failedAt), FAILED_HOLD_MS).unref();
                });
              break;
            }
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
      if (!waiting) await assignments.park(event, false, false);
      const entry = pumps.get(sessionId) ?? {
        queue: [],
        running: false,
        failed: null,
        failedAt: null,
        heldAcked: new Set<string>(),
        config,
      };
      pumps.set(sessionId, entry);
      entry.config = config;
      const fresh = !entry.queue.some((queuedEvent) => queuedEvent.messageId === event.messageId);
      if (fresh) entry.queue.push(event);
      // A host that failed to start is tried once more for each new message,
      // since whatever stopped it may have been fixed since.
      if (entry.failed !== null) {
        if (!fresh) return true;
        console.warn(
          `Room ${event.roomId} addressed the agent again; starting session ${sessionId} again after it failed (${entry.failed}).`
        );
        entry.failed = null;
        entry.failedAt = null;
      }
      if (!links.ready(sessionRoot)) await launch(config);
      pump(config);
      return true;
    };
    /**
     * Routes the event to the session placed in its room. A room whose session
     * was stopped, or is not this agent's here, loses its placement, and then
     * gets a new session where this controller may start one. False when
     * neither can be done yet and the event has to wait.
     *
     * The permission is the one the event arrived under rather than the one in
     * force when it is finally admitted: a room that was promised a session
     * when it was addressed should still get one.
     */
    /** A hosted worker's answer to a message it will not act on. */
    const refuse = async (event: Handoff, reason: 'capacity' | 'revoked' | 'auto_start_off') => {
      await assignments.released(event, reason);
      await ack(event, 'refused', reason);
      await hosted?.notice({
        roomId: event.roomId,
        messageId: event.messageId,
        threadId: threadOf(event.event),
        reason,
      });
    };
    const admit = async (event: Handoff, spawning: boolean, waiting: boolean): Promise<boolean> => {
      if (hosted?.revoked) {
        await refuse(event, 'revoked');
        return true;
      }
      const placed = placements.sessionIn(event.roomId);
      if (placed) {
        const owner = await sessionConfig(placed);
        if (owner && !(await stopped(placed))) {
          await deliver(owner, event, waiting);
          return true;
        }
        await placements.unplace(placed);
        publishQuietly();
        console.warn(
          `Session ${placed} ${owner ? 'was stopped' : 'is not one of this agent’s sessions here'}, so room ${event.roomId} has no session attending it now.`
        );
      }
      if (!spawning) {
        // A hosted room with no session and no permission to start one would
        // hold its worker awake for good.
        if (!hosted) return false;
        await refuse(event, 'auto_start_off');
        return true;
      }
      if (hosted) {
        const limit = hosted.limit;
        if (limit === null)
          throw new Error('A hosted watcher admitted a message before it attached.');
        const existing = sessionIdFor(agentId, event.roomId, event.messageId);
        if (!(await sessionConfig(existing)) && (await sessionCounts()).active >= limit) {
          console.warn(
            `Room ${event.roomId} addressed the agent, but it already has ${limit} active session(s); refusing message ${event.messageId}.`
          );
          await refuse(event, 'capacity');
          return true;
        }
      }
      const config = await assignments.assign(
        sharedConfigSchema.parse(JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))),
        event
      );
      await placements.place(config.session.sessionId, event.roomId);
      publishQuietly();
      await deliver(config, event, waiting);
      return true;
    };
    const queued = (roomId: string, messageId: string): boolean =>
      held.get(roomId)?.events.some((entry) => entry.messageId === messageId) === true;
    const hold = async (event: Handoff, spawning: boolean, parked: boolean) => {
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
      if (!parked) await assignments.park(event, spawning, false);
    };
    /**
     * A hosted delivery, from the stream or the mailbox alike: journaled and
     * acknowledged before it is routed, and recognised by room and message
     * when it comes again.
     */
    const accept = async (event: Handoff, spawning: boolean, wake: boolean) => {
      if (assignments.known(event)) {
        await ack(event, 'duplicate', null);
        return;
      }
      await assignments.park(event, spawning, wake);
      await ack(event, 'journaled', null);
      if (held.size) await resolveHeld();
      if (held.has(event.roomId) || !(await admit(event, spawning, true)))
        await hold(event, spawning, true);
      hosted?.changed();
    };
    /** This agent's sessions here, as the idle report and the session limit count them. */
    const sessionCounts = async (): Promise<SessionCounts> => {
      const running = new Set(links.live());
      const counts = { total: 0, live: 0, parked: 0, failed: 0, active: 0 };
      for (const listed of readHostSessions(nodeFs, nodePath, agentId, sharedSessionsBase())) {
        const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(listed.session);
        const sessionRoot = sharedSessionRoot(sessionId);
        const alive = listed.alive || running.has(sessionRoot);
        const parked = !alive && !listed.stopped && (await hostParked(sessionRoot));
        counts.total += 1;
        if (alive && !listed.stopped) counts.live += 1;
        if (parked) counts.parked += 1;
        if (links.failure(sessionRoot) !== null) counts.failed += 1;
        if (!listed.stopped && (alive || parked)) counts.active += 1;
      }
      return counts;
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
    // A hosted watcher admits nothing from its journal until it has heard
    // which of those deliveries Switch cancelled while it was away.
    const admitting = () => hosted === null || hosted.reconciled;
    if (held.size && admitting()) await resolveHeld();
    const port: HostedPort = {
      serial: <T>(work: () => Promise<T>): Promise<T> => {
        const run = pending.then(work);
        pending = run.then(
          () => {},
          () => {}
        );
        return run;
      },
      reasons: (): IdleReason[] => {
        const reasons: IdleReason[] = [];
        const now = Date.now();
        for (const [sessionId, entry] of pumps) {
          if (!entry.queue.length) continue;
          if (entry.failed === null)
            reasons.push({
              kind: 'room_pending',
              session_id: sessionId,
              count: entry.queue.length,
            });
          else if (entry.failedAt === null || now - entry.failedAt < FAILED_HOLD_MS)
            reasons.push({
              kind: 'failed_holding',
              session_id: sessionId,
              count: entry.queue.length,
            });
        }
        for (const waiting of held.values())
          reasons.push({ kind: 'room_pending', session_id: null, count: waiting.events.length });
        return reasons;
      },
      sessions: sessionCounts,
      wake: async (entry) => {
        const event = z
          .object({ type: z.string(), payload: z.unknown(), missed: z.unknown().optional() })
          .parse(entry.event);
        await accept(
          {
            sequence: Math.max(1, assignments.cursor),
            roomId: entry.room_id,
            messageId: entry.message_id,
            event: { type: event.type, payload: event.payload, missed: event.missed ?? null },
          },
          spawn,
          true
        );
      },
      cancel: async (entries: { roomId: string; messageId: string; reason: CancelReason }[]) => {
        for (const entry of entries) {
          const known = assignments.deliveryState(entry);
          if (known.state === 'released') {
            if (known.reason === null) await ack(entry, 'admitted', null);
            else await ack(entry, 'cancelled', entry.reason);
            continue;
          }
          if (known.state === 'journaled') {
            const inFlight = [...pumps.values()].some(
              (pumpEntry) => pumpEntry.running && pumpEntry.queue[0]?.messageId === entry.messageId
            );
            // Already on its way to the host: the host's answer settles it.
            if (inFlight) continue;
            const waiting = held.get(entry.roomId);
            if (waiting) {
              waiting.events = waiting.events.filter(
                (event) => event.messageId !== entry.messageId
              );
              if (!waiting.events.length) held.delete(entry.roomId);
            }
            for (const pumpEntry of pumps.values())
              pumpEntry.queue = pumpEntry.queue.filter(
                (event) => event.roomId !== entry.roomId || event.messageId !== entry.messageId
              );
            await assignments.released(entry, entry.reason);
          }
          await ack(entry, 'cancelled', entry.reason);
        }
        if (held.size) await resolveHeld();
        hosted?.changed();
      },
      operate: async (operation, limit) => {
        const sessionRoot = sharedSessionRoot(operation.sessionId);
        if (operation.action === 'start') {
          try {
            await stat(sessionRoot);
            throw new OperationRefusedError('already exists');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          if ((await sessionCounts()).active >= limit)
            throw new OperationRefusedError('session limit');
          const config = sessionFrom(
            sharedConfigSchema.parse(JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))),
            operation.sessionId
          );
          await ensureSharedProcess({
            root: sessionRoot,
            config: reachableBy(config, connectionId),
            resuming: false,
            watcher: false,
            restart: false,
            supervision,
          });
          return;
        }
        let saved: SharedHostConfig;
        try {
          saved = sharedConfigSchema.parse(
            JSON.parse(await readFile(join(sessionRoot, 'config.json'), 'utf8'))
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            throw new OperationRefusedError('not found');
          throw error;
        }
        if (saved.session.agentId !== agentId) throw new OperationRefusedError('not found');
        if ((await stopped(operation.sessionId)) && (await sessionCounts()).active >= limit)
          throw new OperationRefusedError('session limit');
        await ensureSharedProcess({
          root: sessionRoot,
          config: reachableBy(saved, connectionId),
          resuming: true,
          watcher: false,
          restart: true,
          supervision,
        });
      },
      revoke: async () => {
        for (const sessionRoot of links.live()) await supervision.stop(sessionRoot);
      },
      restart: (sessionRoot) =>
        port.serial(async () => {
          const saved = sharedConfigSchema.parse(
            JSON.parse(await readFile(join(sessionRoot, 'config.json'), 'utf8'))
          );
          await ensureSharedProcess({
            root: sessionRoot,
            config: reachableBy(saved, connectionId),
            resuming: true,
            watcher: false,
            restart: true,
            supervision,
          });
        }),
      acks: assignments,
      fail,
    };
    stream = new SwitchEventStream({
      creds: {
        agentId: credentials.SWITCH_AGENT_ID,
        apiEndpoint: credentials.SWITCH_API_ENDPOINT,
        token: credentials.SWITCH_API_TOKEN,
      },
      connectionId,
      worker: hosted?.identity ?? null,
      ...(hosted
        ? {
            onWorkerFrame: (name, data) =>
              hosted.frame(name, data).catch((error: unknown) => {
                fail(error instanceof Error ? error : new Error(String(error)));
                throw error;
              }),
          }
        : {}),
      scope: 'all',
      filter: 'addressed',
      spawnCapable: spawn,
      rooms: [],
      startCursor: assignments.cursor || undefined,
      signal: stop.signal,
      log: console,
      onConnected: () => {
        control.report({ state: 'connected', detail: null });
        publishQuietly();
      },
      onDisconnected: ({ error }) => control.report({ state: 'disconnected', detail: error }),
      // Another connection of this agent took the room: whichever session
      // attended it here no longer does.
      onRoomReleased: async ({ roomId, sessionId }) => {
        pending = pending.then(async () => {
          const lost = await placements.roomLost(roomId);
          if (lost === null) return;
          console.warn(
            `Room ${roomId} was taken over by another connection of this agent${sessionId && sessionId !== lost ? ` (Switch named session ${sessionId})` : ''}; session ${lost} here no longer attends it.`
          );
          publishQuietly();
        });
        return pending.catch((error: Error) => {
          fail(error);
          throw error;
        });
      },
      onApprovalOutcome: async (outcome) => {
        await askSession(outcome.session_id, { type: 'approvals' }, 'an approval answer');
      },
      // A room control (!reset, !interrupt) typed in one of the agent's rooms,
      // which only Switch sees. Handed to the session's host like any other.
      onSessionCommand: async (relayed) => {
        const { requesterName, ...command } = relayed;
        const taken = await askSession(
          command.sessionId,
          {
            type: 'command',
            command,
            requesterName: typeof requesterName === 'string' ? requesterName : null,
          },
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
          if (hosted) return accept(assignment, spawning, false);
          if (held.size) await resolveHeld();
          if (held.has(assignment.roomId)) return hold(assignment, spawning, false);
          if (!(await admit(assignment, spawning, false))) await hold(assignment, spawning, false);
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
          ending = { state: 'taken-over', detail: reason };
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
        if (code === EVICTION_LAUNCH_SUPERSEDED || code === WORKER_CAPABILITY_OBSOLETE) {
          fail(new WorkerObsoleteError(reason));
          return;
        }
        fail(new Error(`Shared SDK watcher was evicted: ${reason}`));
      },
    });
    const started = stream;
    if (hosted) unbind.push(hosted.bind(started, port));
    started.start();
    unbind.push(
      control.bind({
        forget: async (sessionId) => {
          const entry = pumps.get(sessionId);
          if (entry) {
            entry.queue.length = 0;
            pumps.delete(sessionId);
          }
          if (await placements.unplace(sessionId)) publishQuietly();
          const sessionRoot = sharedSessionRoot(sessionId);
          await supervision.stop(sessionRoot);
          await rm(sessionRoot, { recursive: true, force: true });
          console.warn(
            `Session ${sessionId} was deleted; its rooms start a new session next time.`
          );
        },
        place: async (sessionId, roomId): Promise<PlaceOutcome> => {
          if (!(await sessionConfig(sessionId)))
            throw new Error(`Session ${sessionId} is not one of this agent's sessions here.`);
          if (await stopped(sessionId))
            throw new Error(
              `Session ${sessionId} was stopped; start it before moving a room to it.`
            );
          const before = placements.snapshot();
          const moved = await placements.place(sessionId, roomId);
          try {
            await publish();
          } catch (error) {
            await placements.restore(before);
            throw new Error(
              `Switch refused to move room ${roomId} to session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          if (moved.displaced)
            console.warn(
              `Room ${roomId} moved from session ${moved.displaced} to session ${sessionId}.`
            );
          return { sessionId, roomId, ...moved };
        },
      })
    );
    // Queued behind the events rather than run beside them: the decision it
    // takes is the same one the handler takes, and two of them at once could
    // start a session for a room the other has just found an owner for.
    retry = setInterval(() => {
      if (!held.size || !admitting()) return;
      pending = pending.then(resolveHeld);
      void pending.catch((error: Error) => fail(error));
    }, OWNERSHIP_RETRY_MS);
    retry.unref();
    while (!stop.signal.aborted) {
      const changed = await awaitWatchChange(root, flags, stop.signal);
      if (!changed) break;
      if (!changed.enabled) {
        ending = { state: 'disabled', detail: null };
        break;
      }
      flags = changed;
      spawn = flags.spawn;
      started.setSpawnCapable(spawn);
      // What waited for permission to start a session is answered now rather
      // than on the next retry.
      if (spawn && admitting()) {
        pending = pending.then(resolveHeld);
        await pending;
      }
    }
  } catch (error) {
    if (!stop.signal.aborted) {
      thrown = error;
      throw error;
    }
  } finally {
    for (const release of unbind) release();
    stop.abort();
    if (retry) clearInterval(retry);
    signal.removeEventListener('abort', abort);
    await pending.catch(() => {});
    const failure = fault ?? thrown;
    control.report({
      state: failure ? 'not-running' : ending.state,
      detail: failure
        ? failure instanceof Error
          ? failure.message
          : String(failure)
        : ending.detail,
      placements: {},
    });
    await releaseOwner(root, ownerPath, owner);
  }
  if (fault) throw fault;
}

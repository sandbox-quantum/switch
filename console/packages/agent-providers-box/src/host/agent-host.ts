import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  EVICTION_HEARTBEAT_LAPSED,
  EVICTION_TAKEN_OVER,
  SwitchEventStream,
  type SwitchEventStreamDeps,
} from '@sandboxaq/switch-agent-runtime-box';
import type { SwitchIdentity } from '@sandboxaq/switch-agent-runtime-box/hosted';
import { z } from 'zod';
import type { AdmitKind, BoxValve, LetGoReason } from './box-valve';
import {
  DirectHostValve,
  fallbackFromEnv,
  giveUpReasonOf,
  type HostValve,
  HubHostValve,
  LegacyHostValve,
  refusalText,
  type ValveChannel,
  waitRequestOf,
} from './box-valve-client';
import type { Handoff } from './handoff';
import { HeldReplies, OwedLostLines } from './held-replies';
import { errorCode, Journal } from './journal';
import { owesRestartReply, readJournalSnapshot } from './journal-snapshot';
import {
  ensureSharedProcess,
  liveSupervisor,
  sharedSessionRoot,
  sharedSessionsBase,
  type Supervision,
} from './launch';
import { BoxFullError, type ParkCandidate, pressureValve } from './memory-pressure';
import { announceMemoryStop } from './memory-stop';
import { releaseOwner, replaceOwner, withOwnershipLockOutlasting } from './ownership-lock';
import { SessionPlacements } from './placements';
import { recordedOwnerAlive } from './process-fence';
import { RESET_FAILED_LINE, SESSION_READY_MS } from './room-control-followup';
import { roomInputId } from './room-inbox';
import {
  type GiveUpReason,
  RESET_WHILE_WAITING_MESSAGE,
  type RoomWaitList,
  roomWaits,
  SLOW_START_RETRY_MS,
  STOPPED_WAITING_MESSAGE,
  WAITING_FOR_ROOM_MESSAGE,
} from './room-wait';
import {
  SessionHostFailedError,
  type SessionRequest,
  SessionUnavailableError,
} from './session-channel';
import {
  currentServicesShape,
  GRANTS_CHECK_MS,
  recordedServicesShape,
  servicesChanged,
} from './session-services';
import { readSharedCredentials, sharedConfigSchema, type SharedHostConfig } from './shared-config';
import {
  keptLine,
  readStartFailureKind,
  SESSION_CLOSED_MESSAGE,
  START_LET_GO_MESSAGE,
  type StartFailureKind,
} from './start-failure';
import { sessionStarts, untilReady } from './start-limiter';
import { readTakenOver, recordTakenOver } from './taken-over';
import { awaitWatchChange, onConfigReplaced, readWatchFlags } from './watch-flags';
import type { SessionState } from './watcher-tools';
import {
  announceBoxFull,
  announceKept,
  announceSessionStart,
  tellRoomReplyLost,
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

/**
 * A session started for a room before any message reached it (a chat just
 * created or reopened). It has no sequence: nothing was delivered.
 */
const warmedSchema = z.strictObject({
  warmed: z.literal(true),
  roomId: z.string().min(1),
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
    // Why it was dealt with without reaching a session; absent when a session took it.
    reason: z.string().min(1).optional(),
  }),
});
/**
 * Marks a held delivery as waiting for room in a full box, and since when:
 * its room has been told so once, and its limit counts from `since`, across
 * a restart too. Finished by the delivery's `released` record.
 */
const waitingSchema = z.strictObject({
  waiting: z.strictObject({
    roomId: z.string().min(1),
    messageId: z.string().min(1),
    since: z.string().min(1),
  }),
});
/**
 * Marks that a held delivery's room was actually told it is kept or waiting:
 * written only once the post went through, so a line that failed (Switch
 * away) is tried again rather than taken as said.
 * Finished by the delivery's `released` record.
 */
const toldSchema = z.strictObject({
  told: z.strictObject({ roomId: z.string().min(1), messageId: z.string().min(1) }),
});
export const assignmentRecordSchema = z.union([
  assignmentSchema,
  restartSchema,
  handledSchema,
  parkedSchema,
  releasedSchema,
  warmedSchema,
  waitingSchema,
  toldSchema,
]);

type Assignment = z.infer<typeof assignmentSchema>;
type Assigned = Assignment | z.infer<typeof warmedSchema>;
type Held = Handoff & { spawning: boolean };
type WatchRecord = z.infer<typeof assignmentRecordSchema>;

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

function isWaiting(record: WatchRecord): record is z.infer<typeof waitingSchema> {
  return 'waiting' in record;
}

function isTold(record: WatchRecord): record is z.infer<typeof toldSchema> {
  return 'told' in record;
}

/** Whether a relayed room control is a reset (`!reset`). */
function isReset(command: Record<string, unknown>): boolean {
  return z.object({ type: z.literal('session.reset') }).safeParse(command.body).success;
}

function isRetry(command: Record<string, unknown>): boolean {
  return z.object({ type: z.literal('message.retry') }).safeParse(command.body).success;
}

function isAssignment(record: WatchRecord): record is Assignment {
  return 'sequence' in record;
}

/** An assignment or a warmed session: a session this watcher started for a room. */
function isAssigned(record: WatchRecord): record is Assigned {
  return 'config' in record;
}

const delivery = (event: { roomId: string; messageId: string }): string =>
  JSON.stringify([event.roomId, event.messageId]);

/** How often a room with no session to take its messages is looked at again. */
const OWNERSHIP_RETRY_MS = 5000;

/** How long a message waits for its session's host to start and take it. */
const HOST_START_MS = 120000;

/**
 * How many times in a row a session's host is started again for a message it
 * would not take before the room is told it cannot be reached. Starting it
 * again is what fixes a host that stopped; one that keeps not taking the
 * message is stuck in a way starting it does not fix.
 */
export const MAX_HOST_RESTARTS = 5;

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
/** Session directories whose config this process has already said it cannot read. */
const unreadableSessionRoots = new Set<string>();

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
      // Said once per directory in a process: every agent host sweeps every
      // session on the machine, so it would otherwise repeat for each agent.
      if (!unreadableSessionRoots.has(root)) {
        unreadableSessionRoots.add(root);
        console.warn(
          `Skipping session state at ${root}: its config could not be read (${
            error instanceof Error ? error.message : String(error)
          }). It will not be restarted.`
        );
      }
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
    // An upgrade: a turn this cuts off owes its room the "I was restarted"
    // line, so the stop is not marked as asked for.
    await supervision.stop(root, { asked: false });
  }
}

/**
 * `config` with what its agent's definition decides — the model, the approval
 * mode, the instructions and skill the provider is given, and what the
 * agent's advanced configuration becomes: the agent definition Claude Code
 * runs as and the Codex profile — and the credentials, provider binary and
 * environment (where a provider login given since lives) of whoever runs the
 * watcher, taken from the watcher's `template` as it stands now. Everything else stays the session's own: its identity,
 * directory and native conversation, so a session started after its agent was
 * edited resumes its conversation under the edit instead of under what the
 * agent was when the session was first created.
 *
 * A session that runs as a definition file on the host's disk
 * (`execution.agentDefinition`, a subagent watched under its parent) keeps the
 * agent it runs as: the template's definition is its parent's.
 */
export function withDefinitionOf(
  config: SharedHostConfig,
  template: SharedHostConfig
): SharedHostConfig {
  const next = structuredClone(config);
  const model = template.start.input.model;
  if (model) next.start.input.model = structuredClone(model);
  else delete next.start.input.model;
  next.start.input.runtimeMode = template.start.input.runtimeMode;
  // The environment carries the provider login the agent signs in with: a
  // session created before a login was given, changed or withdrawn takes the
  // current one. Only the session's own id stays its own.
  const sessionId = next.start.input.env.SWITCHDASH_SESSION_ID;
  next.start.input.env = structuredClone(template.start.input.env);
  if (next.start.input.env.SWITCHDASH_SESSION_ID !== undefined && sessionId !== undefined)
    next.start.input.env.SWITCHDASH_SESSION_ID = sessionId;
  if (!next.execution?.agentDefinition) {
    const { agentName, agentDefinition } = template.start.input;
    if (agentName) next.start.input.agentName = agentName;
    else delete next.start.input.agentName;
    if (agentDefinition) next.start.input.agentDefinition = structuredClone(agentDefinition);
    else delete next.start.input.agentDefinition;
  }
  if (next.execution && template.execution) {
    // Whoever runs the watcher now is who the session reaches Switch as: the
    // same room can be served by Console's watcher one day and a controller's
    // the next, each with credentials of its own.
    next.execution.credentialsPath = template.execution.credentialsPath;
    if (template.execution.binaryPath === undefined) delete next.execution.binaryPath;
    else next.execution.binaryPath = template.execution.binaryPath;
    next.execution.context = template.execution.context;
    if (template.execution.instructions === undefined) delete next.execution.instructions;
    else next.execution.instructions = template.execution.instructions;
    next.execution.skill = template.execution.skill;
    next.execution.codexConfig = template.execution.codexConfig;
  }
  return next;
}

/** Whether `config` was saved under a definition other than the one `template` carries. */
export function definitionChanged(config: SharedHostConfig, template: SharedHostConfig): boolean {
  return !isDeepStrictEqual(withDefinitionOf(config, template), config);
}

/** The config saved at a session root; null when the session has not written one. */
async function sessionConfigAt(sessionRoot: string): Promise<SharedHostConfig | null> {
  try {
    return sharedConfigSchema.parse(
      JSON.parse(await readFile(join(sessionRoot, 'config.json'), 'utf8'))
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The live sessions among `sessionIds` saved under an earlier definition of
 * their agent than `template`'s. A running host keeps the model and
 * instructions it was started with, through a reset too, so these would go on
 * answering as the agent was before it was edited.
 */
export async function redefinedSessions(
  sessionIds: string[],
  template: SharedHostConfig
): Promise<{ root: string; config: SharedHostConfig }[]> {
  const found: { root: string; config: SharedHostConfig }[] = [];
  for (const sessionId of new Set(sessionIds)) {
    const root = sharedSessionRoot(sessionId);
    const config = await sessionConfigAt(root);
    if (!config) continue;
    if (config.session.agentId !== template.session.agentId) continue;
    if (!definitionChanged(config, template)) continue;
    if (!(await liveSupervisor(root))) continue;
    found.push({ root, config });
  }
  return found;
}

/**
 * Stops each session running under an earlier definition. Like a superseded
 * build, it is started again when it is next needed, and then resumes its
 * conversation under the current definition (`withDefinitionOf`). A turn it
 * was in the middle of is reported as interrupted by the host.
 */
export async function stopRedefinedSessions(
  redefined: { root: string; config: SharedHostConfig }[],
  supervision: Supervision
): Promise<void> {
  for (const { root, config } of redefined) {
    console.warn(
      `Session ${config.session.sessionId} runs under an earlier definition of its agent (model, instructions, advanced configuration or approval mode); stopping it so it resumes under the current one when it is next needed.`
    );
    await supervision.stop(root);
  }
}

/** A journal this long, and twice what it was last compacted to, is compacted again. */
export const COMPACT_AT_RECORDS = 1000;
/**
 * A released message's text is compacted out this long after the last
 * release in a burst, so 20 releases close together rewrite the journal once
 * (a debounce), and never later than `RELEASE_COMPACT_MAX_MS` after
 * the first of them.
 */
export const RELEASE_COMPACT_QUIET_MS = 1_000;
export const RELEASE_COMPACT_MAX_MS = 10_000;

/**
 * The records an assignment journal still needs, in order: what it reads
 * (`cursor`, `pending`, `placements`, `configOf`, `sessions`, `assign`)
 * comes out the same from these as from all of them. Dropped:
 * - a held delivery's `parked` record, with the message text it carries, once
 *   it is released (delivered or let go). In the current numbering its
 *   sequence is kept as a `handled` position, which is all the cursor read
 *   from it;
 * - its `waiting` record, once released;
 * - every `handled` record, folded into one for the current numbering, the
 *   furthest; earlier numberings' positions are never read again;
 * - a `released` record no assignment of the current numbering names (the
 *   cursor's only other use of it);
 * - every `restarted` mark but the last.
 * Kept whole: every assignment and warmed session (which session serves
 * which room, and its config), and every held delivery still waiting, text
 * included, since nothing else keeps it.
 */
export function compactAssignments(records: readonly WatchRecord[]): WatchRecord[] {
  let last = records.length - 1;
  while (last >= 0 && !restarted(records[last]!)) last--;
  const released = new Set(records.filter(isReleased).map((record) => delivery(record.released)));
  const namedNow = new Set(
    records
      .slice(last + 1)
      .filter(isAssignment)
      .map((record) => delivery(record))
  );
  const kept: WatchRecord[] = [];
  let furthest = 0;
  records.forEach((record, index) => {
    const now = index > last;
    if (restarted(record)) {
      if (index === last) kept.push(record);
    } else if (isHandled(record)) {
      if (now) furthest = Math.max(furthest, record.handled);
    } else if (isParked(record)) {
      if (!released.has(delivery(record))) kept.push(record);
      else if (now) furthest = Math.max(furthest, record.parked);
    } else if (isWaiting(record)) {
      if (!released.has(delivery(record.waiting))) kept.push(record);
    } else if (isTold(record)) {
      if (!released.has(delivery(record.told))) kept.push(record);
    } else if (isReleased(record)) {
      if (namedNow.has(delivery(record.released))) kept.push(record);
    } else kept.push(record);
  });
  if (furthest > 0) kept.push({ handled: furthest });
  return kept;
}

/**
 * Which session serves which room, and how far the watcher has got. Both the
 * assignment and the routing that follows it are on disk before the stream is
 * allowed past the event.
 */
export class AgentHostAssignments {
  /** How long the journal was after it was last compacted. */
  private compactedTo: number;

  private constructor(private readonly journal: Journal<WatchRecord>) {
    this.compactedTo = journal.records.length;
  }

  static async open(root: string): Promise<AgentHostAssignments> {
    return new AgentHostAssignments(
      await Journal.load(join(root, 'assignments.jsonl'), (value) =>
        assignmentRecordSchema.parse(value)
      )
    );
  }

  /** How many records the journal holds now (for tests and logs). */
  get length(): number {
    return this.journal.records.length;
  }

  /**
   * Drops what the journal has finished with (`compactAssignments`): a held
   * message's text leaves the disk once it is delivered or let go. Run at
   * host start, and once the journal has grown past `COMPACT_AT_RECORDS` and
   * twice its last compacted size. Resolves to how many records went.
   */
  async compact(): Promise<number> {
    const dropped = await this.journal.compact(compactAssignments);
    this.compactedTo = this.journal.records.length;
    return dropped;
  }

  /** A released message's text is still on disk: a compaction that should have removed it failed. */
  private textOwed = false;
  /** The compaction a release scheduled, and when the first release waiting on it came. */
  private releaseTimer: NodeJS.Timeout | null = null;
  private releaseFirstAt = 0;
  private releaseCompaction: Promise<void> = Promise.resolve();

  /**
   * Compacts soon after a release that freed held text: once the releases
   * have been quiet for `RELEASE_COMPACT_QUIET_MS`, and at most
   * `RELEASE_COMPACT_MAX_MS` after the first, so a burst is one rewrite.
   */
  private compactAfterRelease(): void {
    const now = Date.now();
    if (this.releaseTimer) {
      if (now - this.releaseFirstAt >= RELEASE_COMPACT_MAX_MS) return;
      clearTimeout(this.releaseTimer);
    } else this.releaseFirstAt = now;
    const wait = Math.min(
      RELEASE_COMPACT_QUIET_MS,
      Math.max(0, this.releaseFirstAt + RELEASE_COMPACT_MAX_MS - now)
    );
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      this.releaseCompaction = this.compactNow();
    }, wait);
    this.releaseTimer.unref?.();
  }

  /**
   * The host is stopping: a compaction a release scheduled runs now, so held
   * text never outlives the host that released it. The journal has one owner,
   * so nothing compacts it after this.
   */
  async close(): Promise<void> {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
      this.releaseCompaction = this.compactNow();
    }
    await this.releaseCompaction;
  }

  private async compactIfLong(): Promise<void> {
    const length = this.journal.records.length;
    if (!this.textOwed && (length < COMPACT_AT_RECORDS || length < 2 * this.compactedTo)) return;
    await this.compactNow();
  }

  private async compactNow(): Promise<void> {
    try {
      await this.compact();
      this.textOwed = false;
    } catch (error) {
      // The journal is still whole (the old one or the new one), so the host
      // carries on; the next record written tries again.
      this.compactedTo = this.journal.records.length;
      this.textOwed = true;
      console.warn(`Could not compact this agent's assignment journal (${errorCode(error)}).`);
    }
  }

  /** When a held delivery started waiting for room, in ms; null if it never has. */
  waitingSince(event: { roomId: string; messageId: string }): number | null {
    const identity = delivery(event);
    if (this.settled.has(identity)) return null;
    const record = this.journal.records
      .filter(isWaiting)
      .find((entry) => delivery(entry.waiting) === identity);
    if (!record) return null;
    const since = Date.parse(record.waiting.since);
    return Number.isFinite(since) ? since : null;
  }

  /** Whether a held delivery's room was told it is kept or waiting (and it isn't finished). */
  wasTold(event: { roomId: string; messageId: string }): boolean {
    const identity = delivery(event);
    if (this.settled.has(identity)) return false;
    return this.journal.records.some(
      (record) => isTold(record) && delivery(record.told) === identity
    );
  }

  /** Records that a held delivery's room was told it is kept or waiting. */
  async told(event: { roomId: string; messageId: string }): Promise<void> {
    await this.journal.append({ told: { roomId: event.roomId, messageId: event.messageId } });
  }

  /** Records that a held delivery is waiting for room in a full box, since `sinceMs`. */
  async waiting(event: { roomId: string; messageId: string }, sinceMs: number): Promise<void> {
    await this.journal.append({
      waiting: {
        roomId: event.roomId,
        messageId: event.messageId,
        since: new Date(sinceMs).toISOString(),
      },
    });
  }

  /** Records written under the server's current numbering. */
  private get current(): WatchRecord[] {
    const records = this.journal.records;
    let index = records.length - 1;
    while (index >= 0 && !restarted(records[index]!)) index--;
    return records.slice(index + 1);
  }

  private get every(): Assigned[] {
    return this.journal.records.filter(isAssigned);
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
    await this.compactIfLong();
  }

  /**
   * Records that a held event has been routed, or, with a `reason`, decided
   * not to be.
   */
  async released(
    event: { roomId: string; messageId: string },
    reason: string | null
  ): Promise<void> {
    const identity = delivery(event);
    const held = this.journal.records.some(
      (record) => isParked(record) && delivery(record) === identity
    );
    await this.journal.append({
      released: {
        roomId: event.roomId,
        messageId: event.messageId,
        ...(reason === null ? {} : { reason }),
      },
    });
    // A released message's text leaves the disk
    // within seconds, not at the next compaction; a burst of releases is one
    // rewrite. A failure is retried on the next record.
    if (held) this.compactAfterRelease();
    else await this.compactIfLong();
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
    const identity = delivery(event);
    const waiting = new Set(this.pending().map(delivery));
    const assignments = this.current.filter(isAssignment);
    const duplicate = waiting.has(identity)
      ? assignments.find((record) => delivery(record) === identity)
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

  /** A new session for a room no message has reached yet. */
  async warm(template: SharedHostConfig, roomId: string): Promise<SharedHostConfig> {
    if (!template.roomConnection?.connectionId)
      throw new Error('A watcher assignment needs the connection its agent is reached over.');
    const sessionId = randomUUID();
    const config = sessionFrom(template, sessionId);
    await mkdir(sharedSessionRoot(sessionId), { recursive: true });
    await this.journal.append({ warmed: true, roomId, config });
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

/**
 * What a watcher hears its agent's events on, and tells Switch where its
 * sessions are through: its own connection to Switch (`openSwitchStream`), or
 * whatever hosts the watcher and holds the agent's connection for it, as an
 * agent controller does for every agent on its machine.
 */
export type AgentEventStream = {
  /** The agent host, not Switch, tells a room when it starts a session for it. */
  readonly announcesSessionStarts: boolean;
  /**
   * The room of a session's tool call is the one this stream was last told
   * the session is placed in, not one Switch recorded when the session called
   * `connect_to_room`. True for an agent controller, whose relay names the
   * room on every call from these placements, so a placement it did not take
   * leaves the session calling from no room. False for the agent's own
   * connection, where Switch places the session itself.
   */
  readonly placementsNameCallRooms: boolean;
  start(): void;
  setSpawnCapable(capable: boolean): void;
  /**
   * State every session's room. The rooms named back in `refusedRooms` are
   * ones the agent is not in (deleted, or the agent taken out): their sessions
   * were left out, and the rest placed.
   */
  replacePlacements(placements: Record<string, string>): Promise<{ refusedRooms: string[] }>;
};

/**
 * What the agent host is told on its stream. Beside the runtime's own, an
 * agent controller's hub says when a room a session is placed in is no longer
 * the agent's (deleted, or the agent taken out): Switch said so, so the
 * placement goes.
 */
export type AgentStreamDeps = SwitchEventStreamDeps & {
  onRoomGone?: (info: { roomId: string; sessionId: string }) => Promise<void> | void;
};

export type OpenAgentStream = ((deps: AgentStreamDeps) => AgentEventStream) & {
  /** An isolated host's hub: the box valve is reached over it. */
  valveChannel?: ValveChannel;
  /** A host in the controller's own process: the controller's box valve, directly. */
  boxValve?: BoxValve;
};

/** The watcher's own connection to Switch, with the agent's credentials. */
export const openSwitchStream: OpenAgentStream = (deps) => new SwitchEventStream(deps);

/**
 * The owner records this process holds right now, by path. A record naming
 * this process's own id that is not in here was left by an earlier process
 * that had the same id: a container restarting gives its processes the same
 * low ids again, so after a crash the new controller finds its own id in the
 * lock the old one never released.
 */
const heldOwners = new Map<string, string>();

export async function runAgentHost(
  root: string,
  template: SharedHostConfig,
  signal: AbortSignal,
  supervision: Supervision,
  control: WatcherControl,
  openStream: OpenAgentStream,
  /** Where messages wait for room in a full box: the one this process shares, unless a test gives its own. */
  waits: RoomWaitList = roomWaits
): Promise<void> {
  const ownerPath = join(root, 'shared-owner.lock');
  const owner = { pid: process.pid, token: randomUUID() };
  // Outlasting: a Console restarting starts this while the one it replaces
  // may still be shutting down, holding the lock.
  const owned = await withOwnershipLockOutlasting(
    root,
    async () => {
      try {
        const { pid, token } = z
          .object({ pid: z.number().int().positive(), token: z.string().optional() })
          .parse(JSON.parse(await readFile(ownerPath, 'utf8')));
        const held = heldOwners.get(ownerPath);
        const leftByEarlierProcess = pid === process.pid && (held === undefined || held !== token);
        // Judged first, so a stale lock is seen (and logged) as such, then the
        // same-id check. Either way an earlier owner's lock is taken over.
        const mayBeAlive = await recordedOwnerAlive(ownerPath, pid);
        if (mayBeAlive && !leftByEarlierProcess)
          throw new Error('The shared SDK watcher is already running.');
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      await replaceOwner(ownerPath, owner);
      heldOwners.set(ownerPath, owner.token);
    },
    signal
  );
  if (!owned) return;
  const stop = new AbortController();
  const abort = () => stop.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let fault: Error | null = null;
  let pending: Promise<void> = Promise.resolve();
  let retry: NodeJS.Timeout | null = null;
  let grantsCheck: NodeJS.Timeout | null = null;
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
  let assignmentsOpened: AgentHostAssignments | null = null;
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
    const assignments = await AgentHostAssignments.open(root);
    assignmentsOpened = assignments;
    // At start, before anything reads it: what was delivered or let go since
    // the last compaction, held message text included, leaves the disk.
    try {
      const dropped = await assignments.compact();
      if (dropped)
        console.info(
          `Compacted this agent's assignment journal: ${dropped} finished record(s) removed, ${assignments.length} kept.`
        );
    } catch (error) {
      console.warn(
        `Could not compact this agent's assignment journal at start (${errorCode(error)}); it is used as it is.`
      );
    }
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
    /**
     * This agent's sessions whose host runs here and has not said it is idle:
     * the ones an agent controller restarting now would cut off mid-turn.
     */
    const busySessions = (): string[] => {
      const live = new Set(links.live());
      const ids = new Set([
        ...assignments.sessions().map((config) => config.session.sessionId),
        ...Object.keys(placements.snapshot()),
      ]);
      const busy = [...ids].filter((sessionId) => {
        const sessionRoot = sharedSessionRoot(sessionId);
        return live.has(sessionRoot) && links.busy(sessionRoot)?.busy !== false;
      });
      // A session with messages waiting for room owes them a start: busy, so
      // nothing that waits for idle (a controller update, a rest) takes it as idle.
      for (const sessionId of waits.sessionsOf(agentId))
        if (!busy.includes(sessionId)) busy.push(sessionId);
      return busy;
    };
    /**
     * The box valve: the controller's, directly (a host in its process)
     * or over the hub (an isolated host), or today's valve for this process
     * where no controller runs it (Console's own hosts, an SSH host).
     */
    const valve: HostValve = openStream.boxValve
      ? new DirectHostValve(openStream.boxValve, agentId, { log: console })
      : openStream.valveChannel
        ? new HubHostValve(openStream.valveChannel, fallbackFromEnv(), { log: console })
        : new LegacyHostValve(pressureValve);
    /** Why the last start was refused, in plain words, for this host's log. */
    let lastRefusal = '';
    /** Sessions being started for a message right now: "Back in a moment". */
    const waking = new Set<string>();
    /** Every session of this agent here, and where it stands. */
    const sessionStates = (): Record<string, SessionState> => {
      const live = new Set(links.live());
      const ids = new Set([
        ...assignments.sessions().map((config) => config.session.sessionId),
        ...Object.keys(placements.snapshot()),
      ]);
      return Object.fromEntries(
        [...ids].map((sessionId): [string, SessionState] => [
          sessionId,
          waking.has(sessionId)
            ? 'waking'
            : live.has(sharedSessionRoot(sessionId))
              ? 'active'
              : 'parked',
        ])
      );
    };
    /** Where each session stood when last reported, to log each move once. */
    const statesReported = new Map<string, SessionState>();
    const reportSessions = () => {
      const sessions = sessionStates();
      // When the move happened here, for comparing with when the controller's
      // report carried it to Switch. Ids, states and times only.
      for (const [sessionId, state] of Object.entries(sessions)) {
        const was = statesReported.get(sessionId) ?? null;
        if (was === state) continue;
        statesReported.set(sessionId, state);
        console.info(
          `Session ${sessionId} of agent ${agentId}: ${was ?? 'none'} -> ${state} at ${new Date().toISOString()}.`
        );
      }
      control.report({ busy: busySessions(), sessions });
      valve.changed();
    };
    // Console's amber "Waiting for room" card reads this, through the status report.
    const reportWaiting = () =>
      control.report({ busy: busySessions(), waitingForRoom: waits.count(agentId) });
    unbind.push(
      waits.onChange((changed) => {
        if (changed === agentId) reportWaiting();
      }),
      // This host stopping (signalled, disabled, or stopped by the memory
      // guard) takes its waiting messages off the list without a line: they
      // stay in the journal and wait again when the host next starts.
      () => {
        waits.removeWhere((waiter) => waiter.host === owner.token);
      }
    );
    /** When each live session last went idle, for parking the quietest first. */
    const idleSince = new Map<string, number>();
    const parkCandidates = (): ParkCandidate[] => {
      const live = new Set(links.live());
      const awake = Object.entries(sessionStates()).filter(([, state]) => state === 'active');
      return awake.flatMap(([sessionId]): ParkCandidate[] => {
        const sessionRoot = sharedSessionRoot(sessionId);
        if (!live.has(sessionRoot) || links.busy(sessionRoot)?.busy !== false) return [];
        if (!idleSince.has(sessionRoot)) idleSince.set(sessionRoot, Date.now());
        return [
          {
            sessionId,
            idleSinceMs: idleSince.get(sessionRoot)!,
            duplicate: awake.length > 1,
            park: async () => {
              const answer = (await links.request(sessionRoot, { type: 'park' }, 5_000)) as {
                parking?: boolean;
              } | null;
              return answer?.parking === true;
            },
          },
        ];
      });
    };
    /**
     * The box valve let go of a waiting message (its 10 minutes, or the box's
     * list or this agent's share of it full): its room is told, as for the
     * same limit here. Held means the guard is stopping this agent: the
     * journal keeps the message for its next start, so nothing is said.
     */
    const boxLetGo = (messageId: string, reason: LetGoReason) => {
      if (reason === 'held') return;
      const [waiter] = waits.removeWhere(
        (other) => other.host === owner.token && other.messageId === messageId
      );
      if (!waiter) return;
      void waiter
        .giveUp(giveUpReasonOf(reason))
        .catch((error: unknown) =>
          console.warn(
            `Could not let go of message ${messageId} for the box valve: ${errorCode(error)}`
          )
        );
    };
    // This agent's sessions that are up and idle, for the box's cap and for
    // parking; its waiting messages, for the box's one list.
    unbind.push(
      valve.attach(
        {
          awake: () => Object.values(sessionStates()).filter((state) => state === 'active').length,
          idle: parkCandidates,
          waiting: () => waits.list((waiter) => waiter.host === owner.token).map(waitRequestOf),
        },
        {
          // Returned, not voided: the box valve's reserved room is handed back as unused once this settles, so it
          // must settle only after this host's admit has claimed it (a busy box, 28 Oct).
          start: (sessionId) => waits.startNow(sessionId),
          letGo: boxLetGo,
        }
      ),
      waits.onRemoved((waiter) => {
        if (waiter.host === owner.token) valve.unwait(waiter.messageId);
      })
    );
    control.report({
      state: 'connecting',
      detail: null,
      placements: placements.snapshot(),
      busy: busySessions(),
      sessions: sessionStates(),
    });
    unbind.push(
      placements.onChange((map) =>
        control.report({ placements: map, busy: busySessions(), sessions: sessionStates() })
      ),
      links.onBusy((busyRoot) => {
        if (links.busy(busyRoot)?.busy === false) idleSince.set(busyRoot, Date.now());
        else idleSince.delete(busyRoot);
        reportSessions();
      }),
      links.onReady((ready) => {
        for (const id of [...waking]) if (sharedSessionRoot(id) === ready) waking.delete(id);
        reportSessions();
      }),
      links.onExit((gone) => {
        for (const id of [...waking]) if (sharedSessionRoot(id) === gone) waking.delete(id);
        reportSessions();
      }),
      links.onFailure((failed) => {
        for (const id of [...waking]) if (sharedSessionRoot(id) === failed) waking.delete(id);
        reportSessions();
      })
    );
    let resumedCutOff = false;
    /**
     * Sessions whose host died mid-turn (a crash, an out-of-memory kill, an
     * upgrade) are started again as soon as the watcher is connected, not on
     * the room's next message: starting is what marks the cut-off turn
     * interrupted, clears its "Working…" and tells the room once (the session
     * host's recovery). Others stay parked.
     */
    const resumeCutOffSessions = async ({ first }: { first: boolean }): Promise<void> => {
      for (const config of assignments.sessions()) {
        const sessionId = config.session.sessionId;
        const sessionRoot = sharedSessionRoot(sessionId);
        if (links.ready(sessionRoot)) {
          // Up already: on a reconnect, it tries again any line it still owes.
          if (!first && (await owesRestartReply(sessionId).catch(() => false)))
            await links
              .request(sessionRoot, { type: 'restart-replies' }, 5_000)
              .catch((error: unknown) =>
                console.warn(
                  `Session ${sessionId} owes a room its restart line but did not take the retry: ${
                    error instanceof Error ? error.message : String(error)
                  }`
                )
              );
          continue;
        }
        let snapshot;
        try {
          snapshot = await readJournalSnapshot(sessionId);
        } catch {
          continue;
        }
        // Cut off by a hard kill (the journal still says running), or by a clean
        // stop (the provider exited first and the host owes the room its line).
        if (
          !snapshot.turns.some((turn) => turn.status === 'running' || turn.status === 'queued') &&
          !(await owesRestartReply(sessionId).catch(() => false))
        )
          continue;
        // After an out-of-memory kill, starting every cut-off session again
        // could fill the box straight back up: the same ceiling as any start.
        // A session skipped here tells its room when it next starts.
        try {
          await launch(config, 'resume');
        } catch (error) {
          if (!(error instanceof BoxFullError)) throw error;
          // After an out-of-memory kill, starting every cut-off session again
          // could fill the box straight back up: the same ceiling as any start.
          console.warn(
            `Session ${sessionId} has a turn a restart cut off, but was not started again to say so: ${lastRefusal || 'the box is full'}. It says so when it next starts.`
          );
        }
      }
    };
    let stream: AgentEventStream | null = null;
    let publishing: Promise<void> = Promise.resolve();
    /**
     * Tells Switch where every session is, replacing what it held: after each
     * change here and whenever the stream reconnects, since Switch keeps
     * placements in memory only. Nothing to say before the stream exists; its
     * first open says it.
     */
    const publish = (): Promise<void> => {
      const run = async () => {
        const answer = await stream?.replacePlacements(placements.snapshot());
        // Switch or the controller said the agent is not in the room (it is gone,
        // or the agent was taken out): a refusal naming the room, never a failure
        // to answer. The session no longer attends it, so it is not stated again.
        for (const roomId of answer?.refusedRooms ?? []) {
          const lost = await placements.roomLost(roomId);
          if (lost)
            console.warn(
              `Session ${lost} was placed in room ${roomId}, which this agent is no longer in; it no longer attends it.`
            );
        }
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
    // The agent's room posts Switch could not take while it was away, held
    // in this process only until it is back. Lost, and said so, if this
    // watcher stops first.
    const owedLines = await OwedLostLines.open(join(root, 'held-replies.json'));
    const heldReplies = new HeldReplies({ owed: owedLines });
    unbind.push(() => heldReplies.stop());
    // Posts the watcher before this one held when it stopped: lost with it, so
    // each room is told, once Switch answers.
    heldReplies.owedFromBefore(owedLines.fromBefore, (line) => async () => {
      const config = await sessionConfig(line.sessionId);
      if (!config) return { kind: 'final', detail: 'its session is gone' };
      return tellRoomReplyLost({
        identity,
        connectionId,
        session: config.session,
        root: sharedSessionRoot(line.sessionId),
        cwd: config.start.input.cwd,
        line,
        attending: placements.roomOf(line.sessionId),
      });
    });
    // Before any session is started below: a host asks for its tools as soon
    // as its provider comes up.
    unbind.push(
      links.answer(
        agentId,
        sessionToolAnswerer({
          restartNotice: control.restartNotice,
          identity,
          connectionId,
          placements,
          // Nothing is stated before the stream exists, so a move made then
          // has not been taken by anyone: said rather than reported done.
          publish: async () => {
            if (!stream) throw new Error("this agent's stream to Switch is not open yet");
            await publish();
          },
          // Without a stream there is no connection for Switch to have placed
          // the session on either, so the move counts as not taken.
          placementsNameCallRooms: () => stream?.placementsNameCallRooms ?? true,
          redactions: links.redactions,
          held: heldReplies,
        })
      )
    );
    /**
     * Per session, the messages handed to it and not yet acknowledged, sent
     * down the IPC pipe one at a time and in order. Each is parked in the
     * journal first and released on the host's acknowledgement, so one this
     * controller dies holding is routed again when it restarts.
     *
     * `failed` is set when the host stopped on a failure it recorded, or
     * would not take a message however often it was started again: the
     * messages stay queued and the host is not started again until something
     * changes — another room message for it, or its host coming up because
     * somebody started it from Console. `restarts` counts the starts in a row
     * that did not get the first queued message taken.
     */
    type Pump = {
      queue: Handoff[];
      running: boolean;
      failed: string | null;
      restarts: number;
      config: SharedHostConfig;
      /**
       * The box had no room to start the host: its queued messages wait on
       * `waits` and it is started from there, oldest first, once there is.
       */
      waiting: boolean;
    };
    // Declared before the ready listener below reads it: another session can
    // come up while this host is still awaiting its own start-up.
    const pumps = new Map<string, Pump>();
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
          entry.restarts = 0;
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
    /** The watcher's template as it stands now, which admitting a room reads too. */
    const currentTemplate = async (): Promise<SharedHostConfig> =>
      sharedConfigSchema.parse(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')));
    /**
     * The shape of the agent's grants as last read (`servicesShape`), which
     * every session's host is compared against: null until first read.
     */
    let servicesNow: string | null = null;
    const startedServices = async (sessionRoot: string): Promise<string | null | undefined> => {
      try {
        return await recordedServicesShape(sessionRoot);
      } catch (error) {
        console.warn(
          `Could not read which services the session at ${sessionRoot} started with, so it is not restarted for a change to them: ${error instanceof Error ? error.message : String(error)}`
        );
        return undefined;
      }
    };
    /**
     * The grants each session's host was last restarted for. A host that comes
     * back recording other grants still (its own read of them failing, say) is
     * not restarted for the same grants again: once is a fix, more is a loop.
     */
    const restartedFor = new Map<string, string>();
    const servicesStale = async (sessionRoot: string, current: string | null) => {
      if (current === null || restartedFor.get(sessionRoot) === current) return false;
      return servicesChanged(await startedServices(sessionRoot), current);
    };
    /**
     * Restarts a session's host, on its own conversation, when it started
     * under other granted services than the agent has now. True when it did.
     */
    const restartForServices = async (sessionId: string): Promise<boolean> => {
      const sessionRoot = sharedSessionRoot(sessionId);
      if (!links.ready(sessionRoot)) return false;
      const saved = await sessionConfigAt(sessionRoot);
      const current = await currentTemplate();
      if (
        !saved ||
        saved.session.agentId !== agentId ||
        saved.start.provider !== current.start.provider ||
        saved.start.input.cwd !== current.start.input.cwd
      )
        return false;
      const shape = await currentServicesShape(current);
      if (shape !== null) servicesNow = shape;
      if (!(await servicesStale(sessionRoot, shape))) return false;
      restartedFor.set(sessionRoot, shape!);
      console.warn(
        `Session ${sessionId} is being reset with other services granted to its agent than it started with; restarting its host first so the new conversation has them.`
      );
      await ensureSharedProcess({
        root: sessionRoot,
        config: reachableBy(withDefinitionOf(saved, current), connectionId),
        resuming: true,
        watcher: false,
        restart: true,
        supervision,
        startSource: null,
      });
      return true;
    };
    /**
     * Starts under way, by session: a second start asked for while one is
     * running waits for it rather than racing it (a reset arriving while a
     * room message wakes the session).
     */
    const launching = new Map<string, Promise<void>>();
    const launch = (config: SharedHostConfig, kind: AdmitKind = 'message'): Promise<void> => {
      const sessionId = config.session.sessionId;
      const running = launching.get(sessionId);
      if (running) return running;
      const started = launchNow(config, kind).finally(() => launching.delete(sessionId));
      launching.set(sessionId, started);
      return started;
    };
    const launchNow = async (config: SharedHostConfig, kind: AdmitKind) => {
      // Both flags are re-read here rather than taken from whoever asked for the
      // launch. Everything that reaches this point was admitted earlier and may
      // have waited behind other work since — a queued event, or an assignment
      // later in the restore loop — and a session started after somebody turned
      // spawning off cannot be taken back.
      const now = await readWatchFlags(root);
      if (!now.enabled || !now.spawn || (await stopped(config.session.sessionId))) return;
      const sessionRoot = sharedSessionRoot(config.session.sessionId);
      const sessionId = config.session.sessionId;
      const wasLive = links.ready(sessionRoot);
      if (!wasLive) {
        waking.add(sessionId);
        reportSessions();
      }
      // Starts share the machine's CPUs with every other agent's: a few at a
      // time, each holding its slot until its session host has connected.
      try {
        await sessionStarts.run(async () => {
          // The memory ceiling is asked here, as the start really begins (after
          // any wait for a slot), and counts this start until it is up.
          let lease: string | null = null;
          if (!links.ready(sessionRoot)) {
            const answer = await valve.admit(sessionId, kind);
            if (!answer.ok) {
              lastRefusal = refusalText(answer.reason);
              throw new BoxFullError(`The box is full: ${lastRefusal}.`);
            }
            lease = answer.lease;
          }
          let started = false;
          try {
            await ensureSharedProcess({
              root: sessionRoot,
              config: reachableBy(withDefinitionOf(config, await currentTemplate()), connectionId),
              resuming: false,
              watcher: false,
              restart: false,
              supervision,
              // Every session this watcher starts answers a room message. Recorded
              // only if this launch creates the session, so a relaunch is not a start.
              startSource: 'room',
            });
            // Only a limited machine waits: unlimited, nothing queues behind it.
            if (Number.isFinite(sessionStarts.capacity))
              await untilReady(() => links.ready(sessionRoot));
            started = true;
          } finally {
            // Up, or failed: a failed start given room for waiting messages is stepped over.
            if (lease !== null) valve.settle(lease, started);
          }
        });
      } catch (error) {
        // Turned away: it is not waking, so Console shows it resting at once
        // rather than "Back in a moment" for a start that will not happen.
        if (error instanceof BoxFullError && waking.delete(sessionId)) reportSessions();
        throw error;
      } finally {
        // Waking ends when its host connects, exits or fails (the link events
        // below), or here if it already has; never later than a minute on.
        if (links.ready(sessionRoot)) {
          if (waking.delete(sessionId)) reportSessions();
        } else if (waking.has(sessionId)) {
          setTimeout(() => {
            if (waking.delete(sessionId)) reportSessions();
          }, 60_000).unref?.();
        }
      }
    };
    const superseded = await supersededSessions(template.session.agentId, supervision);
    await stopSupersededSessions(superseded, supervision);
    const stoppedRoots = new Set(superseded.map((entry) => entry.root));
    await stopRedefinedSessions(
      (
        await redefinedSessions(
          assignments.sessions().map((config) => config.session.sessionId),
          template
        )
      ).filter((entry) => !stoppedRoots.has(entry.root)),
      supervision
    );
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
    const askSession = async (
      sessionId: string,
      request: SessionRequest,
      what: string,
      waitMs: number
    ) => {
      const sessionRoot = sharedSessionRoot(sessionId);
      if (!(await sessionConfig(sessionId))) return false;
      try {
        await links.request(sessionRoot, request, waitMs);
        return true;
      } catch (error) {
        console.warn(`Could not pass ${what} to session ${sessionId}: ${String(error)}`);
        return false;
      }
    };
    /**
     * States the placements before a notice posted as the session, so Switch
     * answers it from the room it is in. A statement that is not taken is
     * said and the notice still tried: it is posted once, and a room left
     * with no word of its session is worse than a notice that fails too.
     */
    const publishBeforeNotice = async (what: string) => {
      await publish().catch((error: unknown) =>
        console.warn(
          `Could not state the session placements before ${what}: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    };
    /** Says in the room that a session is starting for its message, once per message. */
    const startingNoticed = new Set<string>();
    const tellStarting = async (config: SharedHostConfig, event: Handoff) => {
      const key = `${event.roomId}:${event.messageId}`;
      if (startingNoticed.has(key)) return;
      startingNoticed.add(key);
      try {
        await publishBeforeNotice(`telling room ${event.roomId} a session is starting`);
        await announceSessionStart({
          identity,
          connectionId,
          session: config.session,
          root: sharedSessionRoot(config.session.sessionId),
          cwd: config.start.input.cwd,
          threadId: threadOf(event.event),
        });
      } catch (error) {
        console.error(
          `Could not tell room ${event.roomId} a session is starting for message ${event.messageId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    };
    /** Tells a message's room, once, that its session can't start and the message is kept. */
    const tellKept = (
      config: SharedHostConfig,
      event: Handoff,
      kind: StartFailureKind
    ): Promise<boolean> => {
      const sessionId = config.session.sessionId;
      return (async () => {
        // Switch answers the call from where it holds the session placed.
        await publishBeforeNotice(
          `telling room ${event.roomId} session ${sessionId} can't start and its message is kept`
        );
        await announceKept({
          identity,
          connectionId,
          session: config.session,
          root: sharedSessionRoot(sessionId),
          cwd: config.start.input.cwd,
          threadId: threadOf(event.event),
          line: (owner) => keptLine(kind, owner),
        });
        return true;
      })().catch((error: unknown) => {
        console.error(
          `Could not tell room ${event.roomId} that session ${sessionId} can't start and its message is kept: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return false;
      });
    };
    /**
     * A session that can't start (no login, a setup error, or a host that
     * would not take its message): each message it holds is kept and told so
     * once, then waits on the wait list as a `start` wait, with the same
     * limits. It is answered once the session starts, or let go with one
     * "send it again" line at its limit, and then never answered.
     * Told once across restarts too: the journal's `told` record, written
     * only once the post went through, says it was; until then the line is
     * tried again at each keep, retry or restart (`promise`). The `waiting`
     * record only starts its 10-minute clock.
     */
    /**
     * Tells the box valve a message now waits here. Null while it waits;
     * otherwise the box let it go at once (its list or this agent's share is
     * full, or it waited its limit), it is off this list too, and the caller
     * lets it go with its line. `gone` when it had already left this list
     * meanwhile (started or answered): no line at all. Held counts as
     * waiting: the guard stopping this agent leaves it in the journal.
     */
    const boxWait = async (
      event: Handoff,
      sessionId: string,
      sinceMs: number,
      kind: 'room' | 'start',
      outcome: 'waiting' | 'already'
    ): Promise<GiveUpReason | 'gone' | null> => {
      if (outcome !== 'waiting') return null;
      const answer = await valve.wait({
        roomId: event.roomId,
        messageId: event.messageId,
        sessionId,
        sinceMs: Math.max(0, Math.round(sinceMs)),
        kind,
      });
      if (answer === 'waiting' || answer === 'already' || answer === 'held') return null;
      // Only a message still waiting here is let go with a line: one that
      // started (or was answered) while the box was asked gets none.
      const removed = waits.removeWhere(
        (waiter) => waiter.host === owner.token && waiter.messageId === event.messageId
      );
      return removed.length ? giveUpReasonOf(answer) : 'gone';
    };
    const keepAfterFailure = async (
      config: SharedHostConfig,
      entry: Pump,
      kind: StartFailureKind
    ): Promise<void> => {
      const sessionId = config.session.sessionId;
      for (const event of [...entry.queue]) {
        const since = assignments.waitingSince(event);
        const sinceMs = since ?? Date.now();
        const outcome = waits.add({
          agentId,
          sessionId,
          host: owner.token,
          roomId: event.roomId,
          messageId: event.messageId,
          sinceMs,
          kind: 'start',
          // Only a person can fix these: the fix itself retries (`hurry`, below),
          // so the clock is a slow backstop rather than a host start every 30 s.
          ...(kind === 'unknown' ? {} : { retryEveryMs: SLOW_START_RETRY_MS }),
          retry: () => retryFailed(sessionId),
          giveUp: (reason: GiveUpReason) =>
            letGo(config, event, `no start in time (${reason})`, START_LET_GO_MESSAGE),
        });
        if (outcome === 'full' || outcome === 'expired') {
          await letGo(
            config,
            event,
            `no start in time (${outcome === 'full' ? 'list full' : 'timed out'})`,
            START_LET_GO_MESSAGE
          );
          continue;
        }
        // The box's list decides too: let go at once, before any line, if it's full.
        const box = await boxWait(event, sessionId, sinceMs, 'start', outcome);
        if (box === 'gone') continue;
        if (box) {
          await letGo(config, event, `no start in time (${box})`, START_LET_GO_MESSAGE);
          continue;
        }
        if (since === null) await record(() => assignments.waiting(event, sinceMs), false);
        // Once per message; again only if the last post didn't go through.
        promise(event, () => tellKept(config, event, kind));
      }
    };
    /**
     * The wait list's retry for a session that failed to start: started
     * again as if new, and handed its kept messages. True once it was started
     * (a failure again keeps them again, without a second line); false while
     * the box has no room for it.
     */
    const retryFailed = async (sessionId: string): Promise<boolean> => {
      const entry = pumps.get(sessionId);
      if (!entry?.queue.length) return true;
      if (stop.signal.aborted) return false;
      const failed = entry.failed;
      entry.failed = null;
      entry.restarts = 0;
      try {
        if (!links.ready(sharedSessionRoot(sessionId))) await launch(entry.config);
      } catch (failure) {
        entry.failed = failed;
        if (failure instanceof BoxFullError) return false;
        throw failure;
      }
      pump(entry.config);
      return true;
    };
    const pump = (config: SharedHostConfig) => {
      const sessionId = config.session.sessionId;
      const entry = pumps.get(sessionId)!;
      if (entry.running || entry.failed !== null || entry.waiting) return;
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
            entry.restarts = 0;
            // Answered: off the wait list, so its limit can't also let it go.
            waits.removeWhere(
              (waiter) =>
                waiter.host === owner.token &&
                waiter.sessionId === sessionId &&
                waiter.messageId === event.messageId
            );
            pending = pending.then(() => assignments.released(event, null));
            await pending;
          } catch (error) {
            if (error instanceof SessionHostFailedError) {
              entry.failed = error.failure;
              console.error(
                `Session ${sessionId} could not start: ${error.failure} Its ${entry.queue.length} room message(s) stay queued; it is started again when the room next addresses the agent or the session is restarted from Console.`
              );
              await keepAfterFailure(config, entry, await readStartFailureKind(sessionRoot));
              break;
            }
            if (!(error instanceof SessionUnavailableError)) throw error;
            if (entry.restarts >= MAX_HOST_RESTARTS) {
              entry.failed = `The session did not take a message after being started ${MAX_HOST_RESTARTS} times (${error.message}).`;
              console.error(
                `Session ${sessionId}: ${entry.failed} Its ${entry.queue.length} room message(s) stay queued; it is started again when the room next addresses the agent or the session is restarted from Console.`
              );
              await keepAfterFailure(config, entry, 'unknown');
              break;
            }
            entry.restarts++;
            // Not running, or it stopped before it answered: start it again
            // and hand the message over once it is back.
            console.warn(
              `Session ${sessionId} did not take message ${event.messageId} (${error.message}); starting it again.`
            );
            try {
              await launch(config);
            } catch (failure) {
              if (!(failure instanceof BoxFullError)) throw failure;
              // No room to start it again: what it holds waits for room, and
              // the wait list starts it and hands them over once there is.
              for (const queuedEvent of [...entry.queue])
                await waitForRoom(config, entry, queuedEvent);
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, OWNERSHIP_RETRY_MS));
          }
        }
        entry.running = false;
      })().catch((error: Error) => fail(error));
    };
    /** Records `write` in the journal: directly from inside the `pending` chain, else queued on it. */
    const record = async (write: () => Promise<void>, inChain: boolean): Promise<void> => {
      if (inChain) return write();
      pending = pending.then(write);
      await pending;
    };
    /** Posts one of the wait-for-room lines to the message's room (and thread), as the agent. */
    const tellRoom = (
      config: SharedHostConfig,
      event: Handoff,
      body: string,
      what: string
    ): Promise<boolean> =>
      announceBoxFull({
        identity,
        connectionId,
        session: config.session,
        root: sharedSessionRoot(config.session.sessionId),
        cwd: config.start.input.cwd,
        threadId: threadOf(event.event),
        body,
      }).then(
        () => true,
        (failure: unknown) => {
          console.error(
            `Could not tell room ${event.roomId} ${what}: ${
              failure instanceof Error ? failure.message : String(failure)
            }`
          );
          return false;
        }
      );
    /** Promises being posted now, by message, so a retry never posts one twice at once. */
    const promising = new Set<string>();
    /**
     * Tells the room a reset typed there could not be done, as the
     * session it was for: no line may claim a reset that didn't happen.
     */
    const resetFailed = async (
      command: { commandId: string; origin?: unknown },
      sessionId: string,
      why: string
    ): Promise<void> => {
      const origin = z
        .object({ roomId: z.string().nullable(), threadId: z.string().nullable() })
        .safeParse(command.origin);
      console.warn(
        `Could not reset session ${sessionId} for command ${command.commandId}: ${why}.`
      );
      const config = await sessionConfig(sessionId);
      if (!config || !origin.success || !origin.data.roomId) return;
      await announceBoxFull({
        identity,
        connectionId,
        session: config.session,
        root: sharedSessionRoot(sessionId),
        cwd: config.start.input.cwd,
        threadId: origin.data.threadId,
        body: RESET_FAILED_LINE,
      }).catch((error: unknown) =>
        console.error(
          `Could not tell room ${origin.data.roomId} that session ${sessionId} was not reset: ${errorName(error)}`
        )
      );
    };
    /**
     * A reset for a resting (parked) session: start its host the way a room
     * message would (the start limit and the memory ceiling apply), hand it
     * the reset, and let it say so and go back to rest. A host that can't be
     * started, or doesn't take it, is answered with the "couldn't" line.
     */
    const resetResting = async (
      command: { commandId: string; sessionId: string; origin?: unknown },
      sessionId: string,
      requesterName: unknown,
      told: boolean
    ): Promise<void> => {
      const config = await sessionConfig(sessionId);
      if (!config || (await stopped(sessionId))) {
        console.warn(
          `Dropped command ${command.commandId}: session ${sessionId} is not one this agent runs here.`
        );
        return;
      }
      // Already being woken, or awake by now (a room message got there
      // first): it was not resting, so the reset is an awake one, taken once
      // the host is up.
      const resting = !waking.has(sessionId) && !links.ready(sharedSessionRoot(sessionId));
      console.info(
        resting
          ? `Session ${sessionId} is resting; starting it to take reset ${command.commandId}.`
          : `Session ${sessionId} is waking; reset ${command.commandId} goes to it once it is up.`
      );
      try {
        if (resting || waking.has(sessionId)) await launch(config);
      } catch (error) {
        await resetFailed(
          command,
          sessionId,
          error instanceof BoxFullError
            ? 'the box is full'
            : `its host did not start (${errorName(error)})`
        );
        return;
      }
      const taken = await askSession(
        sessionId,
        {
          type: 'command',
          command,
          requesterName: typeof requesterName === 'string' ? requesterName : null,
          ...(resting ? { resting: true } : {}),
          ...(told ? {} : { roomTold: false }),
        },
        `command ${command.commandId}`,
        HOST_START_MS
      );
      if (!taken) await resetFailed(command, sessionId, 'its host did not take it');
    };
    /**
     * Tells a message's room it is kept or waiting, unless it was already
     * told: `told` is recorded only once the post went through, so a post
     * that failed is tried again at the next keep or wait.
     */
    const promise = (event: Handoff, post: () => Promise<boolean>): void => {
      const key = `${event.roomId}:${event.messageId}`;
      if (promising.has(key) || assignments.wasTold(event)) return;
      promising.add(key);
      void post()
        .then(async (posted) => {
          if (posted) await record(() => assignments.told(event), false);
        })
        .catch((error: unknown) =>
          console.warn(
            `Could not record that room ${event.roomId} was told about message ${event.messageId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        )
        .finally(() => promising.delete(key));
    };
    /**
     * Lets go of a message that was waiting for room: off its session's
     * queue, recorded as released with `reason` (its held text then leaves
     * the journal at the next compaction), and its room told `body`.
     */
    const letGo = async (
      config: SharedHostConfig,
      event: Handoff,
      reason: string,
      body: string,
      inChain = false
    ): Promise<void> => {
      const entry = pumps.get(config.session.sessionId);
      const index = entry?.queue.findIndex((queued) => queued.messageId === event.messageId) ?? -1;
      // Answered or let go already: one outcome per message, never a second.
      if (!entry || index < 0) return;
      entry.queue.splice(index, 1);
      if (!entry.queue.length) entry.waiting = false;
      await record(() => assignments.released(event, reason), inChain);
      void tellRoom(config, event, body, `it let go of the message (${reason})`);
    };
    /**
     * The box has no room to start this message's session (the 90% or
     * 15-awake gate refused it): the message waits for room instead of being
     * let go. Its room is told once, the first time; it is recorded as
     * waiting, with since when, so a restart keeps both; and the shared wait
     * list starts its session, oldest first, once the gate lets it in. Past
     * the list's limits (20 waiting, 10 minutes each) it is let go with the
     * agreed line instead.
     */
    const waitForRoom = async (
      config: SharedHostConfig,
      entry: Pump,
      event: Handoff,
      // Called from inside the `pending` chain (an event being routed): record
      // directly, since waiting on the chain from within it would never end.
      inChain = false,
      why: string = lastRefusal || 'the box is full'
    ): Promise<void> => {
      const sessionId = config.session.sessionId;
      const since = assignments.waitingSince(event);
      const sinceMs = since ?? Date.now();
      entry.waiting = true;
      const outcome = waits.add({
        agentId,
        sessionId,
        host: owner.token,
        roomId: event.roomId,
        messageId: event.messageId,
        sinceMs,
        retry: () => startWaiting(sessionId),
        giveUp: (reason: GiveUpReason) =>
          letGo(config, event, `no room in time (${reason})`, STOPPED_WAITING_MESSAGE),
      });
      // The box's list decides too: let go at once, before any line, if it's full.
      const box =
        outcome === 'waiting' ? await boxWait(event, sessionId, sinceMs, 'room', outcome) : null;
      if (box === 'gone') return;
      if (box) {
        console.warn(
          `Session ${sessionId} was not started for message ${event.messageId}: ${why}, and the box's wait list let it go (${box}).`
        );
        await letGo(config, event, `no room in time (${box})`, STOPPED_WAITING_MESSAGE, inChain);
        return;
      }
      if (outcome === 'already') {
        // Still waiting: only a line that didn't go through is tried again.
        promise(event, () =>
          tellRoom(config, event, WAITING_FOR_ROOM_MESSAGE, 'it is waiting for room')
        );
        return;
      }
      if (outcome === 'full' || outcome === 'expired') {
        console.warn(
          `Session ${sessionId} was not started for message ${event.messageId}: ${why}, and ${
            outcome === 'full'
              ? `${waits.max} messages already wait for room`
              : 'it has already waited its limit'
          }; letting it go.`
        );
        await letGo(
          config,
          event,
          `no room in time (${outcome === 'full' ? 'list full' : 'timed out'})`,
          STOPPED_WAITING_MESSAGE,
          inChain
        );
        return;
      }
      console.warn(
        `Session ${sessionId} was not started for message ${event.messageId}: ${why}. It waits for room (${waits.size} waiting in this box).`
      );
      // Said once per message: a restart finds it told and stays quiet.
      if (since === null) await record(() => assignments.waiting(event, sinceMs), inChain);
      promise(event, () =>
        tellRoom(config, event, WAITING_FOR_ROOM_MESSAGE, 'it is waiting for room')
      );
    };
    /** A reset of `sessionId` while messages wait for room to start it: each is let go with the reset line. */
    const letGoWaitingForReset = async (sessionId: string): Promise<void> => {
      const entry = pumps.get(sessionId);
      const removed = waits.removeWhere(
        (waiter) => waiter.host === owner.token && waiter.sessionId === sessionId
      );
      for (const waiter of removed) {
        const event = entry?.queue.find((queued) => queued.messageId === waiter.messageId);
        if (!entry || !event) continue;
        console.warn(
          `Session ${sessionId} was reset while message ${event.messageId} waited for room; letting it go.`
        );
        await letGo(
          entry.config,
          event,
          'reset while waiting for room',
          RESET_WHILE_WAITING_MESSAGE
        );
      }
    };
    /**
     * The wait list's retry: starts the session its messages wait for, through
     * the same gate as any start, and hands them over. False while there is
     * still no room.
     */
    const startWaiting = async (sessionId: string): Promise<boolean> => {
      if (stop.signal.aborted) return false;
      const entry = pumps.get(sessionId);
      if (!entry?.queue.length) return true;
      if (!links.ready(sharedSessionRoot(sessionId))) {
        try {
          await launch(entry.config);
        } catch (failure) {
          if (failure instanceof BoxFullError) return false;
          throw failure;
        }
      }
      entry.waiting = false;
      pump(entry.config);
      return true;
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
      const entry = pumps.get(sessionId) ?? {
        queue: [],
        running: false,
        failed: null,
        restarts: 0,
        config,
        waiting: false,
      };
      pumps.set(sessionId, entry);
      entry.config = config;
      const fresh = !entry.queue.some((queuedEvent) => queuedEvent.messageId === event.messageId);
      if (fresh) entry.queue.push(event);
      // Its session is already waiting for room: this one waits with it, in
      // its place behind the others, rather than asking the gate again.
      if (entry.waiting) {
        await waitForRoom(config, entry, event, true);
        return true;
      }
      // Others in the box are waiting for room, and this needs a start too:
      // it goes behind them rather than to the gate, so room that frees up
      // goes to the oldest first, and a round is run now for it.
      if (waits.waitingForRoom > 0 && !links.ready(sessionRoot)) {
        await waitForRoom(config, entry, event, true, 'others are already waiting for room');
        void waits.tick();
        return true;
      }
      // A host that failed to start is tried once more for each new message,
      // since whatever stopped it may have been fixed since.
      if (entry.failed !== null) {
        if (!fresh) return true;
        console.warn(
          `Room ${event.roomId} addressed the agent again; starting session ${sessionId} again after it failed (${entry.failed}).`
        );
        entry.failed = null;
        entry.restarts = 0;
      }
      if (!links.ready(sessionRoot)) {
        try {
          await launch(config);
        } catch (failure) {
          if (!(failure instanceof BoxFullError)) throw failure;
          // No room to start it: what its session holds waits for room.
          for (const queuedEvent of [...entry.queue])
            await waitForRoom(config, entry, queuedEvent, true);
          return true;
        }
      }
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
    const admit = async (event: Handoff, spawning: boolean, waiting: boolean): Promise<boolean> => {
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
      if (!spawning) return false;
      const config = await assignments.assign(
        sharedConfigSchema.parse(JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))),
        event
      );
      await placements.place(config.session.sessionId, event.roomId);
      publishQuietly();
      if (stream?.announcesSessionStarts) await tellStarting(config, event);
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
      if (!parked) await assignments.park(event, spawning);
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
    stream = openStream({
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
      onConnected: () => {
        control.report({ state: 'connected', detail: null });
        publishQuietly();
        // Switch is back: the posts held while it was away go now, each to
        // the room its session still attends (placements are stated first).
        if (heldReplies.size) {
          const retry = () => heldReplies.retryNow();
          void publishing.then(retry, retry);
        }
        // On every connection, not just the first: an outage of Switch longer
        // than a start's tries leaves "I was restarted" lines owed, and only
        // a reconnect says Switch can take them now.
        const first = !resumedCutOff;
        resumedCutOff = true;
        void resumeCutOffSessions({ first }).catch((error: unknown) =>
          console.warn(
            `Could not check this agent's sessions for turns a restart cut off: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
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
      onRoomGone: async ({ roomId, sessionId }) => {
        pending = pending.then(async () => {
          if (placements.roomOf(sessionId) !== roomId) return;
          await placements.roomLost(roomId);
          console.warn(
            `Room ${roomId} is no longer this agent's (deleted, or the agent taken out); session ${sessionId} no longer attends it.`
          );
          publishQuietly();
        });
        return pending.catch((error: Error) => {
          fail(error);
          throw error;
        });
      },
      onApprovalOutcome: async (outcome) => {
        await askSession(outcome.session_id, { type: 'approvals' }, 'an approval answer', 0);
      },
      // A room control (!reset, !interrupt) typed in one of the agent's rooms,
      // which only Switch sees. Handed to the session's host like any other.
      onSessionCommand: async (relayed) => {
        const { requesterName, roomId, roomTold, ...rest } = relayed;
        const sessionId =
          rest.sessionId ?? (typeof roomId === 'string' ? placements.sessionIn(roomId) : null);
        if (!sessionId) {
          console.warn(
            `Dropped command ${rest.commandId}: no session of this agent works in room ${String(roomId)}.`
          );
          return;
        }
        const command = { ...rest, sessionId };
        // Messages waiting for room to start this session are not started
        // after a reset: each is let go, and its room told why.
        if (isReset(command)) await letGoWaitingForReset(sessionId);
        const told = roomTold !== false;
        // A resting session has no host to take the reset, so it is started
        // for it, and goes back to rest once its conversation is cleared (the
        // reset was once dropped here, while the room was told it was under way).
        if (isReset(command) && !links.ready(sharedSessionRoot(sessionId))) {
          await resetResting(command, sessionId, requesterName, told);
          return;
        }
        // A reset runs in the host the session has, which keeps the tools it
        // started with: one granted or taken away since needs a new host first.
        const restarted =
          isReset(command) &&
          (await restartForServices(sessionId).catch((error: unknown) => {
            console.warn(
              `Could not restart session ${sessionId} for its agent's granted services before its reset, so it is reset with the tools it has: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
          }));
        // A retry is for a turn that failed, and a failure can take the session's
        // host down with it (a provider error faults it): started again, as a
        // room message would start it, rather than dropped for not running.
        const relaunched =
          isRetry(command) && !links.ready(sharedSessionRoot(sessionId))
            ? await sessionConfig(sessionId).then(async (config) => {
                if (!config) return false;
                await launch(config);
                return true;
              })
            : false;
        const taken = await askSession(
          sessionId,
          {
            type: 'command',
            command,
            requesterName: typeof requesterName === 'string' ? requesterName : null,
            ...(told ? {} : { roomTold: false }),
          },
          `command ${command.commandId}`,
          // A reset can wait for a session still starting (shared-host): the
          // answer is waited for as long, so it isn't taken as never given.
          restarted || relaunched ? HOST_START_MS : isReset(command) ? SESSION_READY_MS + 5_000 : 0
        );
        if (!taken) {
          console.warn(
            `Dropped command ${command.commandId}: session ${sessionId} is not running here.`
          );
          if (isReset(command)) await resetFailed(command, sessionId, 'its host did not take it');
        }
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
        fail(new Error(`Shared SDK watcher was evicted: ${reason}`));
      },
    });
    const started = stream;
    started.start();
    unbind.push(
      control.bind({
        stopForMemory: () =>
          announceMemoryStop({
            root,
            busy: busySessions,
            placed: () => Object.keys(placements.snapshot()),
            roomOf: (sessionId) => placements.roomOf(sessionId),
            sessionConfig,
            sessionRoot: sharedSessionRoot,
            identity,
            connectionId,
          }),
        forget: async (sessionId) => {
          const entry = pumps.get(sessionId);
          waits.removeWhere(
            (waiter) => waiter.host === owner.token && waiter.sessionId === sessionId
          );
          if (entry) {
            // Each message it still owed is released, so a restart can't
            // answer it from a new session. One that was told it is kept
            // (or waiting) is told it was let go, once, while the session is
            // still placed for Switch to post as; one never promised anything
            // isn't told now either.
            for (const dropped of entry.queue.splice(0)) {
              const promised = assignments.waitingSince(dropped) !== null;
              await record(() => assignments.released(dropped, 'session deleted'), false);
              if (promised)
                await tellRoom(
                  entry.config,
                  dropped,
                  SESSION_CLOSED_MESSAGE,
                  'its session was closed and its message let go'
                );
            }
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
        // Queued with the events, so a message arriving meanwhile finds the
        // session this placed rather than starting a second one.
        warm: (roomId) => {
          /**
           * A warm is owed nothing: one the box has no room for is skipped
           * quietly, at info, and answers null like any warm not done.
           * The room's first message starts the session as usual.
           */
          const warmLaunch = async (config: SharedHostConfig): Promise<boolean> => {
            try {
              await launch(config, 'warm');
              return true;
            } catch (error) {
              if (!(error instanceof BoxFullError)) throw error;
              console.info(
                `Skipped warming session ${config.session.sessionId} for room ${roomId}: ${lastRefusal || 'the box is full'}.`
              );
              return false;
            }
          };
          const run = async (): Promise<string | null> => {
            const placed = placements.sessionIn(roomId);
            if (placed) {
              const owner = await sessionConfig(placed);
              if (owner && !(await stopped(placed))) {
                if (!links.ready(sharedSessionRoot(placed)) && !(await warmLaunch(owner)))
                  return null;
                return placed;
              }
            }
            if (!spawn) return null;
            const config = await assignments.warm(await currentTemplate(), roomId);
            await placements.place(config.session.sessionId, roomId);
            publishQuietly();
            if (!(await warmLaunch(config))) return null;
            return config.session.sessionId;
          };
          const warmed = pending.then(run);
          pending = warmed.then(
            () => {},
            () => {}
          );
          return warmed;
        },
      })
    );
    // Queued behind the events rather than run beside them: the decision it
    // takes is the same one the handler takes, and two of them at once could
    // start a session for a room the other has just found an owner for.
    retry = setInterval(() => {
      if (!held.size) return;
      pending = pending.then(resolveHeld);
      void pending.catch((error: Error) => fail(error));
    }, OWNERSHIP_RETRY_MS);
    retry.unref();
    /**
     * Brings this watcher's live sessions in step with its agent's definition, as
     * whoever runs the watcher last wrote it to `config.json` (the agents
     * controller on a new revision, Console when the agent's settings are
     * saved). Each session saved under an earlier definition is restarted on
     * its own conversation under the current one (`withDefinitionOf`) once it
     * is idle, so no turn is cut short: one in the middle of a turn waits in
     * `redefinitionDue` until its host says it is done. One saved under another
     * provider or directory belongs to an earlier identity of the agent and is
     * left alone.
     *
     * A session whose host started under other granted services than the
     * agent has now (`servicesNow`, read every `GRANTS_CHECK_MS`) is restarted
     * the same way: its tools are built as its host starts, so a service
     * granted or taken away reaches it only through a new host.
     */
    const redefinitionDue = new Set<string>();
    let redefining = false;
    const applyDefinition = async () => {
      const current = await currentTemplate();
      redefinitionDue.clear();
      const ours = new Set(
        assignments.sessions().map((config) => sharedSessionRoot(config.session.sessionId))
      );
      const idle: { root: string; saved: SharedHostConfig }[] = [];
      for (const sessionRoot of links.live()) {
        if (!ours.has(sessionRoot) || !links.ready(sessionRoot)) continue;
        const saved = await sessionConfigAt(sessionRoot);
        if (
          !saved ||
          saved.session.agentId !== agentId ||
          saved.start.provider !== current.start.provider ||
          saved.start.input.cwd !== current.start.input.cwd
        )
          continue;
        if (!definitionChanged(saved, current) && !(await servicesStale(sessionRoot, servicesNow)))
          continue;
        if (links.busy(sessionRoot)?.busy !== false) redefinitionDue.add(sessionRoot);
        else idle.push({ root: sessionRoot, saved });
      }
      if (idle.length === 0 && redefinitionDue.size === 0) return;
      console.warn(
        `Agent ${agentId}'s definition or granted services changed: restarting ${idle.length} idle session(s) under them now; ${redefinitionDue.size} more once their turn ends.`
      );
      for (const { root: sessionRoot, saved } of idle) {
        console.warn(
          `Session ${saved.session.sessionId} runs under an earlier definition of its agent (model, instructions, advanced configuration or approval mode) or its granted services; restarting it on the same conversation under the current ones.`
        );
        if (servicesNow !== null) restartedFor.set(sessionRoot, servicesNow);
        try {
          await ensureSharedProcess({
            root: sessionRoot,
            config: reachableBy(withDefinitionOf(saved, current), connectionId),
            resuming: true,
            watcher: false,
            restart: true,
            supervision,
            startSource: null,
          });
        } catch (error) {
          console.warn(
            `Could not restart session ${saved.session.sessionId} under its agent's current definition: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    };
    // A turn ending while the definition is being applied is not lost: the
    // pass is run again once the one under way is done.
    let again = false;
    const redefine = () => {
      if (redefining) {
        again = true;
        return;
      }
      redefining = true;
      pending = pending
        .then(applyDefinition)
        // A replaced definition or login may be what a kept message waits
        // for: its session is tried again now, not on its slow clock.
        .then(() => {
          void waits.hurry((waiter) => waiter.host === owner.token);
        })
        .finally(() => {
          redefining = false;
          if (!again) return;
          again = false;
          redefine();
        });
      void pending.catch((error: Error) => fail(error));
    };
    unbind.push(
      onConfigReplaced(root, stop.signal, redefine),
      links.onBusy((busyRoot) => {
        if (redefinitionDue.has(busyRoot) && links.busy(busyRoot)?.busy === false) redefine();
      }),
      links.onExit((exitedRoot) => {
        redefinitionDue.delete(exitedRoot);
      })
    );
    /** Whether any session of this agent's has a host running here. */
    const anyLive = (): boolean => {
      const ours = new Set(
        assignments.sessions().map((config) => sharedSessionRoot(config.session.sessionId))
      );
      return links.live().some((sessionRoot) => ours.has(sessionRoot));
    };
    let checkingGrants = false;
    grantsCheck = setInterval(() => {
      if (checkingGrants || !anyLive()) return;
      checkingGrants = true;
      void (async () => {
        const shape = await currentServicesShape(await currentTemplate());
        if (shape === null) return;
        servicesNow = shape;
        redefine();
      })()
        .catch((error: unknown) => {
          console.warn(
            `Could not check agent ${agentId}'s granted services: ${error instanceof Error ? error.message : String(error)}`
          );
        })
        .finally(() => {
          checkingGrants = false;
        });
    }, GRANTS_CHECK_MS);
    grantsCheck.unref();
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
      if (spawn) {
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
    if (grantsCheck) clearInterval(grantsCheck);
    signal.removeEventListener('abort', abort);
    await pending.catch(() => {});
    // What a release scheduled is compacted before the host lets go of the journal.
    await assignmentsOpened?.close().catch(() => {});
    const failure = fault ?? thrown;
    control.report({
      state: failure ? 'not-running' : ending.state,
      detail: failure
        ? failure instanceof Error
          ? failure.message
          : String(failure)
        : ending.detail,
      placements: {},
      busy: [],
      sessions: {},
    });
    await releaseOwner(root, ownerPath, owner);
    if (heldOwners.get(ownerPath) === owner.token) heldOwners.delete(ownerPath);
  }
  if (fault) throw fault;
}

/** An error's name or code for a log: never its message, which can carry a path. */
function errorName(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.name : 'unknown error';
}

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EVICTION_HEARTBEAT_LAPSED,
  EVICTION_TAKEN_OVER,
  SwitchEventStream,
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
import { roomInputId, SharedRoomInbox } from './room-inbox';
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
 */
const parkedSchema = z.strictObject({
  parked: z.number().int().positive(),
  roomId: z.string().min(1),
  messageId: z.string().min(1),
});
const recordSchema = z.union([assignmentSchema, restartSchema, handledSchema, parkedSchema]);

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

function isAssignment(record: WatchRecord): record is Assignment {
  return !restarted(record) && !isHandled(record) && !isParked(record);
}

/**
 * How often a room whose owner is undecided is asked about again. The same
 * cadence a session re-asserts its binding on, which is what the answer is
 * waiting for.
 */
const OWNERSHIP_RETRY_MS = 5000;

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

/** What the sessions on disk say about who holds a room. */
type Ownership = {
  /** The running session the server has confirmed serving the room, if any. */
  owner: SharedHostConfig | null;
  /** The room was given to a session of this agent and is no longer its. */
  taken: boolean;
  /**
   * Running sessions of this agent that could be holding the room without
   * having said so. The one the room was taken from is not among them: it is
   * the evidence the room moved, not a candidate to have it.
   */
  candidates: number;
};

/**
 * Who holds the room, read from the sessions on disk rather than from the ones
 * this watcher assigned.
 *
 * A session somebody started from Console is not in the assignment journal and
 * has no connection of its own to hear on, so without looking for it the
 * watcher would both leave it unreachable and start a second session for a room
 * it is already answering. Only a session the server has confirmed serving the
 * room counts as its owner: the rooms are the ones it was told when it bound,
 * not an intention anybody wrote down locally. A session that was told the room
 * and is no longer is evidence the other way — the room was taken by a sibling
 * that bound it, whether or not that sibling has written anything yet.
 */
async function roomOwnership(agentId: string, roomId: string): Promise<Ownership> {
  const ownership: Ownership = { owner: null, taken: false, candidates: 0 };
  const base = sharedSessionsBase();
  let names: string[];
  try {
    names = await readdir(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ownership;
    throw error;
  }
  for (const name of names) {
    const root = join(base, name);
    let config: SharedHostConfig;
    try {
      config = sharedConfigSchema.parse(
        JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
      );
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    if (config.session.agentId !== agentId) continue;
    const saved = await SharedRoomInbox.savedRooms(root);
    const running = !(await stopped(config.session.sessionId));
    if (saved?.rooms.includes(roomId)) {
      if (running) ownership.owner = config;
    } else if (saved?.everHeld.includes(roomId)) ownership.taken = true;
    else if (running) ownership.candidates += 1;
  }
  return ownership;
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
 * Replaces this agent's sessions that are still running the build the watcher
 * has just superseded. A session is supervised independently of the watcher,
 * so nothing else would: it would go on answering its room with code the
 * deployment moved past until somebody restarted it by hand. Only a session
 * with a live supervisor is touched — one that is not running was not left
 * behind by an upgrade, and starting it here would reopen a session its owner
 * had closed.
 */
export async function replaceSupersededSessions(
  agentId: string,
  connectionId: string,
  supervision: Supervision
): Promise<void> {
  const base = sharedSessionsBase();
  let names: string[];
  try {
    names = await readdir(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
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

  /**
   * Where the stream reopens: the last sequence whose routing reached disk, and
   * never past an event still waiting for its room's owner.
   *
   * An assignment on its own is not a position. The watcher can die between
   * recording which session serves a room and handing that session the event,
   * and reopening past the event would leave nothing holding it: this is the
   * agent's single connection, so there is no second copy of what it was sent.
   * A held event is the same case — the server's buffer is the only copy of it,
   * so the position stays behind it and the events after it are served again
   * and recognised as ones already dealt with.
   */
  get cursor(): number {
    let complete = 0;
    let assigned = 0;
    const parked = new Set<number>();
    const handled = new Set<number>();
    for (const record of this.current) {
      if (isHandled(record)) {
        complete = Math.max(complete, record.handled);
        handled.add(record.handled);
      } else if (isParked(record)) parked.add(record.parked);
      else if (isAssignment(record)) {
        // An assignment is only made once the one before it has been routed, so
        // a journal written before routing was recorded still resumes at its
        // last complete event instead of from the beginning.
        complete = Math.max(complete, assigned);
        assigned = record.sequence;
      }
    }
    const held = [...parked].filter((sequence) => !handled.has(sequence));
    return held.length ? Math.min(complete, Math.min(...held) - 1) : complete;
  }

  /** Records that the event has been routed, or decided not to be. */
  async handled(sequence: number): Promise<void> {
    await this.journal.append({ handled: sequence });
  }

  /** Records that the event is waiting for its room's owner to be decided. */
  async park(event: { sequence: number; roomId: string; messageId: string }): Promise<void> {
    await this.journal.append({
      parked: event.sequence,
      roomId: event.roomId,
      messageId: event.messageId,
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
   * The session already serving this room; null if the room is nobody's, and
   * `undecided` if it belongs to a session that has not been identified yet.
   * Answered from disk, because the session it names may be stopped and unable
   * to answer for itself.
   *
   * What the server says outranks what this watcher remembers: a session is
   * serving the room if the rooms it was told when it bound say so, whoever
   * started it. Failing that, the last session this watcher started for the
   * room still counts while the server has never given it a room — the room
   * becomes the session's when the agent in it connects to the room, and it
   * cannot have done that before the message that started it arrives.
   *
   * A room taken from a session was taken by a sibling that bound it, and that
   * sibling may not have written down what it holds yet. Nothing local can name
   * it in that window, and taking its silence for an empty room is what starts a
   * second session for a room that already has one. So the room is undecided
   * rather than free for as long as any session of the agent is running to
   * claim it.
   */
  async serving(agentId: string, roomId: string): Promise<SharedHostConfig | null | 'undecided'> {
    const previous = [...this.every].reverse().find((record) => record.roomId === roomId);
    const mine =
      previous && !(await stopped(previous.config.session.sessionId)) ? previous.config : null;
    const saved = mine
      ? await SharedRoomInbox.savedRooms(sharedSessionRoot(mine.session.sessionId))
      : null;
    if (mine && (saved === null || saved.rooms.includes(roomId))) return mine;
    const { owner, taken, candidates } = await roomOwnership(agentId, roomId);
    if (owner) return owner;
    if (mine && saved && saved.everHeld.length === 0) return mine;
    const lost = saved !== null && saved.everHeld.includes(roomId);
    return (taken || lost) && candidates > 0 ? 'undecided' : null;
  }

  async assign(
    template: SharedHostConfig,
    event: { sequence: number; roomId: string; messageId: string }
  ): Promise<SharedHostConfig | 'undecided'> {
    const duplicate = this.current
      .filter(isAssignment)
      .find((record) => record.sequence === event.sequence);
    if (duplicate) {
      if (duplicate.roomId !== event.roomId || duplicate.messageId !== event.messageId)
        throw new Error('Watcher sequence changed message identity.');
      return duplicate.config;
    }
    const connectionId = template.roomConnection?.connectionId;
    if (!connectionId)
      throw new Error('A watcher assignment needs the connection its agent is reached over.');
    // Every session here is reached over the template's connection, which is
    // this agent's one inbound connection: what reaches a session reaches it
    // through here, whether the session is new or was saved naming its own.
    const serving = await this.serving(template.session.agentId, event.roomId);
    if (serving === 'undecided') return serving;
    let config = serving && reachableBy(serving, connectionId);
    if (!config) {
      config = structuredClone(template);
      const sessionId = sessionIdFor(template.session.agentId, event.roomId, event.messageId);
      config.session = { ...config.session, sessionId, hostId: randomUUID(), epoch: randomUUID() };
      config.start.input.sessionId = sessionId;
      if (config.start.input.env.SWITCHDASH_SESSION_ID !== undefined)
        config.start.input.env.SWITCHDASH_SESSION_ID = sessionId;
      delete config.start.input.resume;
      // Said here rather than left to the worker to say when it starts. The
      // event that caused this session is routed to it before it is started,
      // and the worker it will be started from is this bundle's, which reads
      // what it is handed; waiting for it to say so itself would drop that
      // event, and with it the message the session exists to answer.
      const sessionRoot = sharedSessionRoot(sessionId);
      await mkdir(sessionRoot, { recursive: true });
      await declareHandoffCapability(sessionRoot);
    }
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
    const route = async (config: SharedHostConfig, event: Handoff) => {
      const sessionRoot = sharedSessionRoot(config.session.sessionId);
      if (await readsHandoffs(sessionRoot)) await handOff(sessionRoot, event);
    };
    await replaceSupersededSessions(template.session.agentId, connectionId, supervision);
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
     */
    const admit = async (event: Handoff, spawning: boolean): Promise<boolean> => {
      const config = spawning
        ? await assignments.assign(
            sharedConfigSchema.parse(JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))),
            event
          )
        : await assignments.serving(template.session.agentId, event.roomId);
      if (config === 'undecided') return false;
      if (config) await route(config, event);
      // Recorded before the session is started, because starting it is
      // recoverable — every assigned session is launched again when the
      // watcher restarts — where the routing decision is not.
      await assignments.handled(event.sequence);
      if (config && spawning) await launch(config);
      return true;
    };
    const hold = async (event: Handoff, spawning: boolean) => {
      const waiting = held.get(event.roomId);
      if (waiting) waiting.events.push({ event, spawning });
      else {
        held.set(event.roomId, { events: [{ event, spawning }], since: Date.now() });
        console.warn(
          `Room ${event.roomId} was taken from a session of this agent and no running session has claimed it yet; holding its messages until one does.`
        );
      }
      await assignments.park(event);
    };
    /** Re-asks who owns each held room, and answers the ones that now have one. */
    const resolveHeld = async () => {
      for (const [roomId, waiting] of [...held]) {
        while (
          waiting.events.length &&
          (await admit(waiting.events[0]!.event, waiting.events[0]!.spawning))
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
          if (held.has(assignment.roomId)) return hold(assignment, spawning);
          if (!(await admit(assignment, spawning))) await hold(assignment, spawning);
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
    signal.removeEventListener('abort', abort);
    await pending.catch(() => {});
    await releaseOwner(root, ownerPath, owner);
  }
  if (fault) throw fault;
}

import { mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventStreamLogger } from '@sandboxaq/switch-agent-runtime';
import { z } from 'zod';
import type { ProviderAdapter } from '../adapter';
import { onProcessGroupsChanged, sweepProcessGroups } from '../process-tree';
import { ensureSharedProcess, launchLock, liveSessionOwner, sharedSessionRoot } from './launch';
import { replaceOwner, withOwnershipLock } from './ownership-lock';
import { checkProviderReadiness } from './provider-readiness';
import { SharedRoomInbox } from './room-inbox';
import { adapterCapabilities, adapterFor } from './server';
import { prepareSharedConfig, type SharedHostConfig } from './shared-config';
import { runSharedHost, SharedHostLeaseExpiredError } from './shared-host';

/**
 * Switch caps an agent at 32 open connections. The resident host spends one on
 * the watcher's discovery connection, so this is the number of room sessions it
 * can hold before the server starts refusing. It is an early warning only: other
 * clients of the same agent hold slots too, so the server's own refusal — seen
 * as a room admission failure — is the authority.
 */
export const ROOM_CONNECTION_BUDGET = 31;

/** A room session that cannot be admitted is a visible failure, not a long wait. */
export const ROOM_ADMISSION_TIMEOUT_MS = 60000;

/**
 * How long a stopping room session has to drain before the host stops waiting
 * on it. A provider child that never exits must not hold the host — and its
 * supervisor — open through a SIGTERM.
 */
export const RESIDENT_STOP_TIMEOUT_MS = 15000;

/** Immutable identity carried by every provider and tool call of one room session. */
export type RoomSessionContext = {
  readonly roomId: string;
  readonly sessionId: string;
  readonly connectionId: string;
};

export type RoomSessionRun = (input: {
  context: RoomSessionContext;
  root: string;
  config: SharedHostConfig;
  signal: AbortSignal;
}) => Promise<void>;

export type RoomSessionFault = { context: RoomSessionContext; message: string };

/**
 * A room session whose provider processes could not be proven stopped.
 *
 * This is not an ordinary fault. Releasing the session's ownership would let the
 * next dispatch open its state, tell Switch the host has quiesced and recover a
 * new epoch while the old provider may still be executing. So the records are
 * kept, the room is refused until they are gone, and nothing here recovers
 * automatically.
 */
export class ResidentTeardownError extends Error {
  constructor(
    readonly context: RoomSessionContext,
    cause: unknown,
    earlier: unknown
  ) {
    super(
      `Room session ${context.sessionId} could not be proven stopped: ${String(cause)}` +
        (earlier ? ` It had already failed with: ${String(earlier)}` : '') +
        ' Its ownership records were kept, so room ' +
        context.roomId +
        ' will not start another session until those processes are confirmed gone.'
    );
    this.name = 'ResidentTeardownError';
  }
}

export interface SessionDispatcher {
  /** True when a stop left room sessions behind and the worker must not linger. */
  readonly incomplete: boolean;
  dispatch(roomId: string, config: SharedHostConfig): Promise<void>;
  /**
   * Records a room that could not be admitted at all. Dispatch refuses some
   * rooms — a second session claiming one, a config bound elsewhere — and the
   * caller holds every other room of the agent, so the refusal is recorded
   * against the room rather than raised at whoever was dispatching.
   */
  reject(roomId: string, config: SharedHostConfig, error: unknown): Promise<void>;
  /** Resolves true when the session is proven stopped. */
  stop(sessionId: string): Promise<boolean>;
  live(): RoomSessionContext[];
  failures(): RoomSessionFault[];
  stopAll(): Promise<void>;
}

/**
 * The admission identity of one room session, checked against the room the
 * event actually arrived in.
 *
 * Switch verifies agent membership and the retained event when a room message is
 * submitted, but it cannot check that the event's room is the session's bound
 * room — the first dispatch happens before any binding exists. This map is
 * therefore the only thing that keeps a room's messages out of another room's
 * conversation, so the room is passed explicitly and never inferred from
 * whichever session ran last.
 */
export function roomSessionContext(roomId: string, config: SharedHostConfig): RoomSessionContext {
  const connection = config.roomConnection;
  if (!connection)
    throw new Error(`Room ${roomId} was dispatched with no room connection identity.`);
  if (connection.rooms.length !== 1 || connection.rooms[0] !== roomId)
    throw new Error(
      `Room ${roomId} was dispatched to a session bound to [${connection.rooms.join(', ')}]. A room session serves exactly one room.`
    );
  if (config.session.sessionId !== config.start.input.sessionId)
    throw new Error(`Room ${roomId} was dispatched with mismatched session identities.`);
  return Object.freeze({
    roomId,
    sessionId: config.session.sessionId,
    connectionId: connection.connectionId,
  });
}

/**
 * What the host's own environment held when it started.
 *
 * Per-session identity reaches a provider through that child's environment and
 * nowhere else. A resident host running many rooms must therefore never write
 * these into its own environment: the next session to read them would inherit
 * the previous one's identity. Whatever the host inherited is recorded once and
 * then only checked for change — `executionEnvironment` already strips `SWITCH_*`
 * out of what a provider child inherits, so an ambient value is harmless, and a
 * *changed* one is the bug this catches.
 */
const HOST_ENVIRONMENT_BASELINE: Record<string, string | undefined> = Object.freeze({
  SWITCH_CONNECTION_ID: process.env.SWITCH_CONNECTION_ID,
  SWITCHDASH_SESSION_ID: process.env.SWITCHDASH_SESSION_ID,
});

/** Every provider child gets its identity from its own config, never from the host. */
export function assertSessionEnvironment(
  context: RoomSessionContext,
  env: Record<string, string>,
  sessionId: string
): void {
  if (sessionId !== context.sessionId)
    throw new Error(`Session ${context.sessionId} prepared provider input for ${sessionId}.`);
  if (env.SWITCH_CONNECTION_ID !== context.connectionId)
    throw new Error(
      `Session ${context.sessionId} prepared a provider environment for connection ${env.SWITCH_CONNECTION_ID ?? '(unset)'} rather than ${context.connectionId}.`
    );
  if (env.SWITCHDASH_SESSION_ID !== undefined && env.SWITCHDASH_SESSION_ID !== context.sessionId)
    throw new Error(
      `Session ${context.sessionId} prepared a provider environment for session ${env.SWITCHDASH_SESSION_ID}.`
    );
  // What pins the session's Switch tools to one room. A config with no execution
  // credentials carries no Switch tools and so no pin.
  if (env.SWITCH_BOUND_ROOM_ID !== undefined && env.SWITCH_BOUND_ROOM_ID !== context.roomId)
    throw new Error(
      `Session ${context.sessionId} prepared a provider environment bound to room ${env.SWITCH_BOUND_ROOM_ID} rather than ${context.roomId}.`
    );
  for (const [key, baseline] of Object.entries(HOST_ENVIRONMENT_BASELINE))
    if (process.env[key] !== baseline)
      throw new Error(
        `The resident host changed ${key} in its own environment. Per-session identity must reach a provider through that child's environment only.`
      );
}

/** The host's own environment as it was before any room session started. */
export function hostEnvironmentBaseline(): Record<string, string | undefined> {
  return { ...HOST_ENVIRONMENT_BASELINE };
}

/**
 * Keeps the stream's own refusal so an admission failure can quote the server
 * rather than guess why a room never opened.
 */
export function streamAdmissionLog(base: EventStreamLogger): {
  log: EventStreamLogger;
  lastRefusal(): string | null;
} {
  let refusal: string | null = null;
  const capture = (meta: Record<string, unknown> | undefined) => {
    const detail = meta?.error ?? meta?.detail;
    if (
      typeof detail === 'string' &&
      (meta?.event === 'switch_stream_error' || meta?.event === 'switch_stream_room_refused')
    )
      refusal = detail.slice(0, 500);
  };
  return {
    log: {
      debug: (message, meta) => base.debug(message, meta),
      warn: (message, meta) => {
        capture(meta);
        base.warn(message, meta);
      },
      error: (message, meta) => {
        capture(meta);
        base.error(message, meta);
      },
    },
    lastRefusal: () => refusal,
  };
}

/**
 * Per-session teardown. A resident host reaps its own children, so it must also
 * drop the ownership record a supervisor would otherwise have fenced. Leaving it
 * behind would make the next start of this session refuse to run: the recorded
 * owner is this very host, and it is still alive.
 */
export async function releaseSessionOwnership(root: string): Promise<void> {
  const path = join(root, 'shared-owner.lock');
  await withOwnershipLock(root, async () => {
    try {
      const owner: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (
        owner &&
        typeof owner === 'object' &&
        'pid' in owner &&
        (owner as { pid: unknown }).pid === process.pid
      )
        await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  });
}

const GROUPS_FILE = 'groups.json';

const recordedGroups = z.object({ pid: z.number(), groups: z.array(z.number()) });

/** Makes this session's live provider groups readable by a later host. */
async function saveProcessGroups(root: string, groups: number[]): Promise<void> {
  const path = join(root, 'supervisor', GROUPS_FILE);
  if (groups.length === 0) {
    await unlinkIfPresent(path);
    return;
  }
  await mkdir(join(root, 'supervisor'), { recursive: true, mode: 0o700 });
  await replaceOwner(path, { pid: process.pid, groups });
}

/**
 * Terminate provider groups a previous host left running for this session.
 *
 * A host that was SIGKILLed took no provider with it: those groups are not in
 * its own group and outlive its fence. Sweeping them is what makes it safe to
 * claim the session and tell Switch the old host quiesced. A group that cannot
 * be proven gone fails the claim.
 */
async function sweepRecordedGroups(root: string): Promise<void> {
  const path = join(root, 'supervisor', GROUPS_FILE);
  let record: z.infer<typeof recordedGroups>;
  try {
    record = recordedGroups.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (record.pid === process.pid) return;
  await sweepProcessGroups(
    record.groups,
    `Providers left by SDK host ${record.pid} for this session`
  );
  await unlinkIfPresent(path);
}

async function unlinkIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

/**
 * Take ownership of a room session's state directory before anything slow runs.
 *
 * `ensureSharedProcess` adopts a session whose supervisor is alive rather than
 * starting a competitor, and it decides that from `supervisor/owner.json` and
 * the saved `config.json`. Both are written here, under the directory's own
 * ownership lock and before the provider probe, so there is no window in which a
 * Console `--ensure` sees an unowned directory and spawns a rival supervisor.
 * The `resident` mark is what turns a restart request into an error naming the
 * host to restart. A failure recorded by an earlier run is cleared at the same
 * time; leaving it would report a fault this session has already recovered from.
 */
async function claimResidentSession(root: string, config: SharedHostConfig): Promise<void> {
  const directory = join(root, 'supervisor');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await withOwnershipLock(launchLock(root), async () => {
    const owner = await liveSessionOwner(root);
    // A per-room worker can outlive the watcher that started it. Its marker is
    // how anything else knows not to compete with it, so a claim reads before it
    // writes and leaves a live stranger's records exactly as they are.
    if (owner && owner.pid !== process.pid)
      throw new Error(
        `Room ${config.roomConnection?.rooms[0] ?? '(unbound)'} is owned by a live process (pid ${owner.pid}); the resident host will not take it over.`
      );
    // Before anything here claims the session, whatever the last host left
    // executing for it must be gone.
    await sweepRecordedGroups(root);
    await unlinkIfPresent(join(directory, 'failure.json'));
    await replaceOwner(join(root, 'config.json'), config);
    await replaceOwner(join(directory, 'owner.json'), { pid: process.pid, resident: true });
  });
}

/** Only this host's own record is dropped; a later owner's is left alone. */
async function releaseResidentSession(root: string): Promise<void> {
  const path = join(root, 'supervisor', 'owner.json');
  await withOwnershipLock(launchLock(root), async () => {
    try {
      const owner: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (
        owner &&
        typeof owner === 'object' &&
        'pid' in owner &&
        (owner as { pid: unknown }).pid === process.pid
      )
        await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  });
}

async function recordFailure(root: string, message: string): Promise<void> {
  await mkdir(join(root, 'supervisor'), { recursive: true, mode: 0o700 });
  await replaceOwner(join(root, 'supervisor', 'failure.json'), { message });
}

/** One room session, run in the agent's resident host rather than its own process tree. */
export async function runResidentRoomSession(
  input: Parameters<RoomSessionRun>[0],
  readiness: Map<string, Promise<void>>
): Promise<void> {
  const { context, root, config, signal } = input;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await claimResidentSession(root, config);
  let adapter: ProviderAdapter | null = null;
  let failure: unknown = null;
  try {
    const prepared = await prepareSharedConfig(root, config, context.roomId);
    assertSessionEnvironment(context, prepared.input.env, prepared.input.sessionId);
    const binaryPath =
      config.execution?.binaryPath ??
      (config.start.provider === 'cursor' ? 'agent' : config.start.provider);
    // Sessions of one agent share a provider, a working directory and an
    // installation, so the sign-in probe is a host-level check, not a per-room one.
    const key = JSON.stringify([config.start.provider, binaryPath, prepared.input.cwd]);
    let probe = readiness.get(key);
    if (!probe) {
      probe = (async () => {
        const result = await checkProviderReadiness({
          provider: config.start.provider,
          binaryPath,
          cwd: prepared.input.cwd,
          env: prepared.input.env,
        });
        if (result.status === 'unauthenticated') throw new Error(result.message);
        if (result.status === 'unknown') console.warn(result.message);
      })();
      readiness.set(key, probe);
      probe.catch(() => readiness.delete(key));
    }
    await probe;
    adapter = adapterFor(config.start.provider, config.execution?.binaryPath);
    const admission = streamAdmissionLog(console);
    try {
      await runSharedHost(
        {
          root,
          agentApiUrl: prepared.agentApiUrl,
          token: prepared.token,
          session: config.session,
          resumeOperationId: config.resumeOperationId,
          input: prepared.input,
          roomConnection: config.roomConnection,
          log: admission.log,
          resident: {
            admissionTimeoutMs: ROOM_ADMISSION_TIMEOUT_MS,
            lastRefusal: admission.lastRefusal,
          },
        },
        adapter,
        signal
      );
    } catch (error) {
      if (!(error instanceof SharedHostLeaseExpiredError)) throw error;
      console.warn(
        `Room session ${context.sessionId} lost its Switch lease; execution stopped. The next addressed message in ${context.roomId} starts it again.`
      );
    }
  } catch (error) {
    failure = error;
  }
  // Per-session teardown: this session's provider and MCP children only. The
  // host and every other room session keep running. Ownership is released only
  // once the children are proven gone — a teardown this host could not verify is
  // worse than the failure that led to it, and outranks it.
  try {
    await adapter?.stopAll();
  } catch (error) {
    await recordFailure(root, new ResidentTeardownError(context, error, failure).message);
    throw new ResidentTeardownError(context, error, failure);
  }
  await releaseResidentSession(root);
  await releaseSessionOwnership(root);
  if (failure) throw failure;
}

/** One long-lived host per agent, holding one room session per room. */
export class ResidentSessions implements SessionDispatcher {
  private readonly sessions = new Map<
    string,
    { context: RoomSessionContext; controller: AbortController; done: Promise<void> }
  >();
  private readonly rooms = new Map<string, string>();
  /** One fault per room: the latest reason that room has no session. */
  private readonly faults = new Map<string, RoomSessionFault>();
  /** Rooms whose last session could not be proven stopped. */
  private readonly blocked = new Map<string, RoomSessionFault>();
  private published: Promise<void> = Promise.resolve();
  private stopIncomplete = false;

  /** Rooms whose provider runs in its own process tree, and why. */
  private readonly delegated = new Map<string, { context: RoomSessionContext; reason: string }>();

  constructor(
    private readonly root: string,
    private readonly run: RoomSessionRun,
    private readonly stopTimeoutMs: number,
    private readonly delegate: (roomId: string, config: SharedHostConfig) => Promise<void>
  ) {
    // One resident host per process, so one sink. Groups are written as they are
    // spawned: a host that is killed between spawn and record leaves nothing to
    // sweep by, which is why this is not deferred to teardown.
    onProcessGroupsChanged((sessionId, groups) => {
      this.groupWrites = this.groupWrites
        .then(() => saveProcessGroups(sharedSessionRoot(sessionId), groups))
        .catch((error: unknown) => {
          console.error(
            `Could not record session ${sessionId}'s provider process groups:`,
            String(error)
          );
        });
    });
  }

  private groupWrites: Promise<void> = Promise.resolve();

  live(): RoomSessionContext[] {
    return [...this.sessions.values()].map((entry) => entry.context);
  }

  failures(): RoomSessionFault[] {
    return [...this.faults.values()];
  }

  /** True when a stop left room sessions behind; the worker exits on it. */
  get incomplete(): boolean {
    return this.stopIncomplete;
  }

  /**
   * A room is admissible again only once its previous session is neither still
   * running here nor still holding its state directory. Anything short of that
   * is a session whose execution this host cannot account for.
   */
  private async admissible(roomId: string): Promise<void> {
    const blocked = this.blocked.get(roomId);
    if (!blocked) return;
    const { sessionId } = blocked.context;
    if (this.sessions.has(sessionId) || (await liveSessionOwner(sharedSessionRoot(sessionId))))
      throw new Error(
        `Room ${roomId} cannot start a session yet: ${blocked.message} Stop it or restart the agent's host once those processes are gone.`
      );
    this.blocked.delete(roomId);
  }

  async dispatch(roomId: string, config: SharedHostConfig): Promise<void> {
    const context = roomSessionContext(roomId, config);
    await this.admissible(roomId);
    const held = this.rooms.get(roomId);
    if (held !== undefined && held !== context.sessionId) {
      await this.reconcile(roomId, held);
      // Stopping the old session can be what blocks the room.
      await this.admissible(roomId);
    }
    const stillHeld = this.rooms.get(roomId);
    if (stillHeld !== undefined && stillHeld !== context.sessionId)
      throw new Error(
        `Room ${roomId} is already served by session ${stillHeld}; refusing to admit ${context.sessionId}. One room has one conversation.`
      );
    const refusal = residentRefusal(config.start.provider);
    if (refusal) {
      console.warn(
        `Room ${roomId} runs ${config.start.provider} in its own process tree, not the resident host: ${refusal}.`
      );
      this.delegated.set(roomId, { context, reason: refusal });
      this.rooms.delete(roomId);
      await this.delegate(roomId, config);
      this.publish();
      return;
    }
    this.delegated.delete(roomId);
    if (this.sessions.has(context.sessionId)) return;
    if (this.sessions.size >= ROOM_CONNECTION_BUDGET)
      console.warn(
        `This agent already holds ${this.sessions.size} room sessions. Switch allows 32 connections per agent including the watcher's, so admitting ${roomId} may be refused.`
      );
    const controller = new AbortController();
    const entry = { context, controller, done: Promise.resolve() };
    this.faults.delete(roomId);
    this.rooms.set(roomId, context.sessionId);
    this.sessions.set(context.sessionId, entry);
    entry.done = (async () => {
      try {
        await this.run({
          context,
          root: sharedSessionRoot(context.sessionId),
          config,
          signal: controller.signal,
        });
      } catch (error) {
        // A room session that faults is recorded against its room and dropped.
        // The host and its other rooms keep running.
        await this.fault(context, error);
      } finally {
        this.sessions.delete(context.sessionId);
        if (this.rooms.get(roomId) === context.sessionId) this.rooms.delete(roomId);
        this.publish();
      }
    })();
    this.publish();
  }

  async reject(roomId: string, config: SharedHostConfig, error: unknown): Promise<void> {
    await this.fault(
      {
        roomId,
        sessionId: config.session.sessionId,
        connectionId: config.roomConnection?.connectionId ?? '',
      },
      error
    );
  }

  /**
   * A session that is no longer serving this room releases it.
   *
   * Room sessions are bound to one room, and a session that reports a different
   * room set has already broken that binding and is stopping. Holding the room
   * for it would leave the room unserved, so it is stopped and the room freed.
   */
  private async reconcile(roomId: string, sessionId: string): Promise<void> {
    let saved: string[] | null;
    try {
      saved = await SharedRoomInbox.savedRooms(sharedSessionRoot(sessionId));
    } catch (error) {
      console.error(`Room ${roomId} could not read session ${sessionId}'s rooms:`, String(error));
      return;
    }
    if (saved === null || saved.includes(roomId)) return;
    console.warn(
      `Session ${sessionId} left room ${roomId} for ${saved.join(', ') || 'no room'}; stopping it so the room can be served again.`
    );
    // The room is only free once that session is proven stopped. Handing it to a
    // replacement while the old execution is unaccounted for is the thing this
    // whole path exists to prevent.
    if (!(await this.stop(sessionId))) {
      const fault = {
        context: this.sessions.get(sessionId)?.context ?? { roomId, sessionId, connectionId: '' },
        message: `Session ${sessionId} left room ${roomId} but did not stop within ${this.stopTimeoutMs}ms; its execution is unaccounted for.`,
      };
      this.faults.set(roomId, fault);
      this.blocked.set(roomId, fault);
      this.publish();
      return;
    }
    if (this.rooms.get(roomId) === sessionId) this.rooms.delete(roomId);
  }

  /** Resolves true when the session is proven stopped. */
  async stop(sessionId: string): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return true;
    entry.controller.abort();
    return this.drain([entry]);
  }

  async stopAll(): Promise<void> {
    const entries = [...this.sessions.values()];
    for (const entry of entries) entry.controller.abort();
    await this.drain(entries);
    await this.published;
    await this.groupWrites;
  }

  /**
   * Wait for stopping sessions, but not for ever. A provider child that will not
   * drain would otherwise hold the host open through its own SIGTERM, so the
   * ones that outlive the deadline are named and the host goes on stopping.
   */
  private async drain(
    entries: { context: RoomSessionContext; done: Promise<void> }[]
  ): Promise<boolean> {
    if (entries.length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.stopTimeoutMs);
    });
    try {
      const outcome = await Promise.race([
        Promise.all(entries.map((entry) => entry.done)).then(() => 'drained' as const),
        expired,
      ]);
      if (outcome !== 'timeout') return true;
      const stuck = entries.filter((entry) => this.sessions.has(entry.context.sessionId));
      this.stopIncomplete = true;
      console.error(
        `Room sessions did not stop within ${this.stopTimeoutMs}ms and were left running: ${stuck
          .map((entry) => `${entry.context.roomId} (${entry.context.sessionId})`)
          .join(', ')}.`
      );
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async fault(context: RoomSessionContext, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Room session ${context.sessionId} for room ${context.roomId} failed: ${message}`
    );
    const fault = { context, message };
    this.faults.set(context.roomId, fault);
    if (error instanceof ResidentTeardownError) this.blocked.set(context.roomId, fault);
    try {
      const root = sharedSessionRoot(context.sessionId);
      // Another live process owning this directory means the fault is that we
      // refused to take it over. Its records are not ours to write.
      const owner = await liveSessionOwner(root);
      if (owner && owner.pid !== process.pid) return;
      if (error instanceof ResidentTeardownError) return;
      await recordFailure(root, message);
      await releaseSessionOwnership(root);
    } catch (persistenceError) {
      console.error(
        `Room session ${context.sessionId} could not record its failure:`,
        String(persistenceError)
      );
    }
  }

  /** Console reads this to see what the one host is actually running. */
  private publish(): void {
    const state = {
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      sessions: this.live(),
      failures: [...this.faults.values()].map((fault) => ({
        ...fault.context,
        message: fault.message,
      })),
      delegated: [...this.delegated.values()].map((entry) => ({
        ...entry.context,
        dispatch: 'spawn',
        reason: entry.reason,
      })),
    };
    this.published = this.published
      .then(() => replaceOwner(join(this.root, 'resident.json'), state))
      .catch((error: unknown) => {
        console.error('The resident host could not publish its session list:', String(error));
      });
  }
}

/**
 * Why a provider may not run in the resident host.
 *
 * Returns the reason, or null when it may. A provider whose descendants cannot
 * be fenced is the one case: the resident host stops a session by reaping that
 * session's own children, and it cannot reap what it cannot reach. Run such a
 * provider here and a later host could tell Switch the session quiesced while
 * the old provider is still executing — the failure the ownership scheme exists
 * to prevent. A process tree of its own, fenced by its own supervisor, is what
 * that provider still needs.
 */
export function residentRefusal(provider: SharedHostConfig['start']['provider']): string | null {
  return adapterCapabilities(provider).fenceableDescendants
    ? null
    : 'provider descendants cannot be process-group fenced';
}

/**
 * Every room session of this agent runs inside this process, except those whose
 * provider cannot be fenced: those fall back to a process tree of their own, and
 * the fallback is recorded rather than quietly taken.
 */
export function residentDispatcher(root: string, entrypoint: string): ResidentSessions {
  const readiness = new Map<string, Promise<void>>();
  const spawning = spawningDispatcher(entrypoint);
  return new ResidentSessions(
    root,
    (input) => runResidentRoomSession(input, readiness),
    RESIDENT_STOP_TIMEOUT_MS,
    (roomId, config) => spawning.dispatch(roomId, config)
  );
}

/** A process tree per room session: a supervisor, a worker and a host. */
export function spawningDispatcher(entrypoint: string): SessionDispatcher {
  return {
    incomplete: false,
    async dispatch(roomId, config) {
      const context = roomSessionContext(roomId, config);
      await ensureSharedProcess({
        root: sharedSessionRoot(context.sessionId),
        entrypoint,
        config,
        resuming: false,
        watcher: false,
        restart: false,
      });
    },
    async reject(roomId, config, error) {
      console.error(
        `Room ${roomId} could not start session ${config.session.sessionId}:`,
        String(error)
      );
    },
    async stop() {
      return true;
    },
    live: () => [],
    failures: () => [],
    async stopAll() {},
  };
}

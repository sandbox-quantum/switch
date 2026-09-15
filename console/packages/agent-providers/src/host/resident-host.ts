import { mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventStreamLogger } from '@sandboxaq/switch-agent-runtime';
import { ensureSharedProcess, sharedSessionRoot } from './launch';
import { replaceOwner, withOwnershipLock } from './ownership-lock';
import { checkProviderReadiness } from './provider-readiness';
import { adapterFor } from './server';
import { prepareSharedConfig, type SharedHostConfig } from './shared-config';
import { runSharedHost, SharedHostLeaseExpiredError, type ResidentSupport } from './shared-host';

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

export interface SessionDispatcher {
  dispatch(roomId: string, config: SharedHostConfig): Promise<void>;
  stop(sessionId: string): Promise<void>;
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
  for (const key of ['SWITCH_CONNECTION_ID', 'SWITCHDASH_SESSION_ID'])
    if (process.env[key] !== undefined)
      throw new Error(
        `The resident host carries ${key} in its own environment. Per-session identity must reach a provider through its child environment only.`
      );
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

/**
 * `ensureSharedProcess` adopts a session whose supervisor is alive instead of
 * starting a competitor. A resident host is that owner, so it records itself
 * here and marks the record so a restart request names the host to restart.
 */
async function markResidentOwner(root: string, resident: boolean): Promise<void> {
  const directory = join(root, 'supervisor');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'owner.json');
  if (resident) await replaceOwner(path, { pid: process.pid, resident: true });
  else
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
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
  const prepared = await prepareSharedConfig(root, config);
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
  const adapter = adapterFor(config.start.provider, config.execution?.binaryPath);
  const admission = streamAdmissionLog(console);
  const resident: ResidentSupport = {
    admissionTimeoutMs: ROOM_ADMISSION_TIMEOUT_MS,
    log: admission.log,
    lastRefusal: admission.lastRefusal,
  };
  await markResidentOwner(root, true);
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
        resident,
      },
      adapter,
      signal
    );
  } catch (error) {
    if (!(error instanceof SharedHostLeaseExpiredError)) throw error;
    console.warn(
      `Room session ${context.sessionId} lost its Switch lease; execution stopped. The next addressed message in ${context.roomId} starts it again.`
    );
  } finally {
    // Per-session teardown: this session's provider and MCP children only. The
    // host and every other room session keep running.
    await adapter.stopAll().catch((error: unknown) => {
      console.error(
        `Room session ${context.sessionId} could not stop its provider processes:`,
        String(error)
      );
    });
    await markResidentOwner(root, false);
    await releaseSessionOwnership(root);
  }
}

/** One long-lived host per agent, holding one room session per room. */
export class ResidentSessions implements SessionDispatcher {
  private readonly sessions = new Map<
    string,
    { context: RoomSessionContext; controller: AbortController; done: Promise<void> }
  >();
  private readonly rooms = new Map<string, string>();
  private readonly faults: RoomSessionFault[] = [];
  private published: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly run: RoomSessionRun
  ) {}

  live(): RoomSessionContext[] {
    return [...this.sessions.values()].map((entry) => entry.context);
  }

  failures(): RoomSessionFault[] {
    return [...this.faults];
  }

  async dispatch(roomId: string, config: SharedHostConfig): Promise<void> {
    const context = roomSessionContext(roomId, config);
    const held = this.rooms.get(roomId);
    if (held !== undefined && held !== context.sessionId)
      throw new Error(
        `Room ${roomId} is already served by session ${held}; refusing to admit ${context.sessionId}. One room has one conversation.`
      );
    if (this.sessions.has(context.sessionId)) return;
    if (this.sessions.size >= ROOM_CONNECTION_BUDGET)
      console.warn(
        `This agent already holds ${this.sessions.size} room sessions. Switch allows 32 connections per agent including the watcher's, so admitting ${roomId} may be refused.`
      );
    const controller = new AbortController();
    const entry = { context, controller, done: Promise.resolve() };
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
        // One room session's fault never reaches the host or its siblings.
        await this.fault(context, error);
      } finally {
        this.sessions.delete(context.sessionId);
        if (this.rooms.get(roomId) === context.sessionId) this.rooms.delete(roomId);
        this.publish();
      }
    })();
    this.publish();
  }

  async stop(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.controller.abort();
    await entry.done;
  }

  async stopAll(): Promise<void> {
    for (const entry of this.sessions.values()) entry.controller.abort();
    await Promise.all([...this.sessions.values()].map((entry) => entry.done));
    await this.published;
  }

  private async fault(context: RoomSessionContext, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Room session ${context.sessionId} for room ${context.roomId} failed: ${message}`
    );
    this.faults.push({ context, message });
    try {
      await recordFailure(sharedSessionRoot(context.sessionId), message);
      await releaseSessionOwnership(sharedSessionRoot(context.sessionId));
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
      failures: this.faults.map((fault) => ({ ...fault.context, message: fault.message })),
    };
    this.published = this.published
      .then(() => replaceOwner(join(this.root, 'resident.json'), state))
      .catch((error: unknown) => {
        console.error('The resident host could not publish its session list:', String(error));
      });
  }
}

/** The default: every room session of this agent runs inside this process. */
export function residentDispatcher(root: string): ResidentSessions {
  const readiness = new Map<string, Promise<void>>();
  return new ResidentSessions(root, (input) => runResidentRoomSession(input, readiness));
}

/** The previous behaviour, kept for comparison: a process tree per room session. */
export function spawningDispatcher(entrypoint: string): SessionDispatcher {
  return {
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
    async stop() {},
    live: () => [],
    failures: () => [],
    async stopAll() {},
  };
}

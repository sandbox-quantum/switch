import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { serverEventSchema, type ServerEvent } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import {
  type AttachmentTransfers,
  attachmentChunkSchema,
  ControlError,
} from './attachment-transfers';
import { readJournalSnapshot } from './journal-snapshot';
import { liveSupervisor, sharedSessionRoot } from './launch';
import {
  SessionHostFailedError,
  sessionRequestSchema,
  SessionUnavailableError,
  type SessionLinks,
  type SessionRequest,
} from './session-channel';
import { listSessions } from './session-list';
import {
  type PlaceOutcome,
  type WatcherControl,
  type WatcherHealth,
  watcherHealthSchema,
} from './watcher-tools';

/**
 * How Console reaches the sessions an agent's sidecar runs on a remote host.
 *
 * The sidecar is the parent of those sessions and talks to each over its IPC
 * pipe (`SessionLinks`). This is the one hop in front of that: the sidecar
 * listens on a loopback port, writes the port and a secret to `control.json`
 * in its state root (readable by the user only), and Console reaches the port
 * through the SSH connection it already holds. Messages are JSON lines.
 */

export const CONTROL_FILE = 'control.json';

/**
 * One message Console sends a sidecar or a watcher, whether over the loopback
 * socket or relayed through Switch: the one vocabulary both paths answer.
 */
export const controlMessageSchema = z.union([
  z.object({ sessionId: z.string().min(1), request: sessionRequestSchema }),
  z.object({ subscribe: z.string().min(1) }),
  z.object({ unsubscribe: z.string().min(1) }),
  z.object({
    ensure: z.object({ config: z.unknown(), resuming: z.boolean(), restart: z.boolean() }),
  }),
  /** Console's "Reconnect to room": move a room's messages to this session. */
  z.object({ place: z.object({ sessionId: z.string().min(1), roomId: z.string().min(1) }) }),
  z.object({ forget: z.string().min(1) }),
  /** The room watcher's connection state and placements, as it holds them now. */
  z.object({ health: z.literal(true) }),
  /** Start or stop pushing `{health}` to this connection whenever the watcher's changes. */
  z.object({ watchHealth: z.boolean() }),
  /** The agent's sessions on this host, as their hosts recorded them. */
  z.object({ list: z.literal(true) }),
  /** A session read from its journal, whether or not its host is running. */
  z.object({ journal: z.string().min(1) }),
  /** One page of a paged answer; only the relay pages its answers. */
  z.object({
    page: z.object({ snapshotId: z.string().min(1), index: z.number().int().nonnegative() }),
  }),
  z.object({ attachment: attachmentChunkSchema }),
  z.object({ attachmentCancel: z.string().min(1) }),
]);
export type ControlMessage = z.infer<typeof controlMessageSchema>;

const clientMessageSchema = z.union([
  z.object({ token: z.string().min(1) }),
  z.intersection(z.object({ id: z.number().int() }), controlMessageSchema),
]);

/** What `serverMessageSchema` pushes on a connection besides its answers. */
export type ControlPush =
  | { sessionId: string; event: ServerEvent }
  | { sessionId: string; failure: string | null }
  | { health: WatcherHealth };

/** One connection's live views: its session subscriptions and health watch. */
export class ControlPeer {
  readonly subscriptions = new Map<string, () => void>();
  unwatchHealth: (() => void) | null = null;

  constructor(readonly send: (push: ControlPush) => void) {}

  close(): void {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.unwatchHealth?.();
    this.unwatchHealth = null;
  }
}

export type ControlContext = {
  agentId: string;
  links: SessionLinks;
  ensure: EnsureSession;
  watcher: WatcherControl;
  transfers: AttachmentTransfers;
};

const sentAttachmentsSchema = z.object({
  body: z.object({
    type: z.literal('message.send'),
    attachments: z.array(z.object({ attachmentId: z.string() })),
  }),
});

/** Answer one control message; a refusal throws. `page` is the relay's. */
export async function handleControlMessage(
  context: ControlContext,
  peer: ControlPeer,
  message: ControlMessage
): Promise<unknown> {
  const { links, watcher } = context;
  if ('request' in message) {
    const sessionRoot = sharedSessionRoot(message.sessionId);
    if (message.request.type === 'command') {
      const sent = sentAttachmentsSchema.safeParse(message.request.command);
      if (sent.success)
        context.transfers.consume(sent.data.body.attachments.map((a) => a.attachmentId));
    }
    // Waits for a host that is starting, not for one nothing is running.
    const running = await liveSupervisor(sessionRoot);
    return links.request(sessionRoot, message.request, running ? REQUEST_WAIT_MS : 0);
  }
  if ('subscribe' in message) {
    const sessionId = message.subscribe;
    const sessionRoot = sharedSessionRoot(sessionId);
    if (!peer.subscriptions.has(sessionId)) {
      const offEvents = links.subscribe(sessionRoot, (event) => peer.send({ sessionId, event }));
      const offFailure = links.onFailure((failed, failure) => {
        if (failed === sessionRoot) peer.send({ sessionId, failure });
      });
      // A host that comes up again has put its failure behind it.
      const offReady = links.onReady((ready) => {
        if (ready === sessionRoot) peer.send({ sessionId, failure: null });
      });
      peer.subscriptions.set(sessionId, () => {
        offEvents();
        offFailure();
        offReady();
      });
    }
    // Answered with the failure already recorded, so a subscriber that
    // arrives after the host stopped still hears why.
    return { failure: links.failure(sessionRoot) };
  }
  if ('unsubscribe' in message) {
    peer.subscriptions.get(message.unsubscribe)?.();
    peer.subscriptions.delete(message.unsubscribe);
    return null;
  }
  if ('place' in message) return watcher.place(message.place.sessionId, message.place.roomId);
  if ('forget' in message) return watcher.forget(message.forget);
  if ('health' in message) return watcher.health();
  if ('watchHealth' in message) {
    if (message.watchHealth)
      peer.unwatchHealth ??= watcher.onHealth((health) => peer.send({ health }));
    else {
      peer.unwatchHealth?.();
      peer.unwatchHealth = null;
    }
    return null;
  }
  if ('list' in message) return listSessions(context.agentId);
  if ('journal' in message) return readJournalSnapshot(message.journal);
  if ('page' in message)
    throw new ControlError('refused_message', 'Pages are served only to relayed answers.');
  if ('attachment' in message) return context.transfers.receive(message.attachment);
  if ('attachmentCancel' in message) return context.transfers.cancel(message.attachmentCancel);
  return context.ensure(message.ensure);
}

export type EnsureSession = (input: {
  config: unknown;
  resuming: boolean;
  restart: boolean;
}) => Promise<unknown>;

/** How long a request waits for the session's host to be ready. */
const REQUEST_WAIT_MS = 30000;

function lines(socket: Socket | Duplex, onLine: (line: string) => void): void {
  let buffered = '';
  socket.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let at = buffered.indexOf('\n');
    while (at !== -1) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (line) onLine(line);
      at = buffered.indexOf('\n');
    }
  });
}

/** Serve Console's requests for the sessions under `context.links` until `signal` aborts. */
export async function serveControl(
  root: string,
  context: ControlContext,
  signal: AbortSignal
): Promise<void> {
  const token = randomBytes(32).toString('hex');
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let authenticated = false;
    const send = (message: unknown) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    };
    const peer = new ControlPeer(send);
    socket.on('close', () => peer.close());
    socket.on('error', () => socket.destroy());
    lines(socket, (line) => {
      let parsed: z.infer<typeof clientMessageSchema>;
      try {
        parsed = clientMessageSchema.parse(JSON.parse(line));
      } catch {
        socket.destroy();
        return;
      }
      if (!authenticated) {
        if (!('token' in parsed) || parsed.token !== token) {
          socket.destroy();
          return;
        }
        authenticated = true;
        send({ authenticated: true });
        return;
      }
      if ('token' in parsed) return;
      const { id, ...message } = parsed;
      void handleControlMessage(context, peer, message as ControlMessage).then(
        (value) => send({ id, ok: true, value: value ?? null }),
        (error: unknown) =>
          send({
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            unavailable: error instanceof SessionUnavailableError,
            ...(error instanceof SessionHostFailedError ? { failure: error.failure } : {}),
          })
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The control server has no port.');
  const path = join(root, CONTROL_FILE);
  const temporary = `${path}.${token.slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify({ port: address.port, token }), { mode: 0o600 });
  await rename(temporary, path);
  try {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  } finally {
    await rm(path, { force: true });
    // Closing waits for every connection to end, and Console keeps its open.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
  }
}

const serverMessageSchema = z.union([
  z.object({ authenticated: z.literal(true) }),
  z.object({
    id: z.number().int(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().optional(),
    unavailable: z.boolean().optional(),
    failure: z.string().optional(),
  }),
  z.object({ sessionId: z.string(), event: serverEventSchema }),
  z.object({ sessionId: z.string(), failure: z.string().nullable() }),
  z.object({ health: watcherHealthSchema }),
]);

const placeOutcomeSchema = z.object({
  sessionId: z.string(),
  roomId: z.string(),
  previous: z.string().nullable(),
  displaced: z.string().nullable(),
});

/** Raised when the control connection closed before the sidecar answered. */
export class SidecarConnectionClosedError extends Error {
  constructor() {
    super('The connection to the agent sidecar closed.');
    this.name = 'SidecarConnectionClosedError';
  }
}

/** Console's end of the control connection, over whatever stream reaches the port. */
export class ControlClient {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Map<string, Set<(event: ServerEvent) => void>>();
  private readonly failureListeners = new Map<string, Set<(failure: string | null) => void>>();
  private readonly healthListeners = new Set<(health: WatcherHealth) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private closed: Error | null = null;
  readonly ready: Promise<void>;

  constructor(
    private readonly stream: Duplex,
    token: string
  ) {
    let authenticate!: () => void;
    let refuse!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      authenticate = resolve;
      refuse = reject;
    });
    const fail = (error: Error) => {
      const first = this.closed === null;
      this.closed ??= error;
      refuse(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      if (!first) return;
      for (const listener of this.closeListeners) listener(this.closed);
      this.closeListeners.clear();
    };
    stream.on('error', (error: Error) => fail(error));
    stream.on('close', () => fail(new SidecarConnectionClosedError()));
    lines(stream, (line) => {
      const message = serverMessageSchema.safeParse(JSON.parse(line));
      if (!message.success) return;
      const data = message.data;
      if ('authenticated' in data) authenticate();
      else if ('event' in data)
        for (const listener of this.listeners.get(data.sessionId) ?? []) listener(data.event);
      else if ('sessionId' in data)
        for (const listener of this.failureListeners.get(data.sessionId) ?? [])
          listener(data.failure);
      else if ('health' in data) for (const listener of this.healthListeners) listener(data.health);
      else {
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id);
        const message = data.error ?? 'The sidecar refused the request.';
        if (data.ok) pending.resolve(data.value);
        else if (data.failure !== undefined)
          pending.reject(new SessionHostFailedError(data.failure));
        else if (data.unavailable) pending.reject(new SessionUnavailableError(message));
        else pending.reject(new Error(message));
      }
    });
    stream.write(`${JSON.stringify({ token })}\n`);
  }

  get isClosed(): boolean {
    return this.closed !== null;
  }

  private call(message: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.stream.write(`${JSON.stringify({ id, ...message })}\n`);
    });
  }

  request(sessionId: string, request: SessionRequest): Promise<unknown> {
    return this.call({ sessionId, request });
  }

  ensure(input: { config: unknown; resuming: boolean; restart: boolean }): Promise<unknown> {
    return this.call({ ensure: input });
  }

  /** Move a room's messages to this session, through the sidecar's room watcher. */
  async place(sessionId: string, roomId: string): Promise<PlaceOutcome> {
    return placeOutcomeSchema.parse(await this.call({ place: { sessionId, roomId } }));
  }

  /** Tell the sidecar's room watcher a session was deleted. */
  async forget(sessionId: string): Promise<void> {
    await this.call({ forget: sessionId });
  }

  /** The sidecar's room watcher: its connection state and placements. */
  async health(): Promise<WatcherHealth> {
    return watcherHealthSchema.parse(await this.call({ health: true }));
  }

  /**
   * Called with the watcher's state whenever it changes, once the sidecar has
   * agreed to push it. Pair with `health()` for the state before the first change.
   */
  async onHealth(listener: (health: WatcherHealth) => void): Promise<() => void> {
    const first = this.healthListeners.size === 0;
    this.healthListeners.add(listener);
    if (first) {
      try {
        await this.call({ watchHealth: true });
      } catch (error) {
        this.healthListeners.delete(listener);
        throw error;
      }
    }
    return () => {
      if (!this.healthListeners.delete(listener) || this.healthListeners.size) return;
      if (!this.closed) void this.call({ watchHealth: false }).catch(() => {});
    };
  }

  /** Called once when the connection to the sidecar closes or fails; at once if it already has. */
  onClose(listener: (error: Error) => void): () => void {
    if (this.closed) {
      listener(this.closed);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /**
   * Hear every event the session's host records, and `onFailure` with why it
   * stopped each time it stops on a failure, and with null when a host comes
   * up again. The first subscriber also hears the failure standing when it
   * subscribed, null if there is none.
   */
  async subscribe(
    sessionId: string,
    listener: (event: ServerEvent) => void,
    onFailure: (failure: string | null) => void
  ): Promise<() => void> {
    let set = this.listeners.get(sessionId);
    let failures = this.failureListeners.get(sessionId);
    if (!failures) {
      failures = new Set();
      this.failureListeners.set(sessionId, failures);
    }
    failures.add(onFailure);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
      const answer = z
        .object({ failure: z.string().nullable() })
        .nullable()
        .parse(await this.call({ subscribe: sessionId }));
      onFailure(answer?.failure ?? null);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      failures.delete(onFailure);
      if (!failures.size) this.failureListeners.delete(sessionId);
      if (set.size) return;
      this.listeners.delete(sessionId);
      if (!this.closed) void this.call({ unsubscribe: sessionId }).catch(() => {});
    };
  }

  close(): void {
    this.stream.destroy();
  }
}

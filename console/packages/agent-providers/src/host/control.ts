import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { serverEventSchema, type ServerEvent } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { liveSupervisor, sharedSessionRoot } from './launch';
import {
  SessionHostFailedError,
  sessionRequestSchema,
  SessionUnavailableError,
  type SessionLinks,
  type SessionRequest,
} from './session-channel';
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

const clientMessageSchema = z.union([
  z.object({ token: z.string().min(1) }),
  z.object({ id: z.number().int(), sessionId: z.string().min(1), request: sessionRequestSchema }),
  z.object({ id: z.number().int(), subscribe: z.string().min(1) }),
  z.object({ id: z.number().int(), unsubscribe: z.string().min(1) }),
  z.object({
    id: z.number().int(),
    ensure: z.object({ config: z.unknown(), resuming: z.boolean(), restart: z.boolean() }),
  }),
  /** Console's "Reconnect to room": move a room's messages to this session. */
  z.object({
    id: z.number().int(),
    place: z.object({ sessionId: z.string().min(1), roomId: z.string().min(1) }),
  }),
  z.object({
    id: z.number().int(),
    forget: z.string().min(1),
  }),
  /** The room watcher's connection state and placements, as it holds them now. */
  z.object({ id: z.number().int(), health: z.literal(true) }),
  /** Start or stop pushing `{health}` to this connection whenever the watcher's changes. */
  z.object({ id: z.number().int(), watchHealth: z.boolean() }),
]);

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

/** Serve Console's requests for the sessions under `links` until `signal` aborts. */
export async function serveControl(
  root: string,
  links: SessionLinks,
  ensure: EnsureSession,
  watcher: WatcherControl,
  signal: AbortSignal
): Promise<void> {
  const token = randomBytes(32).toString('hex');
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let authenticated = false;
    const subscriptions = new Map<string, () => void>();
    let unwatchHealth: (() => void) | null = null;
    const send = (message: unknown) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    };
    socket.on('close', () => {
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      unwatchHealth?.();
      unwatchHealth = null;
    });
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
      const reply = (work: Promise<unknown>) =>
        work.then(
          (value) => send({ id: parsed.id, ok: true, value: value ?? null }),
          (error: unknown) =>
            send({
              id: parsed.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              unavailable: error instanceof SessionUnavailableError,
              ...(error instanceof SessionHostFailedError ? { failure: error.failure } : {}),
            })
        );
      if ('request' in parsed) {
        const sessionRoot = sharedSessionRoot(parsed.sessionId);
        // Waits for a host that is starting, not for one nothing is running.
        void reply(
          liveSupervisor(sessionRoot).then((running) =>
            links.request(sessionRoot, parsed.request, running ? REQUEST_WAIT_MS : 0)
          )
        );
      } else if ('subscribe' in parsed) {
        const sessionId = parsed.subscribe;
        const sessionRoot = sharedSessionRoot(sessionId);
        if (!subscriptions.has(sessionId)) {
          const offEvents = links.subscribe(sessionRoot, (event) => send({ sessionId, event }));
          const offFailure = links.onFailure((failed, failure) => {
            if (failed === sessionRoot) send({ sessionId, failure });
          });
          // A host that comes up again has put its failure behind it.
          const offReady = links.onReady((ready) => {
            if (ready === sessionRoot) send({ sessionId, failure: null });
          });
          subscriptions.set(sessionId, () => {
            offEvents();
            offFailure();
            offReady();
          });
        }
        // Answered with the failure already recorded, so a subscriber that
        // arrives after the host stopped still hears why.
        void reply(Promise.resolve({ failure: links.failure(sessionRoot) }));
      } else if ('unsubscribe' in parsed) {
        subscriptions.get(parsed.unsubscribe)?.();
        subscriptions.delete(parsed.unsubscribe);
        void reply(Promise.resolve(null));
      } else if ('place' in parsed)
        void reply(watcher.place(parsed.place.sessionId, parsed.place.roomId));
      else if ('forget' in parsed) void reply(watcher.forget(parsed.forget));
      else if ('health' in parsed) void reply(Promise.resolve(watcher.health()));
      else if ('watchHealth' in parsed) {
        if (parsed.watchHealth) unwatchHealth ??= watcher.onHealth((health) => send({ health }));
        else {
          unwatchHealth?.();
          unwatchHealth = null;
        }
        void reply(Promise.resolve(null));
      } else void reply(ensure(parsed.ensure));
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

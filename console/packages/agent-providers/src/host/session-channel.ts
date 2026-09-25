import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serverEventSchema, type ServerEvent } from '@switch-console/shared/session-v1';
import { z } from 'zod';

/**
 * The pipe between a session host and the process that started it.
 *
 * A session host runs as a child of Console (a local session) or of the
 * agent's sidecar (a remote one), and they talk over the IPC channel Node
 * opens when the child is spawned: plain JSON messages, in order, private to
 * the two of them, closed when either exits. Nothing goes through a file or
 * through Switch.
 *
 * The parent asks (`request`) and the host answers (`reply`); the host also
 * pushes every event it records (`event`) and says when it is ready to take
 * requests (`ready`). The other way round, the host says which session it is
 * (`identity`, again whenever its generation moves) and asks its parent
 * (`ask`) for what only the holder of the agent's connection can do: list the
 * Switch tools and run one. The parent answers (`answer`).
 */

export const sessionRequestSchema = z.discriminatedUnion('type', [
  /** A contract `Command`; validated by the host. */
  z.object({
    type: z.literal('command'),
    command: z.unknown(),
    /** Who asked, as the room names them; null for a command from Console. */
    requesterName: z.string().nullable(),
  }),
  /** A room message the agent was addressed with, as the controller routed it. */
  z.object({
    type: z.literal('room'),
    handoff: z.object({
      sequence: z.number().int().positive(),
      roomId: z.string().min(1),
      messageId: z.string().min(1),
      event: z.unknown(),
    }),
  }),
  /** The session as the host holds it now. */
  z.object({ type: z.literal('snapshot') }),
  /** Switch has an answer to one of this session's approval requests. */
  z.object({ type: z.literal('approvals') }),
]);
export type SessionRequest = z.infer<typeof sessionRequestSchema>;

/** What a host asks its parent, which holds the agent's connection to Switch. */
export const hostAskSchema = z.discriminatedUnion('type', [
  /** The Switch tools, as MCP lists them. */
  z.object({ type: z.literal('tools') }),
  /** One tool call, answered with the MCP tool result. */
  z.object({
    type: z.literal('tool'),
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  }),
]);
export type HostAsk = z.infer<typeof hostAskSchema>;

/** Which session a host runs: what its tool calls are made as. */
export const hostIdentitySchema = z.strictObject({
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  hostId: z.string().min(1),
  epoch: z.string().min(1),
});
export type HostIdentity = z.infer<typeof hostIdentitySchema>;

/** A host asking, as its parent knows it. */
export type Caller = HostIdentity & { root: string };

/** Answers what the hosts of one agent's sessions ask. */
export type AskHandler = (caller: Caller, ask: HostAsk) => Promise<unknown>;

const answerSchema = z.object({
  kind: z.literal('answer'),
  id: z.number().int().nonnegative(),
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.string().optional(),
});

/** Why a session is busy: one kind per condition, with how many of it. */
export const busyReasonSchema = z.object({
  kind: z.enum(['turn_running', 'turn_starting', 'room_pending', 'approval_open', 'reset_waiting']),
  count: z.number().int().positive(),
});
export type BusyReason = z.infer<typeof busyReasonSchema>;
export type BusyState = { busy: boolean; reasons: BusyReason[] };

const toChildSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('request'),
    id: z.number().int().nonnegative(),
    request: sessionRequestSchema,
  }),
  answerSchema,
  /** Answer `busy` once every command queued before this has been taken or refused. */
  z.object({ kind: z.literal('busyBarrier'), id: z.number().int().nonnegative() }),
]);

const fromChildSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('event'), event: serverEventSchema }),
  z.object({
    kind: z.literal('reply'),
    id: z.number().int().nonnegative(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({ kind: z.literal('identity'), identity: hostIdentitySchema }),
  z.object({ kind: z.literal('ask'), id: z.number().int().nonnegative(), ask: hostAskSchema }),
  z.object({
    kind: z.literal('busy'),
    busy: z.boolean(),
    reasons: z.array(busyReasonSchema),
    barrier: z.number().int().nonnegative().optional(),
  }),
]);

/** Raised when a session host is not running, or stopped before it answered. */
export class SessionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionUnavailableError';
  }
}

/**
 * Raised when a session host stopped on a failure it recorded, and nothing has
 * started it again since. Starting it again without changing anything would
 * fail the same way, so the caller decides whether to.
 */
export class SessionHostFailedError extends Error {
  constructor(readonly failure: string) {
    super(`The session host failed: ${failure}`);
    this.name = 'SessionHostFailedError';
  }
}

/**
 * Why the host at this root stopped, from the `supervisor/failure.json` it
 * writes before exiting on an error; a plain account of the exit when it
 * wrote none.
 */
function recordedFailure(root: string, code: number): string {
  try {
    const recorded = z
      .object({ message: z.string().min(1) })
      .safeParse(JSON.parse(readFileSync(join(root, 'supervisor', 'failure.json'), 'utf8')));
    if (recorded.success) return recorded.data.message;
    console.warn(`The failure the session host at ${root} recorded is unreadable.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn(`Could not read why the session host at ${root} failed: ${String(error)}`);
  }
  return `The session host exited with code ${code}.`;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Link = {
  child: ChildProcess | null;
  ready: boolean;
  identity: HostIdentity | null;
  /** Why the last host here stopped on an error, until another is started. */
  failure: string | null;
  nextId: number;
  pending: Map<number, Pending>;
  waiting: (() => void)[];
  subscribers: Set<(event: ServerEvent) => void>;
  /** What the running host last said about being busy; null before it has. */
  busy: BusyState | null;
  barriers: Map<number, Pending>;
};

/**
 * The parent's end: one link per session state root, re-attached each time
 * the supervisor starts the host again.
 */
export class SessionLinks {
  private readonly links = new Map<string, Link>();
  private readonly answerers = new Map<string, AskHandler>();
  private readonly exitListeners = new Set<(root: string, identity: HostIdentity | null) => void>();
  private readonly readyListeners = new Set<(root: string) => void>();
  private readonly failureListeners = new Set<(root: string, failure: string) => void>();
  private readonly busyListeners = new Set<(root: string) => void>();

  private link(root: string): Link {
    let link = this.links.get(root);
    if (!link) {
      link = {
        child: null,
        ready: false,
        identity: null,
        failure: null,
        nextId: 0,
        pending: new Map(),
        waiting: [],
        subscribers: new Set(),
        busy: null,
        barriers: new Map(),
      };
      this.links.set(root, link);
    }
    return link;
  }

  /** Called by the supervisor with each host it spawns. */
  attach(root: string, child: ChildProcess): void {
    const link = this.link(root);
    link.child = child;
    link.ready = false;
    link.identity = null;
    link.failure = null;
    link.busy = null;
    child.on('message', (raw) => {
      const parsed = fromChildSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn(`Ignoring an unreadable message from the session host at ${root}.`);
        return;
      }
      const message = parsed.data;
      if (message.kind === 'ready') {
        link.ready = true;
        for (const wake of link.waiting.splice(0)) wake();
        for (const listener of this.readyListeners) listener(root);
      } else if (message.kind === 'event') {
        for (const subscriber of link.subscribers) subscriber(message.event);
      } else if (message.kind === 'identity') {
        link.identity = message.identity;
      } else if (message.kind === 'busy') {
        link.busy = { busy: message.busy, reasons: message.reasons };
        for (const listener of this.busyListeners) listener(root);
        if (message.barrier !== undefined) {
          const pending = link.barriers.get(message.barrier);
          link.barriers.delete(message.barrier);
          if (pending) {
            clearTimeout(pending.timer);
            pending.resolve(link.busy);
          }
        }
      } else if (message.kind === 'ask') {
        const answer = (outcome: { ok: true; value: unknown } | { ok: false; error: string }) => {
          if (child.connected)
            child.send({ kind: 'answer', id: message.id, ...outcome }, (error) => {
              if (error) console.warn(`Could not answer the session host at ${root}: ${error}`);
            });
        };
        this.answerAsk(root, link.identity, message.ask).then(
          (value) => answer({ ok: true, value: value ?? null }),
          (error: unknown) =>
            answer({ ok: false, error: error instanceof Error ? error.message : String(error) })
        );
      } else {
        const pending = link.pending.get(message.id);
        if (!pending) return;
        link.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new Error(message.error ?? 'The session host refused the request.'));
      }
    });
    child.once('exit', (code) => {
      if (link.child !== child) return;
      const identity = link.identity;
      link.child = null;
      link.ready = false;
      link.identity = null;
      link.busy = null;
      // A non-zero exit is one the supervisor does not recover from: the host
      // has already written why.
      if (code !== null && code !== 0) link.failure = recordedFailure(root, code);
      const failure = link.failure;
      for (const [id, pending] of link.pending) {
        clearTimeout(pending.timer);
        pending.reject(
          failure !== null
            ? new SessionHostFailedError(failure)
            : new SessionUnavailableError('The session host stopped before it answered.')
        );
        link.pending.delete(id);
      }
      for (const [id, pending] of link.barriers) {
        clearTimeout(pending.timer);
        pending.reject(new SessionUnavailableError('The session host stopped before it answered.'));
        link.barriers.delete(id);
      }
      // A request waiting for this host to come up learns now that it will not.
      for (const wake of link.waiting.splice(0)) wake();
      for (const listener of this.busyListeners) listener(root);
      for (const listener of this.exitListeners) listener(root, identity);
      if (failure !== null) for (const listener of this.failureListeners) listener(root, failure);
    });
  }

  private async answerAsk(
    root: string,
    identity: HostIdentity | null,
    ask: HostAsk
  ): Promise<unknown> {
    if (!identity)
      throw new Error('The session host asked its parent before saying which session it runs.');
    const handler = this.answerers.get(identity.agentId);
    if (!handler)
      throw new Error(
        `No room watcher is running for agent ${identity.agentId} here, so this session's Switch tools cannot reach Switch. Turn the agent's room connection on in Console.`
      );
    return handler({ ...identity, root }, ask);
  }

  /**
   * Answer what the hosts of this agent's sessions ask, until the returned
   * function is called. One answerer per agent: it is the process holding the
   * agent's connection.
   */
  answer(agentId: string, handler: AskHandler): () => void {
    if (this.answerers.has(agentId))
      throw new Error(`Agent ${agentId} already has a watcher answering its sessions here.`);
    this.answerers.set(agentId, handler);
    return () => {
      if (this.answerers.get(agentId) === handler) this.answerers.delete(agentId);
    };
  }

  /** Which session the host at this root last said it runs, or null. */
  identity(root: string): HostIdentity | null {
    return this.links.get(root)?.identity ?? null;
  }

  /** Hear each host exit, with the session it last said it ran. */
  onExit(listener: (root: string, identity: HostIdentity | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Hear each host say it is ready for requests. */
  onReady(listener: (root: string) => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  /** Hear each host stop on a failure, with the failure it recorded. */
  onFailure(listener: (root: string, failure: string) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  /** Why the last host at this root stopped on an error, or null if it did not. */
  failure(root: string): string | null {
    return this.links.get(root)?.failure ?? null;
  }

  /** Forgets a recorded failure: something is about to start the host again. */
  clearFailure(root: string): void {
    const link = this.links.get(root);
    if (link) link.failure = null;
  }

  /** Whether a host is running at this root and ready for requests. */
  ready(root: string): boolean {
    return this.links.get(root)?.ready === true;
  }

  /**
   * Ask the host, waiting up to `timeoutMs` for one to be ready if it is
   * still starting. Refused with `SessionUnavailableError` when none comes,
   * and with `SessionHostFailedError` as soon as the host stops on a failure.
   */
  async request(root: string, request: SessionRequest, timeoutMs: number): Promise<unknown> {
    const link = this.link(root);
    const deadline = Date.now() + timeoutMs;
    while (!link.ready || !link.child) {
      if (link.failure !== null) throw new SessionHostFailedError(link.failure);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SessionUnavailableError('The session host is not running.');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, remaining);
        function done() {
          clearTimeout(timer);
          const at = link.waiting.indexOf(done);
          if (at !== -1) link.waiting.splice(at, 1);
          resolve();
        }
        link.waiting.push(done);
      });
    }
    const child = link.child;
    const id = link.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          link.pending.delete(id);
          reject(new SessionUnavailableError('The session host did not answer in time.'));
        },
        Math.max(deadline - Date.now(), 5000)
      );
      link.pending.set(id, { resolve, reject, timer });
      child.send({ kind: 'request', id, request }, (error) => {
        if (!error) return;
        link.pending.delete(id);
        clearTimeout(timer);
        reject(new SessionUnavailableError(`The session host could not be reached: ${error}`));
      });
    });
  }

  /** Hear each change in what a host says about being busy, and each host exit. */
  onBusy(listener: (root: string) => void): () => void {
    this.busyListeners.add(listener);
    return () => this.busyListeners.delete(listener);
  }

  /** What the running host at this root last said about being busy; null if none is running or it has not said. */
  busy(root: string): BusyState | null {
    return this.links.get(root)?.busy ?? null;
  }

  /**
   * Ask the running host for its busy state once every command sent to it
   * before now has been taken or refused. Refused with
   * `SessionUnavailableError` when no host is running, it exits first, or it
   * does not answer within `timeoutMs`.
   */
  barrier(root: string, timeoutMs: number): Promise<BusyState> {
    const link = this.link(root);
    const child = link.child;
    if (!child || !link.ready)
      return Promise.reject(new SessionUnavailableError('The session host is not running.'));
    const id = link.nextId++;
    return new Promise<BusyState>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.barriers.delete(id);
        reject(new SessionUnavailableError('The session host did not answer its busy barrier.'));
      }, timeoutMs);
      link.barriers.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      child.send({ kind: 'busyBarrier', id }, (error) => {
        if (!error) return;
        link.barriers.delete(id);
        clearTimeout(timer);
        reject(new SessionUnavailableError(`The session host could not be reached: ${error}`));
      });
    });
  }

  /** Hear every event the host at this root records from now on. */
  subscribe(root: string, listener: (event: ServerEvent) => void): () => void {
    const link = this.link(root);
    link.subscribers.add(listener);
    return () => link.subscribers.delete(listener);
  }
}

export type SessionRequestHandlers = {
  [K in SessionRequest['type']]: (
    request: Extract<SessionRequest, { type: K }>
  ) => Promise<unknown>;
};

/** What the host needs of its own process to talk to its parent: `process` itself. */
export type ParentPort = {
  send?: (message: unknown) => boolean;
  connected: boolean;
  on(event: 'message' | 'disconnect', listener: (message: unknown) => void): unknown;
  off(event: 'message' | 'disconnect', listener: (message: unknown) => void): unknown;
};

/** The host's end of the pipe. */
export type ParentChannel = {
  /** Answer the parent's requests with these, from now on. */
  serve: (handlers: SessionRequestHandlers) => void;
  /** Tell the parent requests can be sent. */
  ready: () => void;
  push: (event: ServerEvent) => void;
  /** Say which session this host runs; again whenever that changes. */
  identify: (identity: HostIdentity) => void;
  /** Ask the parent, rejecting if it does not answer or goes away. */
  ask: (ask: HostAsk) => Promise<unknown>;
  /** Say whether the session is busy, and why; `barrier` answers a `busyBarrier`. */
  busy: (state: BusyState, barrier: number | null) => void;
  /** Answer each `busyBarrier` with this, once it resolves. */
  onBarrier: (handler: () => Promise<BusyState>) => void;
  /** Stop answering requests, so the parent reads the host as going. */
  close: () => void;
};

/** How long a host waits for its parent to answer; a tool call may upload files. */
const ASK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The host's end, over the IPC channel it was started with. Refuses a port
 * with none: a session host is always some process's child.
 */
export function connectParent(port: ParentPort): ParentChannel {
  if (!port.send)
    throw new Error(
      'A session host is started by its parent (Console or the agent sidecar) with an IPC channel, and this one has none.'
    );
  const send = (message: unknown) => {
    if (port.connected) port.send!(message);
  };
  let handlers: SessionRequestHandlers | null = null;
  let barrier: (() => Promise<BusyState>) | null = null;
  let serving = true;
  let nextAsk = 0;
  const asks = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const onMessage = (raw: unknown) => {
    const parsed = toChildSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn('Ignoring an unreadable message from the parent process.');
      return;
    }
    const message = parsed.data;
    if (message.kind === 'answer') {
      const pending = asks.get(message.id);
      if (!pending) return;
      asks.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.error ?? 'The parent refused.'));
      return;
    }
    if (message.kind === 'busyBarrier') {
      if (!barrier) return;
      barrier().then(
        (state) => send({ kind: 'busy', ...state, barrier: message.id }),
        (error: unknown) => console.warn(`Could not answer a busy barrier: ${String(error)}`)
      );
      return;
    }
    if (!serving) return;
    const { id, request } = message;
    if (!handlers) {
      send({ kind: 'reply', id, ok: false, error: 'The session host is not ready yet.' });
      return;
    }
    const handler = handlers[request.type] as (request: SessionRequest) => Promise<unknown>;
    handler(request).then(
      (value) => send({ kind: 'reply', id, ok: true, value }),
      (error: unknown) =>
        send({
          kind: 'reply',
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
    );
  };
  const onDisconnect = () => {
    for (const [id, pending] of asks) {
      clearTimeout(pending.timer);
      pending.reject(new Error('The parent process went away before it answered.'));
      asks.delete(id);
    }
  };
  port.on('message', onMessage);
  port.on('disconnect', onDisconnect);
  return {
    serve: (next) => {
      handlers = next;
    },
    ready: () => send({ kind: 'ready' }),
    push: (event) => send({ kind: 'event', event }),
    identify: (identity) => send({ kind: 'identity', identity }),
    busy: (state, id) => send({ kind: 'busy', ...state, ...(id === null ? {} : { barrier: id }) }),
    onBarrier: (handler) => {
      barrier = handler;
    },
    ask: (ask) => {
      if (!port.connected)
        return Promise.reject(new Error('The parent process is gone, so nothing can answer.'));
      const id = nextAsk++;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          asks.delete(id);
          reject(new Error('The parent process did not answer in time.'));
        }, ASK_TIMEOUT_MS);
        asks.set(id, { resolve, reject, timer });
        send({ kind: 'ask', id, ask });
      });
    },
    close: () => {
      serving = false;
    },
  };
}

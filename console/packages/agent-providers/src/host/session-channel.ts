import type { ChildProcess } from 'node:child_process';
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
 * requests (`ready`).
 */

export const sessionRequestSchema = z.discriminatedUnion('type', [
  /** A contract `Command`; validated by the host. */
  z.object({ type: z.literal('command'), command: z.unknown() }),
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

const toChildSchema = z.object({
  kind: z.literal('request'),
  id: z.number().int().nonnegative(),
  request: sessionRequestSchema,
});

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
]);

/** Raised when a session host is not running, or stopped before it answered. */
export class SessionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionUnavailableError';
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Link = {
  child: ChildProcess | null;
  ready: boolean;
  nextId: number;
  pending: Map<number, Pending>;
  waiting: (() => void)[];
  subscribers: Set<(event: ServerEvent) => void>;
};

/**
 * The parent's end: one link per session state root, re-attached each time
 * the supervisor starts the host again.
 */
export class SessionLinks {
  private readonly links = new Map<string, Link>();

  private link(root: string): Link {
    let link = this.links.get(root);
    if (!link) {
      link = {
        child: null,
        ready: false,
        nextId: 0,
        pending: new Map(),
        waiting: [],
        subscribers: new Set(),
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
      } else if (message.kind === 'event') {
        for (const subscriber of link.subscribers) subscriber(message.event);
      } else {
        const pending = link.pending.get(message.id);
        if (!pending) return;
        link.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new Error(message.error ?? 'The session host refused the request.'));
      }
    });
    child.once('exit', () => {
      if (link.child !== child) return;
      link.child = null;
      link.ready = false;
      for (const [id, pending] of link.pending) {
        clearTimeout(pending.timer);
        pending.reject(new SessionUnavailableError('The session host stopped before it answered.'));
        link.pending.delete(id);
      }
    });
  }

  /** Whether a host is running at this root and ready for requests. */
  ready(root: string): boolean {
    return this.links.get(root)?.ready === true;
  }

  /**
   * Ask the host, waiting up to `timeoutMs` for one to be ready if it is
   * still starting. Refused with `SessionUnavailableError` when none comes.
   */
  async request(root: string, request: SessionRequest, timeoutMs: number): Promise<unknown> {
    const link = this.link(root);
    const deadline = Date.now() + timeoutMs;
    while (!link.ready || !link.child) {
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

  /** Hear every event the host at this root records from now on. */
  subscribe(root: string, listener: (event: ServerEvent) => void): () => void {
    const link = this.link(root);
    link.subscribers.add(listener);
    return () => link.subscribers.delete(listener);
  }
}

type Handlers = {
  [K in SessionRequest['type']]: (
    request: Extract<SessionRequest, { type: K }>
  ) => Promise<unknown>;
};

/** What the host needs of its own process to talk to its parent: `process` itself. */
export type ParentPort = {
  send?: (message: unknown) => boolean;
  connected: boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
};

/**
 * The host's end, when it was started with a channel. Returns what to call
 * once the host is ready for requests, and what pushes an event up; null when
 * nothing started it with one.
 */
export function serveParent(
  handlers: Handlers,
  port: ParentPort
): {
  ready: () => void;
  push: (event: ServerEvent) => void;
  close: () => void;
} | null {
  if (!port.send) return null;
  const send = (message: unknown) => {
    if (port.connected) port.send!(message);
  };
  const onMessage = (raw: unknown) => {
    const parsed = toChildSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn('Ignoring an unreadable message from the parent process.');
      return;
    }
    const { id, request } = parsed.data;
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
  port.on('message', onMessage);
  return {
    ready: () => send({ kind: 'ready' }),
    push: (event) => send({ kind: 'event', event }),
    close: () => port.off('message', onMessage),
  };
}

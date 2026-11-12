import { z } from 'zod';
import {
  type BoxConnection,
  type BoxValve,
  type HostLink,
  type IdleSession,
  LET_GO_REASONS,
  type LetGoReason,
  REFUSE_REASONS,
  type RefuseReason,
  type WaitAnswer,
  type WaitRequest,
} from './box-valve';
import { WAIT_FOR_ROOM_MAX } from './room-wait';

/**
 * The box valve over the hub: what an isolated agent host and the
 * controller say to each other about room, on the hub connection the host
 * already holds. Every message is `{ type: 'valve', op, ... }`.
 *
 * The controller side trusts nothing it is sent: each message is held to a strict shape and a size,
 * rate-limited per connection, and read as the connection's own agent's.
 * Messages carry ids, times and counts only, never text; every reason is a
 * fixed code. A message refused is dropped, and refusals are logged at most
 * once a minute per connection, as codes and a count.
 */

export const VALVE_MESSAGE_MAX_BYTES = 4 * 1024;
/** A `hello` (up to 20 waiters) or a `state` (up to 100 idle sessions). */
export const VALVE_HELLO_MAX_BYTES = 64 * 1024;
/** How long the controller waits for a host to answer `park`. */
export const VALVE_PARK_TIMEOUT_MS = 5_000;
/** The most idle sessions one `state` may list. */
export const VALVE_STATE_MAX_IDLE = 100;

/** Agent, session, room, message and lease ids: Matrix and Switch ids, no spaces or controls. */
const id = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._:!$@#+=/-]+$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const requestId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const waitShape = z.strictObject({
  roomId: id,
  messageId: id,
  sessionId: id,
  sinceMs: time,
  kind: z.enum(['room', 'start']),
});

export const hostValveMessageSchema = z.discriminatedUnion('op', [
  z.strictObject({
    type: z.literal('valve'),
    op: z.literal('admit'),
    requestId,
    sessionId: id,
    kind: z.enum(['message', 'resume', 'warm']),
  }),
  z.strictObject({
    type: z.literal('valve'),
    op: z.literal('settle'),
    lease: id,
    /** Its session is up; false when the start failed or the lease went unused. */
    started: z.boolean(),
  }),
  z.strictObject({ type: z.literal('valve'), op: z.literal('wait'), requestId, wait: waitShape }),
  z.strictObject({ type: z.literal('valve'), op: z.literal('unwait'), requestId, messageId: id }),
  z.strictObject({
    type: z.literal('valve'),
    op: z.literal('hello'),
    // Over the box's list limit is refused whole.
    waiting: z.array(waitShape).max(WAIT_FOR_ROOM_MAX),
  }),
  z.strictObject({
    type: z.literal('valve'),
    op: z.literal('parked'),
    requestId,
    ok: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('valve'),
    op: z.literal('state'),
    awake: z.number().int().nonnegative().max(1000),
    idle: z
      .array(z.strictObject({ sessionId: id, idleSinceMs: time, duplicate: z.boolean() }))
      .max(VALVE_STATE_MAX_IDLE),
  }),
]);
export type HostValveMessage = z.infer<typeof hostValveMessageSchema>;

export const controllerValveMessageSchema = z.discriminatedUnion('op', [
  z.strictObject({
    type: z.literal('valve'),
    op: z.literal('ready'),
    /** The box's cap, and this agent's share of it while the hub is down. */
    cap: z.number().int().positive(),
    share: z.number().int().positive(),
  }),
  z.strictObject({ type: z.literal('valve'), op: z.literal('admitted'), requestId, lease: id }),
  z.strictObject({
    type: z.literal('valve'),
    op: z.literal('refused'),
    requestId,
    reason: z.enum(REFUSE_REASONS as [string, ...string[]]),
  }),
  z.strictObject({
    type: z.literal('valve'),
    op: z.literal('waited'),
    requestId,
    // `limit`: refused by the rate limit, not held; the host asks again.
    answer: z.enum(['waiting', 'already', 'limit', ...LET_GO_REASONS] as [string, ...string[]]),
  }),
  z.strictObject({
    type: z.literal('valve'),
    op: z.literal('unwaited'),
    requestId,
    // False: refused by the rate limit, so still on the list; the host asks again.
    ok: z.boolean(),
  }),
  z.strictObject({ type: z.literal('valve'), op: z.literal('park'), requestId, sessionId: id }),
  z.strictObject({ type: z.literal('valve'), op: z.literal('start'), sessionId: id, lease: id }),
  z.strictObject({
    type: z.literal('valve'),
    op: z.literal('letGo'),
    messageId: id,
    reason: z.enum(LET_GO_REASONS as [string, ...string[]]),
  }),
]);
export type ControllerValveMessage =
  | { type: 'valve'; op: 'ready'; cap: number; share: number }
  | { type: 'valve'; op: 'admitted'; requestId: number; lease: string }
  | { type: 'valve'; op: 'refused'; requestId: number; reason: RefuseReason }
  | { type: 'valve'; op: 'waited'; requestId: number; answer: WaitAnswer | 'limit' }
  | { type: 'valve'; op: 'unwaited'; requestId: number; ok: boolean }
  | { type: 'valve'; op: 'park'; requestId: number; sessionId: string }
  | { type: 'valve'; op: 'start'; sessionId: string; lease: string }
  | { type: 'valve'; op: 'letGo'; messageId: string; reason: LetGoReason };

/** Whether a raw hub frame is a valve message, read without parsing the rest. */
export function isValveFrame(raw: string): boolean {
  return /^\s*\{\s*"type"\s*:\s*"valve"/.test(raw);
}

/** A token bucket: `rate` a second, up to `burst` at once. */
export class RateLimit {
  private tokens: number;
  private at: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now
  ) {
    this.tokens = burst;
    this.at = now();
  }

  take(): boolean {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** The rates, per connection; `state` and `parked` at `settle`'s, each its own. */
export function valveRateLimits(now: () => number = Date.now) {
  return {
    admit: new RateLimit(10, 20, now),
    wait: new RateLimit(10, 20, now),
    settle: new RateLimit(20, 20, now),
    hello: new RateLimit(0.1, 1, now),
    state: new RateLimit(20, 20, now),
    parked: new RateLimit(20, 20, now),
  };
}

/** Why the controller dropped a valve message: logged as a code and a count, never the message. */
export type ValveRefusal = 'too_big' | 'unreadable' | 'limit' | 'untrusted';

export type ValveLog = {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
};

/**
 * The controller's side of one isolated host's valve connection. Built only
 * once the hub has proved the connection is that agent's current host; it
 * joins the box valve as that agent, and leaves it when the hub closes.
 */
export class ValveServer {
  private readonly connection: BoxConnection;
  private readonly limits: ReturnType<typeof valveRateLimits>;
  /** Null until the host's first `state`: then the valve counts its health file's figure. */
  private awake: number | null = null;
  private idle: IdleSession[] = [];
  private nextParkId = 0;
  private readonly parks = new Map<number, (ok: boolean) => void>();
  private readonly refusals = new Map<ValveRefusal, number>();
  private lastRefusalLog = Number.NEGATIVE_INFINITY;
  private closed = false;

  constructor(
    private readonly deps: {
      valve: BoxValve;
      agentId: string;
      send: (message: ControllerValveMessage) => void;
      log: ValveLog;
      /** This agent's share of the cap while the hub is down. */
      share: number;
      now?: () => number;
    }
  ) {
    this.limits = valveRateLimits(deps.now);
    const link: HostLink = {
      agentId: deps.agentId,
      awake: () => this.awake,
      idle: () => this.idle,
      park: (sessionId) => this.park(sessionId),
      start: (sessionId, lease) => deps.send({ type: 'valve', op: 'start', sessionId, lease }),
      letGo: (messageId, reason) => deps.send({ type: 'valve', op: 'letGo', messageId, reason }),
    };
    this.connection = deps.valve.connect(link);
    const cap = deps.valve.cap;
    if (Number.isFinite(cap))
      deps.send({ type: 'valve', op: 'ready', cap, share: Math.max(1, deps.share) });
  }

  /** One raw valve frame from the host. */
  receive(raw: string): void {
    if (this.closed) return;
    // Sized before it is parsed: only a `hello` or a `state` may be larger than 4 KiB.
    const bytes = Buffer.byteLength(raw, 'utf8');
    const large = /^\s*\{\s*"type"\s*:\s*"valve"\s*,\s*"op"\s*:\s*"(hello|state)"/.test(raw);
    if (bytes > (large ? VALVE_HELLO_MAX_BYTES : VALVE_MESSAGE_MAX_BYTES))
      return this.refuse('too_big');
    let message: HostValveMessage;
    try {
      message = hostValveMessageSchema.parse(JSON.parse(raw));
    } catch {
      return this.refuse('unreadable');
    }
    switch (message.op) {
      case 'admit':
        if (!this.limits.admit.take()) {
          this.refuse('limit');
          this.deps.send({
            type: 'valve',
            op: 'refused',
            requestId: message.requestId,
            reason: 'limit',
          });
          return;
        }
        void this.connection.admit(message.sessionId, message.kind).then((answer) =>
          this.deps.send(
            answer.ok
              ? {
                  type: 'valve',
                  op: 'admitted',
                  requestId: message.requestId,
                  lease: answer.lease,
                }
              : {
                  type: 'valve',
                  op: 'refused',
                  requestId: message.requestId,
                  reason: answer.reason,
                }
          )
        );
        return;
      case 'settle':
        // Dropped over the limit, its lease runs out at its time: the count runs high, never low.
        if (!this.limits.settle.take()) return this.refuse('limit');
        this.connection.settle(message.lease, message.started);
        return;
      case 'wait': {
        // Over the limit it is answered `limit`, never silence, so the host asks again.
        const allowed = this.limits.wait.take();
        if (!allowed) this.refuse('limit');
        this.deps.send({
          type: 'valve',
          op: 'waited',
          requestId: message.requestId,
          answer: allowed ? this.connection.wait(message.wait as WaitRequest) : 'limit',
        });
        return;
      }
      case 'unwait': {
        // A lost unwait would leave a waiter holding up admits for 10 minutes: answered either way.
        const allowed = this.limits.wait.take();
        if (allowed) this.connection.unwait(message.messageId);
        else this.refuse('limit');
        this.deps.send({
          type: 'valve',
          op: 'unwaited',
          requestId: message.requestId,
          ok: allowed,
        });
        return;
      }
      case 'hello': {
        if (!this.limits.hello.take()) return this.refuse('limit');
        const answers = this.connection.hello(message.waiting as WaitRequest[]);
        message.waiting.forEach((waiter, i) => this.answer(waiter.messageId, answers[i]!));
        return;
      }
      case 'parked': {
        if (!this.limits.parked.take()) return this.refuse('limit');
        const resolve = this.parks.get(message.requestId);
        this.parks.delete(message.requestId);
        resolve?.(message.ok);
        return;
      }
      case 'state':
        if (!this.limits.state.take()) return this.refuse('limit');
        this.awake = message.awake;
        this.idle = message.idle;
        return;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.parks.values()) resolve(false);
    this.parks.clear();
    this.connection.close();
    this.flushRefusals(true);
  }

  private answer(messageId: string, answer: WaitAnswer): void {
    if (answer === 'waiting' || answer === 'already') return;
    this.deps.send({ type: 'valve', op: 'letGo', messageId, reason: answer });
  }

  private park(sessionId: string): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    // Only a session this host offered: the valve never asks it for anything else.
    if (!this.idle.some((idle) => idle.sessionId === sessionId)) return Promise.resolve(false);
    const requestId = ++this.nextParkId;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.parks.delete(requestId);
        resolve(false);
      }, VALVE_PARK_TIMEOUT_MS);
      timer.unref?.();
      this.parks.set(requestId, (ok) => {
        clearTimeout(timer);
        if (ok) {
          // Gone from what it offers until its next `state` says otherwise.
          this.idle = this.idle.filter((idle) => idle.sessionId !== sessionId);
        }
        resolve(ok);
      });
      this.deps.send({ type: 'valve', op: 'park', requestId, sessionId });
    });
  }

  /** Dropped, counted, and logged at most once a minute per connection. */
  private refuse(reason: ValveRefusal): void {
    this.refusals.set(reason, (this.refusals.get(reason) ?? 0) + 1);
    this.flushRefusals(false);
  }

  private flushRefusals(force: boolean): void {
    if (!this.refusals.size) return;
    const now = (this.deps.now ?? Date.now)();
    if (!force && now - this.lastRefusalLog < 60_000) return;
    this.lastRefusalLog = now;
    this.deps.log.warn('Refused box valve messages from an agent host', {
      agentId: this.deps.agentId,
      refused: Object.fromEntries(this.refusals),
    });
    this.refusals.clear();
  }
}

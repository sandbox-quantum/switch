import {
  type AdmitKind,
  type BoxConnection,
  type BoxValve,
  LEASE_MS,
  type LetGoReason,
  type RefuseReason,
  type WaitAnswer,
  type WaitRequest,
} from './box-valve';
import type { ControllerValveMessage, HostValveMessage } from './box-valve-wire';
import { controllerValveMessageSchema } from './box-valve-wire';
import {
  boxLimitFromEnv,
  type ParkCandidate,
  type PressureValve,
  readBoxScaleUsage,
  startReserveFromEnv,
} from './memory-pressure';
import type { GiveUpReason, RoomWaiter } from './room-wait';

/**
 * An agent host's side of the box valve: one interface, three ways in.
 *
 * - `DirectHostValve`: a host in the controller's own process talks to the
 *   controller's `BoxValve` directly.
 * - `HubHostValve`: an isolated host talks to it over its hub connection,
 *   and falls back to a stricter valve of its own while the hub is down.
 * - `LegacyHostValve`: a host with no controller (Console's own hosts, an
 *   SSH host) keeps today's valve for its process, as before.
 *
 * The host keeps its messages either way: its journal and room lines, and
 * its local wait list with what each waiting message does when it starts or
 * is let go. The valve only decides.
 */

export type HostValveAnswer = { ok: true; lease: string } | { ok: false; reason: RefuseReason };

/** What the host tells its valve about itself. */
export type HostSide = {
  /** Its sessions that are up now. */
  awake(): number;
  /** Its sessions that could be parked now, each able to park itself. */
  idle(): ParkCandidate[];
  /** Its waiting messages, re-sent to the box valve on every (re)connect. */
  waiting(): WaitRequest[];
};

/** What the valve tells the host. */
export type HostValveEvents = {
  /**
   * Room freed for this waiting session: start it now (its `admit` gets the
   * room). Must resolve only once it has tried, including its `admit`: a room
   * not taken up by then is handed back as unused. A promise, so a handler
   * can't drop it by accident.
   */
  start(sessionId: string): Promise<unknown>;
  /** This waiting message is let go: post its line. */
  letGo(messageId: string, reason: LetGoReason): void;
};

export interface HostValve {
  /** Whether this valve is the box's (directly or over the hub) right now. */
  readonly boxWide: boolean;
  admit(sessionId: string, kind: AdmitKind): Promise<HostValveAnswer>;
  /** A start let in is done with: `started` once its session is up, false if it failed or wasn't used. */
  settle(lease: string, started: boolean): void;
  /**
   * A message waits: the box valve's answer, `waiting` or `already`, or a
   * reason it is let go at once (the box's list or the agent's share is
   * full). Without the box valve, `waiting`: the host's own list decides.
   */
  wait(request: WaitRequest): Promise<WaitAnswer>;
  unwait(messageId: string): void;
  /** Joins the host to the valve; the returned function leaves. */
  attach(host: HostSide, events: HostValveEvents): () => void;
  /** Something about the host's sessions changed. */
  changed(): void;
}

/** A waiting message as the box valve hears of it: ids and a time only. */
export function waitRequestOf(waiter: RoomWaiter): WaitRequest {
  return {
    roomId: waiter.roomId,
    messageId: waiter.messageId,
    sessionId: waiter.sessionId,
    sinceMs: Math.max(0, Math.round(waiter.sinceMs)),
    kind: waiter.kind ?? 'room',
  };
}

/** The host's own let-go reason (and so its line) for the box valve's code. */
export function giveUpReasonOf(reason: LetGoReason): GiveUpReason {
  return reason === 'list_full' || reason === 'agent_full' ? 'list full' : 'timed out';
}

/** The hub-down fallback's limits, from the same settings as today's valve. */
export function fallbackFromEnv(env: NodeJS.ProcessEnv = process.env): FallbackOptions {
  const limit = boxLimitFromEnv(env);
  return {
    limit,
    // The guard's scale: the larger of anon + shmem and the cgroup's figure.
    readUsage: () => readBoxScaleUsage(),
    startReserve: limit === null ? 0 : startReserveFromEnv(env),
  };
}

/** What a refusal says in the host's own log (never sent anywhere). */
export function refusalText(reason: RefuseReason): string {
  switch (reason) {
    case 'busy':
      return 'others are already waiting for room';
    case 'cap':
      return 'the box is at its limit of awake sessions';
    case 'memory':
      return 'the box is near its memory limit';
    case 'limit':
      return 'too many requests to the box valve';
    case 'held':
      return 'this agent is stopped or held by the memory guard';
  }
}

/** Today's valve, for a process with no controller: unchanged behaviour. */
export class LegacyHostValve implements HostValve {
  readonly boxWide = false;

  constructor(private readonly valve: PressureValve) {}

  async admit(): Promise<HostValveAnswer> {
    if (await this.valve.admit()) return { ok: true, lease: 'local' };
    return {
      ok: false,
      reason: this.valve.lastRefusal.includes('awake sessions') ? 'cap' : 'memory',
    };
  }

  settle(): void {
    this.valve.settle();
  }

  async wait(): Promise<WaitAnswer> {
    return 'waiting';
  }

  unwait(): void {}

  attach(host: HostSide, _events?: HostValveEvents): () => void {
    const unbind = [
      this.valve.register(() => host.idle()),
      this.valve.registerAwake(() => host.awake()),
    ];
    this.valve.watch();
    return () => {
      for (const fn of unbind) fn();
    };
  }

  changed(): void {}
}

/** A host in the controller's process, on the controller's box valve directly. */
export class DirectHostValve implements HostValve {
  readonly boxWide = true;
  private connection: BoxConnection | null = null;

  private readonly starts: StartLeases;

  constructor(
    private readonly valve: BoxValve,
    private readonly agentId: string,
    options: {
      log?: Pick<Console, 'warn'>;
      /** How long a box `start` may take before its room is handed back (tests). */
      startBoundMs?: number;
    } = {}
  ) {
    // Bounded and logged as the hub's hosts are.
    this.starts = new StartLeases(
      (lease) => this.settle(lease, false),
      options.log,
      options.startBoundMs
    );
  }

  async admit(sessionId: string, kind: AdmitKind): Promise<HostValveAnswer> {
    if (!this.connection) return { ok: false, reason: 'held' };
    return this.starts.taken(sessionId, await this.connection.admit(sessionId, kind));
  }

  settle(lease: string, started: boolean): void {
    this.connection?.settle(lease, started);
  }

  async wait(request: WaitRequest): Promise<WaitAnswer> {
    return this.connection?.wait(request) ?? 'waiting';
  }

  unwait(messageId: string): void {
    this.connection?.unwait(messageId);
  }

  attach(host: HostSide, events: HostValveEvents): () => void {
    const connection = this.valve.connect({
      agentId: this.agentId,
      awake: () => host.awake(),
      idle: () =>
        host
          .idle()
          .map(({ sessionId, idleSinceMs, duplicate }) => ({ sessionId, idleSinceMs, duplicate })),
      park: async (sessionId) => {
        const candidate = host.idle().find((c) => c.sessionId === sessionId);
        return candidate ? candidate.park() : false;
      },
      start: (sessionId, lease) =>
        this.starts.offer(sessionId, lease, () => events.start(sessionId)),
      letGo: (messageId, reason) => events.letGo(messageId, reason),
    });
    this.connection = connection;
    const waiting = host.waiting();
    connection.hello(waiting).forEach((answer, i) => {
      const messageId = waiting[i]!.messageId;
      if (answer !== 'waiting' && answer !== 'already')
        queueMicrotask(() => events.letGo(messageId, answer));
    });
    return () => {
      connection.close();
      if (this.connection === connection) this.connection = null;
    };
  }

  changed(): void {}
}

/** The hub connection as the valve sees it: owned by the hub stream. */
export interface ValveChannel {
  /** Sends one valve message; false when the hub isn't connected. */
  send(message: HostValveMessage): boolean;
  /** Each valve message the controller sends. */
  onMessage(listener: (message: unknown) => void): () => void;
  /** The hub connection closed. */
  onDown(listener: () => void): () => void;
}

/** A channel the hub stream binds its socket to; valve-side handlers stay put across reconnects. */
export class HubValveChannel implements ValveChannel {
  private sender: ((text: string) => boolean) | null = null;
  private readonly messages = new Set<(message: unknown) => void>();
  private readonly downs = new Set<() => void>();

  /** The hub stream's socket is open (`sender`), or gone (null). */
  bind(sender: ((text: string) => boolean) | null): void {
    const wasUp = this.sender !== null;
    this.sender = sender;
    if (wasUp && !sender) for (const listener of this.downs) listener();
  }

  /** One frame from the hub with `type: 'valve'`. */
  deliver(message: unknown): void {
    for (const listener of this.messages) listener(message);
  }

  send(message: HostValveMessage): boolean {
    return this.sender?.(JSON.stringify(message)) ?? false;
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onDown(listener: () => void): () => void {
    this.downs.add(listener);
    return () => this.downs.delete(listener);
  }
}

/** How long after a rate-limit refusal a host asks again. */
export const RETRY_AFTER_LIMIT_MS = 1_000;

/**
 * The room a `start` reserved for a waiting session, until that session's
 * `admit` takes it up. One the host doesn't take up (its messages had gone,
 * or it started another way) is handed back at once, rather than held until
 * the valve's lease runs out. A start that throws, or hasn't settled within
 * the lease's own time, hands its room back too, so a hung start can't hold
 * a place in the box's cap.
 */
class StartLeases {
  private readonly offered = new Map<string, string>();

  constructor(
    private readonly handBack: (lease: string) => void,
    // Logged through `log?.warn(…)` itself, so the box-log allow-list finds the line.
    private readonly log?: Pick<Console, 'warn'>,
    private readonly boundMs: number = LEASE_MS
  ) {}

  offer(sessionId: string, lease: string, start: () => unknown): void {
    this.offered.set(sessionId, lease);
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<'timed out'>((resolve) => {
      timer = setTimeout(() => resolve('timed out'), this.boundMs);
      timer.unref?.();
    });
    void Promise.race([
      Promise.resolve()
        .then(start)
        .then(
          () => 'settled' as const,
          () => 'threw' as const
        ),
      bound,
    ]).then((how) => {
      clearTimeout(timer);
      if (this.offered.get(sessionId) !== lease) return;
      this.offered.delete(sessionId);
      if (how !== 'settled')
        this.log?.warn(
          `The start for session ${sessionId} ${how} before taking its room; handed the room back.`
        );
      this.handBack(lease);
    });
  }

  /** An admit's answer: the offered room taken up, if this is it. */
  taken(sessionId: string, answer: HostValveAnswer): HostValveAnswer {
    if (answer.ok && this.offered.get(sessionId) === answer.lease) this.offered.delete(sessionId);
    return answer;
  }
}

/** While the hub is down, how long the fallback admits anything new. */
export const FALLBACK_MAX_MS = 2 * 60_000;
/** How long a host waits for the box valve to answer an `admit`. */
export const ADMIT_TIMEOUT_MS = 15_000;
/** How often a host re-sends its state while connected, beside every change. */
export const STATE_EVERY_MS = 5_000;

export type FallbackOptions = {
  /** The box's limit; null leaves the fallback (and the valve) off. */
  limit: number | null;
  readUsage: () => Promise<number | null>;
  /** What a start in flight counts as. */
  startReserve: number;
  refuseAt?: number;
};

/**
 * An isolated host on the controller's box valve, over its hub connection.
 *
 * Until the controller says `ready`, and whenever the hub is down, it falls
 * back to a narrow valve of its own (design, "When the hub is down"): only
 * its share of the cap, refused at the 90% line, and never a park or a shed,
 * so five hosts can't park together. After `FALLBACK_MAX_MS` without the
 * controller it admits nothing new until it is back. On `ready` it re-sends
 * its waiting messages and its state, and the box valve decides again.
 */
export class HubHostValve implements HostValve {
  private ready = false;
  /** When the box valve, once ready, went away; null while it is there or never was. */
  private lostAt: number | null = null;
  private share = 1;
  private nextRequest = 0;
  private readonly pending = new Map<
    number,
    { resolve: (answer: HostValveAnswer) => void; timer: NodeJS.Timeout }
  >();
  /** Starts the fallback let in, not yet settled. */
  private readonly local = new Set<string>();
  private readonly waits = new Map<
    number,
    { resolve: (answer: WaitAnswer) => void; timer: NodeJS.Timeout }
  >();
  private readonly unwaits = new Map<number, { messageId: string; timer: NodeJS.Timeout }>();
  /** Each wait asked and not yet answered, to ask again after a rate-limit refusal. */
  private readonly pendingWaits = new Map<number, WaitRequest>();
  private readonly starts: StartLeases;
  private host: HostSide | null = null;
  private events: HostValveEvents | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private stateQueued = false;
  private readonly unbind: (() => void)[] = [];
  private readonly now: () => number;

  constructor(
    private readonly channel: ValveChannel,
    private readonly fallback: FallbackOptions,
    private readonly options: {
      log?: Pick<Console, 'info' | 'warn'>;
      now?: () => number;
      fallbackMaxMs?: number;
      admitTimeoutMs?: number;
      /** How long a box `start` may take before its room is handed back (tests). */
      startBoundMs?: number;
    } = {}
  ) {
    this.now = options.now ?? Date.now;
    this.starts = new StartLeases(
      (lease) => this.settle(lease, false),
      options.log,
      options.startBoundMs
    );
  }

  get boxWide(): boolean {
    return this.ready;
  }

  async admit(sessionId: string, kind: AdmitKind): Promise<HostValveAnswer> {
    if (this.ready) {
      const requestId = ++this.nextRequest;
      const answer = new Promise<HostValveAnswer>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          resolve({ ok: false, reason: 'busy' });
        }, this.options.admitTimeoutMs ?? ADMIT_TIMEOUT_MS);
        timer.unref?.();
        this.pending.set(requestId, { resolve, timer });
      });
      // Not sent: the pending call is decided by the fallback, once.
      if (!this.channel.send({ type: 'valve', op: 'admit', requestId, sessionId, kind }))
        this.answer(requestId, null);
      return this.starts.taken(sessionId, await answer);
    }
    return this.admitLocally();
  }

  settle(lease: string, started: boolean): void {
    if (this.local.delete(lease)) return;
    this.channel.send({ type: 'valve', op: 'settle', lease, started });
  }

  wait(request: WaitRequest): Promise<WaitAnswer> {
    if (!this.ready) return Promise.resolve('waiting');
    const requestId = ++this.nextRequest;
    const answer = new Promise<WaitAnswer>((resolve) => {
      // No answer in time: it waits here, and the next `hello` tells the box valve.
      const timer = setTimeout(() => this.waited(requestId, 'waiting'), 5_000);
      timer.unref?.();
      this.waits.set(requestId, { resolve, timer });
    });
    this.pendingWaits.set(requestId, request);
    if (!this.channel.send({ type: 'valve', op: 'wait', requestId, wait: request })) {
      this.pendingWaits.delete(requestId);
      this.waited(requestId, 'waiting');
    }
    return answer.finally(() => this.pendingWaits.delete(requestId));
  }

  private waited(requestId: number, answer: WaitAnswer): void {
    const call = this.waits.get(requestId);
    if (!call) return;
    this.waits.delete(requestId);
    clearTimeout(call.timer);
    call.resolve(answer);
  }

  /**
   * Asks again after a rate-limit refusal, in the background: it waits here
   * meanwhile, and a let-go the box valve answers then is acted on as one.
   */
  private waitAgain(request: WaitRequest): void {
    setTimeout(() => {
      if (!this.ready) return;
      void this.wait(request).then((answer) => {
        if (answer !== 'waiting' && answer !== 'already' && answer !== 'held')
          this.events?.letGo(request.messageId, answer);
      });
    }, RETRY_AFTER_LIMIT_MS).unref?.();
  }

  /** Takes a message off the box's list; asked again until it is answered, while connected. */
  unwait(messageId: string): void {
    if (!this.ready) return;
    const requestId = ++this.nextRequest;
    if (!this.channel.send({ type: 'valve', op: 'unwait', requestId, messageId })) return;
    // No answer in time: asked again (a reconnect's hello rebuilds the list anyway).
    const timer = setTimeout(() => this.unwaited(requestId, false), 5_000);
    timer.unref?.();
    this.unwaits.set(requestId, { messageId, timer });
  }

  private unwaited(requestId: number, ok: boolean): void {
    const call = this.unwaits.get(requestId);
    if (!call) return;
    this.unwaits.delete(requestId);
    clearTimeout(call.timer);
    if (ok) return;
    setTimeout(() => this.unwait(call.messageId), RETRY_AFTER_LIMIT_MS).unref?.();
  }

  attach(host: HostSide, events: HostValveEvents): () => void {
    this.host = host;
    this.events = events;
    this.unbind.push(
      this.channel.onMessage((raw) => this.receive(raw)),
      this.channel.onDown(() => this.down())
    );
    return () => {
      for (const fn of this.unbind.splice(0)) fn();
      this.down();
      this.lostAt = null;
      this.host = null;
      this.events = null;
    };
  }

  changed(): void {
    if (!this.ready || this.stateQueued) return;
    this.stateQueued = true;
    setTimeout(() => {
      this.stateQueued = false;
      this.sendState();
    }, 100).unref?.();
  }

  private receive(raw: unknown): void {
    const parsed = controllerValveMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.options.log?.warn('Ignored a box valve message this host does not read.');
      return;
    }
    const message = parsed.data as ControllerValveMessage;
    switch (message.op) {
      case 'ready':
        this.share = message.share;
        if (!this.ready) this.up();
        return;
      case 'admitted':
        // Too late (the host gave up waiting): the room is handed straight back.
        if (!this.pending.has(message.requestId)) {
          this.channel.send({ type: 'valve', op: 'settle', lease: message.lease, started: false });
          return;
        }
        this.answer(message.requestId, { ok: true, lease: message.lease });
        return;
      case 'refused':
        this.answer(message.requestId, { ok: false, reason: message.reason });
        return;
      case 'waited': {
        const request = this.pendingWaits.get(message.requestId);
        if (message.answer !== 'limit') {
          this.waited(message.requestId, message.answer);
          return;
        }
        // Refused by the rate limit: it waits here meanwhile, and is asked again.
        this.waited(message.requestId, 'waiting');
        if (request) this.waitAgain(request);
        return;
      }
      case 'unwaited':
        this.unwaited(message.requestId, message.ok);
        return;
      case 'park': {
        const candidate = this.host?.idle().find((c) => c.sessionId === message.sessionId);
        void (candidate ? candidate.park() : Promise.resolve(false))
          .catch(() => false)
          .then((ok) => {
            this.channel.send({ type: 'valve', op: 'parked', requestId: message.requestId, ok });
            if (ok) this.changed();
          });
        return;
      }
      case 'start': {
        const events = this.events;
        this.starts.offer(message.sessionId, message.lease, () => events?.start(message.sessionId));
        return;
      }
      case 'letGo':
        this.events?.letGo(message.messageId, message.reason);
        return;
    }
  }

  private up(): void {
    this.ready = true;
    if (this.lostAt !== null)
      this.options.log?.info('Back on the box valve: the controller is reachable again.');
    this.lostAt = null;
    // Its journal is the source of truth: the box valve rebuilds its list from these.
    this.channel.send({ type: 'valve', op: 'hello', waiting: this.host?.waiting() ?? [] });
    this.sendState();
    this.stateTimer = setInterval(() => this.sendState(), STATE_EVERY_MS);
    this.stateTimer.unref?.();
  }

  private down(): void {
    if (this.stateTimer) clearInterval(this.stateTimer);
    this.stateTimer = null;
    for (const id of [...this.pending.keys()]) this.answer(id, null);
    for (const id of [...this.waits.keys()]) this.waited(id, 'waiting');
    this.pendingWaits.clear();
    for (const call of this.unwaits.values()) clearTimeout(call.timer);
    this.unwaits.clear();
    if (!this.ready) return;
    this.ready = false;
    this.lostAt = this.now();
    this.options.log?.warn(
      `The box valve is unreachable; this host keeps to its share of ${this.share} awake session(s), parks nothing, and starts nothing new after ${Math.round((this.options.fallbackMaxMs ?? FALLBACK_MAX_MS) / 1000)} s without it.`
    );
  }

  /** An `admit` answered (or dropped: null, decided by the fallback instead). */
  private answer(requestId: number, answer: HostValveAnswer | null): void {
    const call = this.pending.get(requestId);
    if (!call) return;
    this.pending.delete(requestId);
    clearTimeout(call.timer);
    if (answer) call.resolve(answer);
    else void this.admitLocally().then(call.resolve);
  }

  private sendState(): void {
    if (!this.ready || !this.host) return;
    const idle = this.host
      .idle()
      .slice(0, 100)
      .map(({ sessionId, idleSinceMs, duplicate }) => ({
        sessionId,
        idleSinceMs: Math.max(0, Math.round(idleSinceMs)),
        duplicate,
      }));
    this.channel.send({ type: 'valve', op: 'state', awake: this.host.awake(), idle });
  }

  /** The narrow fallback: its share, the 90% line, and nothing new once it has gone on too long. */
  private async admitLocally(): Promise<HostValveAnswer> {
    const { limit } = this.fallback;
    if (limit === null) return this.localLease();
    if (
      this.lostAt !== null &&
      this.now() - this.lostAt >= (this.options.fallbackMaxMs ?? FALLBACK_MAX_MS)
    )
      return { ok: false, reason: 'cap' };
    if ((this.host?.awake() ?? 0) + this.local.size + 1 > this.share)
      return { ok: false, reason: 'cap' };
    const usage = await this.fallback.readUsage().catch(() => null);
    if (
      usage !== null &&
      usage + (this.local.size + 1) * this.fallback.startReserve >=
        (this.fallback.refuseAt ?? 0.9) * limit
    )
      return { ok: false, reason: 'memory' };
    return this.localLease();
  }

  private localLease(): HostValveAnswer {
    const lease = `local-${++this.nextRequest}`;
    this.local.add(lease);
    return { ok: true, lease };
  }
}

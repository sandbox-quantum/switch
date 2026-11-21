import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { type ParkCandidate, parkOrder } from './memory-pressure';
import { SESSION_READY_MS } from './room-control-followup';
import { WAIT_FOR_ROOM_MAX, WAIT_FOR_ROOM_MS, WAIT_FOR_ROOM_RETRY_MS } from './room-wait';

/**
 * One valve and one wait list for the whole box.
 * With a login every agent's host is a
 * process of its own, so a valve per process acts per agent: five valves read
 * the same box and park together. This one is owned by the controller, and
 * every host asks it before it starts a session, over the hub (isolated
 * hosts) or directly (hosts in the controller's own process).
 *
 * It decides; the hosts keep the messages. A host still holds its journal and
 * posts its own room lines: here it is told `start` (room has freed for its
 * oldest waiter), `park` (the box needs memory back) and `letGo` (a limit was
 * reached), always for its own agent only.
 *
 * Transport-agnostic: nothing in here checks shapes, sizes or rates. The hub
 * side (`box-valve-wire.ts`) does, before anything reaches it.
 */

/** Why a start was refused: fixed codes only, never free text. */
export type RefuseReason = 'busy' | 'cap' | 'memory' | 'limit' | 'held';
/** Why a waiting message was let go: fixed codes only. */
export type LetGoReason = 'timed_out' | 'list_full' | 'agent_full' | 'reset' | 'held';
export const REFUSE_REASONS: readonly RefuseReason[] = ['busy', 'cap', 'memory', 'limit', 'held'];
export const LET_GO_REASONS: readonly LetGoReason[] = [
  'timed_out',
  'list_full',
  'agent_full',
  'reset',
  'held',
];

/** What a start is for: a message owed an answer, a resume after a restart, or a warm (owed nothing). */
export type AdmitKind = 'message' | 'resume' | 'warm';
export type WaitKind = 'room' | 'start';

export type AdmitAnswer = { ok: true; lease: string } | { ok: false; reason: RefuseReason };

/** At most this many messages of one agent wait at once, so one busy agent can't fill the list. */
export const WAIT_FOR_ROOM_PER_AGENT = 10;
/** An admitted start not settled by then is dropped: the session should be up long before. */
export const LEASE_MS = SESSION_READY_MS + 5_000;
/** The highest `parks` goes: Core takes no count above this. */
export const MAX_PARK_COUNT = 1_000_000;

/** The most parks in one shed: past this the guard is the backstop. */
export const MAX_PARKS_PER_SHED = 15;
/**
 * Settles in a row a shed waits for a memory reading before it gives up:
 * a failed reading is never taken as "under the stop line".
 */
export const SHED_UNREADABLE_SETTLES = 5;
/**
 * A session given room that then failed to start for another reason is
 * stepped over for this long, so one broken session never holds the rest up.
 */
export const STEP_OVER_MS = 30_000;
/**
 * A health read at least this long after a cap park is taken to show the parked session gone (its host writes its
 * health as soon as the session has parked).
 */
export const PARK_SETTLE_MS = 2_000;
/** A waiter re-sent in a `hello` is placed no earlier than this before the valve started. */
export const HELLO_FLOOR_MS = WAIT_FOR_ROOM_MS;
/**
 * How long after the valve starts a `hello` may bring a waiter it has never
 * seen with its journal time: the hosts re-sending what a restart lost. After
 * that, a waiter it has never seen is placed when it arrives.
 */
export const HELLO_GRACE_MS = 60_000;

const MIB = 1024 * 1024;
/** What the controller holds at rest (A and B measured 240–244 MiB on `l2fix7`). */
export const CONTROLLER_RESTING_BYTES = 250 * MIB;
/** Room kept free under the limit, so the count acts before the 80% park line. */
export const CAP_HEADROOM = 0.25;
/** What one awake session is allowed (B: about 300 MiB each with 16 awake, plus margin). */
export const SESSION_ALLOWANCE_BYTES = 350 * MIB;

export type BoxCap = {
  cap: number;
  /** What the memory formula gives. */
  formula: number;
  /** `SWITCH_BOX_MAX_AWAKE_SESSIONS` when it is set and valid, whether or not it won. */
  bound: number | null;
};

/**
 * The most sessions awake at once, worked out once from the box's
 * memory limit: floor((limit − resting − 25% headroom) ÷ 350 MiB), at least 1.
 * `SWITCH_BOX_MAX_AWAKE_SESSIONS` can only lower it: above the formula it is
 * ignored, below it wins. A value that isn't a positive whole number is
 * ignored with a warning, never read as "no limit".
 */
export function boxCap(
  limit: number,
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'warn'> = console
): BoxCap {
  const formula = Math.max(
    1,
    Math.floor((limit - CONTROLLER_RESTING_BYTES - CAP_HEADROOM * limit) / SESSION_ALLOWANCE_BYTES)
  );
  const raw = env.SWITCH_BOX_MAX_AWAKE_SESSIONS?.trim();
  let bound: number | null = null;
  if (raw) {
    const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (Number.isSafeInteger(value) && value > 0) bound = value;
    else
      log.warn(
        'SWITCH_BOX_MAX_AWAKE_SESSIONS is not a positive whole number, so it is ignored; the cap comes from the box memory alone.'
      );
  }
  return { cap: bound !== null && bound < formula ? bound : formula, formula, bound };
}

/** One idle session a host could park: no turn running, not being started. */
export type IdleSession = Omit<ParkCandidate, 'park'>;

/**
 * What the valve can ask of one connected host, always for that host's own
 * agent. Over the hub `park`, `start` and `letGo` are messages; `awake` and
 * `idle` come from the host's health, which the controller already reads.
 */
export type HostLink = {
  readonly agentId: string;
  /** Sessions up on this host now; null while it hasn't said yet. */
  awake(): number | null;
  /** Its sessions that could be parked now. */
  idle(): IdleSession[];
  /** Asks it to park one of its sessions; resolves to whether it agreed. */
  park(sessionId: string): Promise<boolean>;
  /** Room has freed for its waiting session: an `admit` for it now gets `lease`. */
  start(sessionId: string, lease: string): void;
  /** One of its waiting messages is let go: it posts the line. */
  letGo(messageId: string, reason: LetGoReason): void;
};

export type BoxValveOptions = {
  /** The box's memory limit in bytes; null leaves the valve off (a laptop). */
  limit: number | null;
  /** The box's use on the same scale as the guard (`readBoxMemory`); null when unreadable. */
  readUsage: () => Promise<number | null>;
  /** The cap on sessions awake at once; worked out from `limit` and the env when not given. */
  cap?: number;
  /** What a start in flight counts as on top of the reading. */
  startReserve?: number;
  startAt?: number;
  stopAt?: number;
  refuseAt?: number;
  /** How long after a park before the next: the reading needs this long to fall. */
  settleMs?: number;
  /** Whether the guard is stopping or holding an agent: the valve leaves it alone. */
  isHeld?: (agentId: string) => boolean;
  /** Told while a shed runs, so the guard pauses only its slow-leak clock. */
  onShedding?: (shedding: boolean) => void;
  /**
   * Told of each wait-list change, after the decision and outside it, for
   * the controller's live status: counts only, so ids are cut to 8 characters
   * and a reason is a fixed code. Called synchronously and not awaited: a
   * listener that throws, or returns a promise that rejects, changes nothing
   * the valve decides. A wait is told once, at its first placement, never
   * again for a reconnect's `hello`.
   */
  onEvent?: (event: ValveEvent) => void;
  /**
   * Whether starts may be admitted at all (on a split box, false while the launcher
   * is quiet or lost, so nothing grows that can't be measured). Absent, always.
   */
  admitting?: () => boolean;
  maxWaiting?: number;
  maxPerAgent?: number;
  maxWaitMs?: number;
  leaseMs?: number;
  stepOverMs?: number;
  now?: () => number;
  log?: Pick<Console, 'info' | 'warn'>;
};

type Lease = {
  id: string;
  connection: BoxConnection;
  sessionId: string;
  expiresAt: number;
  /** Made for a waiter (`start`) and not yet taken up by its host's `admit`. */
  reserved: boolean;
};

type Waiter = {
  connection: BoxConnection;
  roomId: string;
  messageId: string;
  sessionId: string;
  sinceMs: number;
  kind: WaitKind;
};

export type WaitRequest = {
  roomId: string;
  messageId: string;
  sessionId: string;
  sinceMs: number;
  kind: WaitKind;
};

export type WaitAnswer = 'waiting' | 'already' | LetGoReason;

/** A wait-list change, as the live status counts it (`BoxValveOptions.onEvent`). */
export type ValveEvent = {
  kind: 'wait' | 'granted' | 'let_go';
  /** The agent and its session (the conversation), each cut to 8 characters. */
  agent: string;
  conversation: string;
  /** Why it was let go; null for `wait` and `granted`. */
  reason: LetGoReason | null;
};

export type BoxValveStatus = {
  enabled: boolean;
  cap: number | null;
  awake: number;
  starting: number;
  waiting: number;
  waitingForRoom: number;
};

const keyOf = (agentId: string, messageId: string) => JSON.stringify([agentId, messageId]);

export class BoxValve {
  private readonly connections = new Set<BoxConnection>();
  private readonly leases = new Map<string, Lease>();
  private readonly waiters = new Map<string, Waiter>();
  /** Each connection's last awake count it gave: kept when a later read fails. */
  private readonly lastAwake = new Map<BoxConnection, number>();
  /** Each agent's awake count from its health file, as the controller's status poll last read it. */
  private readonly healthAwake = new Map<string, number>();
  /** When each message was first placed, kept past a disconnect so a reconnect keeps its place. */
  private readonly firstSeen = new Map<string, number>();
  /** Sessions given room that failed to start: not given room again until then. */
  private readonly steppedOver = new Map<string, number>();
  /**
   * Confirmed cap parks whose session may still be in the counts: until that agent's count drops below what it was,
   * or its health is read again at least `PARK_SETTLE_MS` after the park, or `LEASE_MS` passes, a start over the cap
   * is refused up front rather than parking another idle session for no gain.
   */
  private readonly parksInCounts: { agentId: string; at: number; before: number }[] = [];
  /** When each agent's health was last read by the status poll. */
  private readonly healthReadAt = new Map<string, number>();
  /** Refusals by reason, for a log line at most once a minute. */
  private readonly refusals = new Map<RefuseReason, { at: number; count: number }>();
  private shedding: Promise<void> | null = null;
  /** Every park, box-wide, goes through here: one at a time, a settle apart. */
  private parking: Promise<unknown> = Promise.resolve();
  /** Parks a host confirmed since the controller started, capped (`parks`). */
  private parkCount = 0;
  private lastParkAt = Number.NEGATIVE_INFINITY;
  private ticking: Promise<void> | null = null;
  /** Admits and grants, one at a time (`exclusive`). */
  private deciding: Promise<unknown> = Promise.resolve();
  private timers: NodeJS.Timeout[] = [];
  private warnedUnreadable = false;
  /** The box has given at least one good reading: from then on a failed one fails closed. */
  private everRead = false;
  /** In a run of failed readings after a good one: new starts wait until a reading returns. */
  private readFailing = false;
  /** The last good reading, in bytes. */
  private lastGood: number | null = null;
  readonly startAt: number;
  readonly stopAt: number;
  readonly refuseAt: number;
  readonly settleMs: number;
  readonly cap: number;
  readonly maxWaiting: number;
  readonly maxPerAgent: number;
  readonly maxWaitMs: number;
  readonly startedAt: number;
  private readonly reserve: number;
  private readonly now: () => number;
  private readonly log: Pick<Console, 'info' | 'warn'>;

  constructor(private readonly options: BoxValveOptions) {
    this.startAt = options.startAt ?? 0.8;
    this.stopAt = options.stopAt ?? 0.65;
    this.refuseAt = options.refuseAt ?? 0.9;
    this.settleMs = options.settleMs ?? 1500;
    this.maxWaiting = options.maxWaiting ?? WAIT_FOR_ROOM_MAX;
    this.maxPerAgent = options.maxPerAgent ?? WAIT_FOR_ROOM_PER_AGENT;
    this.maxWaitMs = options.maxWaitMs ?? WAIT_FOR_ROOM_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? console;
    this.startedAt = this.now();
    this.reserve = options.limit === null ? 0 : (options.startReserve ?? 512 * MIB);
    this.cap =
      options.limit === null
        ? Number.POSITIVE_INFINITY
        : (options.cap ?? boxCap(options.limit, process.env, this.log).cap);
  }

  /**
   * Whether the valve is protecting the box's memory: false
   * while the box has never given a reading (or the valve is off), so it parks
   * and refuses nothing for memory. Read-only, for the controller to report.
   */
  get memoryProtected(): boolean {
    return this.enabled && this.everRead;
  }

  /**
   * A memory problem the controller reports to Core: the
   * box has never given a reading (`unprotected`: nothing is parked or
   * refused for memory), or readings are failing after good ones (`failing`:
   * new starts wait). Null when readings are fine, or the valve is off.
   */
  get memoryProblem(): 'unprotected' | 'failing' | null {
    if (!this.enabled) return null;
    if (this.readFailing) return 'failing';
    if (!this.everRead && this.warnedUnreadable) return 'unprotected';
    return null;
  }

  /**
   * Sessions parked since the controller started, however the valve asked
   * (memory, the cap or room for a start): a host-confirmed park counts once.
   * Capped at `MAX_PARK_COUNT`, for the status report's `valve_parks`.
   */
  get parks(): number {
    return this.parkCount;
  }

  get enabled(): boolean {
    return this.options.limit !== null;
  }

  /** A host joins: everything it asks goes through the connection, for its agent only. */
  connect(link: HostLink): BoxConnection {
    const connection = new BoxConnection(this, link);
    this.connections.add(connection);
    return connection;
  }

  /**
   * Sessions up across the box, counting high, never low. Each agent counts
   * as the larger of what its host last said and what its health file last
   * said: a host that hasn't said yet, or whose report fails, keeps its last
   * known count and never counts as none. An agent the guard is stopping or
   * holding still counts until its sessions are gone, and so does one whose
   * host has disconnected but whose health still shows sessions up. (Starts
   * in flight are added on top, as `starting`.)
   */
  get awake(): number {
    let total = 0;
    for (const count of this.countsByAgent().values()) total += count;
    return total;
  }

  /** Each agent's awake count, as `awake` adds them up. */
  private countsByAgent(): Map<string, number> {
    const byAgent = new Map<string, number>();
    for (const connection of this.connections) {
      const said = safe((): number | null | undefined => connection.link.awake(), undefined);
      if (typeof said === 'number' && Number.isFinite(said) && said >= 0)
        this.lastAwake.set(connection, said);
      const known = this.lastAwake.get(connection) ?? 0;
      byAgent.set(connection.agentId, Math.max(byAgent.get(connection.agentId) ?? 0, known));
    }
    for (const [agentId, count] of this.healthAwake)
      byAgent.set(agentId, Math.max(byAgent.get(agentId) ?? 0, count));
    return byAgent;
  }

  /**
   * The agents the controller's status poll read this time: any other
   * agent's health figure is dropped, so an agent removed or unassigned
   * stops counting rather than holding room for good.
   */
  keepHealthOnly(agentIds: Iterable<string>): void {
    const keep = new Set(agentIds);
    for (const agentId of [...this.healthAwake.keys()])
      if (!keep.has(agentId)) this.healthAwake.delete(agentId);
    for (const agentId of [...this.healthReadAt.keys()])
      if (!keep.has(agentId)) this.healthReadAt.delete(agentId);
  }

  /** The controller's status poll read this agent's health file: `count` sessions awake. */
  noteHealth(agentId: string, count: number): void {
    if (!Number.isFinite(count) || count < 0) return;
    this.healthAwake.set(agentId, count);
    this.healthReadAt.set(agentId, this.now());
  }

  /** Starts admitted and not yet settled, box-wide. */
  get starting(): number {
    this.expireLeases();
    return this.leases.size;
  }

  status(): BoxValveStatus {
    let waitingForRoom = 0;
    for (const waiter of this.waiters.values()) if (waiter.kind === 'room') waitingForRoom++;
    return {
      enabled: this.enabled,
      cap: this.enabled ? this.cap : null,
      awake: this.awake,
      starting: this.starting,
      waiting: this.waiters.size,
      waitingForRoom,
    };
  }

  /** Watches memory every `intervalMs`, and the wait list every `waitRetryMs`, while enabled. */
  watch(intervalMs = 5000, waitRetryMs = WAIT_FOR_ROOM_RETRY_MS): () => void {
    if (!this.enabled || this.timers.length) return () => {};
    this.timers = [
      setInterval(() => void this.check(), intervalMs),
      setInterval(() => void this.tick(), waitRetryMs),
    ];
    for (const timer of this.timers) timer.unref?.();
    return () => {
      for (const timer of this.timers) clearInterval(timer);
      this.timers = [];
    };
  }

  /** The guard stopped or holds this agent: its leases and waiters go at once, without a line. */
  dropAgent(agentId: string): void {
    for (const [id, lease] of this.leases)
      if (lease.connection.agentId === agentId) this.leases.delete(id);
    for (const [key, waiter] of this.waiters)
      if (waiter.connection.agentId === agentId) this.waiters.delete(key);
  }

  /** Parks the quietest idle sessions, box-wide, one a settle apart, while past `startAt`. */
  async check(): Promise<void> {
    const usage = await this.usage();
    if (usage !== null && usage >= this.startAt * this.limit) await this.shed();
  }

  /**
   * One round of the wait list: lets go of every message past its limit, then
   * gives room to the waiting sessions oldest first, box-wide, stopping at the
   * first that finds none, so a younger message never starts ahead of an
   * older one. One round at a time.
   */
  tick(): Promise<void> {
    this.ticking ??= this.round().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  // ---- what connections call ----

  /** @internal */
  async admitFor(
    connection: BoxConnection,
    sessionId: string,
    kind: AdmitKind
  ): Promise<AdmitAnswer> {
    if (this.held(connection.agentId)) return { ok: false, reason: 'held' };
    // Nothing starts while the box can't be measured; its waiters wait.
    if (!this.admitting()) return { ok: false, reason: 'limit' };
    this.expireLeases();
    // Room freed for this session's waiters: the `start` it was sent.
    for (const lease of this.leases.values())
      if (lease.reserved && lease.connection === connection && lease.sessionId === sessionId) {
        lease.reserved = false;
        lease.expiresAt = this.now() + this.leaseMs;
        return { ok: true, lease: lease.id };
      }
    if (!this.enabled) return { ok: true, lease: this.addLease(connection, sessionId, false) };
    // One decision at a time, box-wide: two starts deciding together would
    // both see the same last slot free.
    return this.exclusive(async (): Promise<AdmitAnswer> => {
      if (!connection.isOpen) return { ok: false, reason: 'limit' };
      if (this.held(connection.agentId)) return { ok: false, reason: 'held' };
      if (!this.admitting()) return { ok: false, reason: 'limit' };
      // Others are waiting for room: a new start goes behind them.
      if (this.waitingForRoomExcept(connection, sessionId)) return { ok: false, reason: 'busy' };
      // A warm is owed nothing, so it never parks anyone to make room.
      const reason = await this.room(kind !== 'warm');
      if (reason) {
        this.refused(reason, kind === 'warm');
        return { ok: false, reason };
      }
      // It may have gone while room was being made: no lease for a closed host.
      if (!connection.isOpen) return { ok: false, reason: 'limit' };
      return { ok: true, lease: this.addLease(connection, sessionId, false) };
    });
  }

  /** Runs `decide` after every decision before it: admits and the wait list's grants. */
  private exclusive<T>(decide: () => Promise<T>): Promise<T> {
    const run = this.deciding.then(decide, decide);
    this.deciding = run.catch(() => undefined);
    return run;
  }

  /**
   * A start is up (`started`), or failed or was never used. A start given
   * room for waiting messages that failed is stepped over for a while, so
   * one broken session never holds the rest up.
   *
   * @internal
   */
  settleFor(connection: BoxConnection, lease: string, started: boolean): void {
    const found = this.leases.get(lease);
    if (!found || found.connection !== connection) return;
    this.leases.delete(lease);
    if (!started && this.waitsFor(connection, found.sessionId))
      this.steppedOver.set(stepKey(connection.agentId, found.sessionId), this.now());
  }

  /** A refusal, logged at most once a minute per reason with how many since (warms at info). */
  private refused(reason: RefuseReason, warm: boolean): void {
    const now = Date.now();
    const seen = this.refusals.get(reason) ?? { at: Number.NEGATIVE_INFINITY, count: 0 };
    seen.count++;
    this.refusals.set(reason, seen);
    if (now - seen.at < 60_000) return;
    const line = `Refusing session starts: ${reason} (${seen.count} since the last line).`;
    if (warm) this.log.info(line);
    else this.log.warn(line);
    seen.at = now;
    seen.count = 0;
  }

  /** @internal */
  waitFor(connection: BoxConnection, request: WaitRequest, from: 'live' | 'hello'): WaitAnswer {
    const firstPlacement = !this.firstSeen.has(keyOf(connection.agentId, request.messageId));
    const answer = this.placeWaiter(connection, request, from);
    if (answer === 'waiting') {
      if (firstPlacement) this.emit('wait', connection.agentId, request.sessionId, null);
    } else if (answer !== 'already') {
      this.emit('let_go', connection.agentId, request.sessionId, answer);
    }
    return answer;
  }

  private placeWaiter(
    connection: BoxConnection,
    request: WaitRequest,
    from: 'live' | 'hello'
  ): WaitAnswer {
    const key = keyOf(connection.agentId, request.messageId);
    const existing = this.waiters.get(key);
    if (existing) {
      // A reconnect re-sends it: same place in the list, new connection.
      existing.connection = connection;
      return 'already';
    }
    if (this.held(connection.agentId)) return 'held';
    // Never earlier than the valve's own first sight allows.
    // The later of what the host says and the valve's own first sight:
    // a live `wait` is placed when it arrives, a `hello` re-send where it was first placed, and
    // one the valve has never seen, re-sent just after a restart, no earlier than the restart
    // less the wait limit.
    const seen = this.firstSeen.get(key);
    const floor =
      seen ??
      (from === 'hello' && this.now() - this.startedAt <= HELLO_GRACE_MS
        ? this.startedAt - HELLO_FLOOR_MS
        : this.now());
    const sinceMs = Math.min(Math.max(request.sinceMs, floor), this.now());
    if (this.now() - sinceMs >= this.maxWaitMs) return 'timed_out';
    if (this.waiters.size >= this.maxWaiting) return 'list_full';
    let mine = 0;
    for (const waiter of this.waiters.values())
      if (waiter.connection.agentId === connection.agentId) mine++;
    if (mine >= this.maxPerAgent) return 'agent_full';
    this.waiters.set(key, { connection, ...request, sinceMs });
    this.firstSeen.set(key, sinceMs);
    return 'waiting';
  }

  /** @internal */
  unwaitFor(connection: BoxConnection, messageId: string): void {
    this.waiters.delete(keyOf(connection.agentId, messageId));
  }

  /** @internal */
  closed(connection: BoxConnection): void {
    this.connections.delete(connection);
    this.lastAwake.delete(connection);
    // A dead host never holds slots: its leases go the moment it does.
    for (const [id, lease] of this.leases)
      if (lease.connection === connection) this.leases.delete(id);
    // Its waiters go too, without a line; its `hello` re-sends them when it is back.
    for (const [key, waiter] of this.waiters)
      if (waiter.connection === connection) this.waiters.delete(key);
  }

  // ---- inside ----

  private get limit(): number {
    return this.options.limit ?? Number.POSITIVE_INFINITY;
  }

  private get leaseMs(): number {
    return this.options.leaseMs ?? LEASE_MS;
  }

  private emit(
    kind: ValveEvent['kind'],
    agentId: string,
    sessionId: string,
    reason: LetGoReason | null
  ): void {
    const onEvent = this.options.onEvent;
    if (!onEvent) return;
    safe(() => {
      const returned: unknown = onEvent({
        kind,
        agent: agentId.slice(0, 8),
        conversation: sessionId.slice(0, 8),
        reason,
      });
      // A listener written as async: its rejection is caught here, never left unhandled.
      if (returned instanceof Promise) returned.catch(() => undefined);
    }, undefined);
  }

  private admitting(): boolean {
    return safe(() => this.options.admitting?.() ?? true, false);
  }

  /**
   * Parks every idle session, box-wide, one a settle apart, up to
   * `MAX_PARKS_PER_SHED` (on a split box, the launcher went quiet, so no agent's
   * growth can be measured). Returns how many parked.
   */
  async parkIdle(): Promise<number> {
    const tried = new Set<string>();
    let parks = 0;
    while (parks < MAX_PARKS_PER_SHED) {
      const parked = await this.park(async () => this.quietest(tried));
      if (!parked) break;
      tried.add(stepKey(parked.connection.agentId, parked.sessionId));
      if (parked.ok) parks++;
    }
    return parks;
  }

  private held(agentId: string): boolean {
    return safe(() => this.options.isHeld?.(agentId) ?? false, false);
  }

  private *live(): Iterable<BoxConnection> {
    for (const connection of this.connections) if (!this.held(connection.agentId)) yield connection;
  }

  private addLease(connection: BoxConnection, sessionId: string, reserved: boolean): string {
    const id = randomUUID();
    this.leases.set(id, {
      id,
      connection,
      sessionId,
      reserved,
      expiresAt: this.now() + this.leaseMs,
    });
    return id;
  }

  private expireLeases(): void {
    const now = this.now();
    for (const [id, lease] of this.leases) {
      if (lease.expiresAt > now && !this.held(lease.connection.agentId)) continue;
      this.leases.delete(id);
      if (lease.reserved && this.waitsFor(lease.connection, lease.sessionId))
        this.steppedOver.set(stepKey(lease.connection.agentId, lease.sessionId), now);
    }
  }

  private waitsFor(connection: BoxConnection, sessionId: string): boolean {
    for (const waiter of this.waiters.values())
      if (waiter.connection.agentId === connection.agentId && waiter.sessionId === sessionId)
        return true;
    return false;
  }

  private waitingForRoomExcept(connection: BoxConnection, sessionId: string): boolean {
    for (const waiter of this.waiters.values())
      if (
        waiter.kind === 'room' &&
        !(waiter.connection.agentId === connection.agentId && waiter.sessionId === sessionId) &&
        !this.held(waiter.connection.agentId)
      )
        return true;
    return false;
  }

  private async usage(): Promise<number | null> {
    if (!this.enabled) return null;
    const usage = await this.options.readUsage().catch(() => null);
    if (usage !== null) {
      this.everRead = true;
      this.lastGood = usage;
      if (this.readFailing) {
        this.readFailing = false;
        this.log.info(
          "The box valve can read this box's memory again; new starts are let in again."
        );
      }
      return usage;
    }
    // A box that has never given a reading has no memory figure at all: it is
    // flagged once, loudly, and the valve doesn't hold starts for memory there.
    if (!this.everRead) {
      if (!this.warnedUnreadable) {
        this.warnedUnreadable = true;
        this.log.warn(
          "The box valve can't read this box's memory use, so it is NOT protecting the box: no session is parked early and none is refused for memory."
        );
      }
      return null;
    }
    // A reading failed after good ones: fail closed, once per run of failures.
    if (!this.readFailing) {
      this.readFailing = true;
      this.log.warn(
        "The box valve could not read this box's memory; new starts wait until it can."
      );
    }
    return null;
  }

  /**
   * Whether one more session fits now: under the cap (parking one idle
   * session to make room if `mayPark`) and under the refuse line counting
   * every start in flight (shedding if `mayPark`). The reason when not.
   */
  private async room(mayPark: boolean): Promise<RefuseReason | null> {
    const overCap = (freed: number) => this.awake + this.starting + 1 - freed > this.cap;
    if (overCap(0)) {
      // A park's slot already went to an earlier start, and its session is still counted: parking another idle
      // session now would free nothing this start could use before the counts catch up.
      if (this.parkStillCounted()) return 'cap';
      // Park, then admit, in one decision: a park its host has confirmed frees one slot for this start at once,
      // without waiting for the counts to catch up. They stay as they are (high): until the parked session drops out
      // of its host's report and health file, the box reads one over, which only holds further starts back.
      // If the count (awake and starting together) has already dropped by the parked session, it's free already and
      // isn't counted twice; if it has risen meanwhile (reports aren't serialised with decisions), at most the one
      // slot is freed, never more.
      const before = mayPark ? await this.parkForRoom() : null;
      const freed =
        before === null ? 0 : Math.min(1, Math.max(0, 1 - (before - (this.awake + this.starting))));
      if (overCap(freed)) return 'cap';
    }
    const fits = (usage: number) =>
      usage + (this.starting + 1) * this.reserve < this.refuseAt * this.limit;
    // No reading: refused for memory once the box has ever given one (fail
    // closed); a box that never could is let through, as flagged.
    const unknown = (): RefuseReason | null => (this.everRead ? 'memory' : null);
    const usage = await this.usage();
    if (usage === null) return unknown();
    if (fits(usage)) return null;
    if (!mayPark) return 'memory';
    await this.shed();
    const after = await this.usage();
    if (after === null) return unknown();
    return fits(after) ? null : 'memory';
  }

  /** The next to park box-wide, not yet tried: duplicates first, then the longest idle. */
  private quietest(tried: Set<string>): Sourced | undefined {
    const candidates = [...this.live()].flatMap((connection) =>
      safe(() => connection.link.idle(), [] as IdleSession[]).map((idle) => ({
        ...idle,
        connection,
      }))
    );
    return parkOrder(
      candidates.filter((c) => !tried.has(stepKey(c.connection.agentId, c.sessionId)))
    )[0];
  }

  /**
   * Parks one session, box-wide one at a time and at least `settleMs` after
   * the last, so the reading has fallen before anyone decides again.
   */
  private park(decide: () => Promise<Sourced | undefined>) {
    const run = this.parking.then(async () => {
      // Real time, whatever clock the lists run on: this is about the reading falling.
      const wait = this.lastParkAt + this.settleMs - Date.now();
      if (wait > 0) await delay(wait);
      // Decided only now, on a reading taken after the last park has settled.
      const next = await decide();
      if (!next) return null;
      const ok = await next.connection.link.park(next.sessionId).catch(() => false);
      if (ok) {
        this.lastParkAt = Date.now();
        this.parkCount = Math.min(this.parkCount + 1, MAX_PARK_COUNT);
      }
      return { ...next, ok };
    });
    this.parking = run.catch(() => undefined);
    return run;
  }

  /**
   * Parks the quietest idle session to make room under the cap. Once its host has confirmed a park, the box's awake
   * and starting count just before it (the slot is the caller's to use in the same decision); null when nothing
   * needed or could be parked.
   */
  private async parkForRoom(): Promise<number | null> {
    const tried = new Set<string>();
    for (;;) {
      let before = this.awake + this.starting;
      let agentBefore = 0;
      const parked = await this.park(async () => {
        before = this.awake + this.starting;
        const pick = before + 1 > this.cap ? this.quietest(tried) : undefined;
        if (pick) agentBefore = this.countsByAgent().get(pick.connection.agentId) ?? 0;
        return pick;
      });
      if (!parked) return null;
      tried.add(stepKey(parked.connection.agentId, parked.sessionId));
      if (!parked.ok) continue;
      this.log.info(
        `Parking session ${parked.sessionId} of agent ${parked.connection.agentId} early: the box is at its cap of ${this.cap} awake sessions.`
      );
      this.parksInCounts.push({
        agentId: parked.connection.agentId,
        at: this.now(),
        before: agentBefore,
      });
      return before;
    }
  }

  /** Whether a confirmed cap park may still be in the counts (see `parksInCounts`); forgets those that can't. */
  private parkStillCounted(): boolean {
    const now = this.now();
    for (let i = this.parksInCounts.length - 1; i >= 0; i--) {
      const { agentId, at, before } = this.parksInCounts[i]!;
      const readAt = this.healthReadAt.get(agentId) ?? Number.NEGATIVE_INFINITY;
      // Gone from the counts: the agent's count has dropped below what it was, or its health was read since.
      const dropped = (this.countsByAgent().get(agentId) ?? 0) < before;
      if (dropped || readAt >= at + PARK_SETTLE_MS || now - at >= this.leaseMs)
        this.parksInCounts.splice(i, 1);
    }
    return this.parksInCounts.length > 0;
  }

  /** One shed at a time, box-wide: concurrent callers wait for the same one. */
  private shed(): Promise<void> {
    this.shedding ??= this.shedNow().finally(() => {
      this.shedding = null;
    });
    return this.shedding;
  }

  private async shedNow(): Promise<void> {
    const tried = new Set<string>();
    let parks = 0;
    let told = false;
    let unreadable = 0;
    // Why the shed ended, for its closing line: a fixed set, never free text.
    // Null until the shed ends one of the four known ways: anything else (an error) gets its own fixed line.
    let ended: 'under' | 'none_idle' | 'limit' | 'unreadable' | null = null;
    const percent = (bytes: number) => Math.round((bytes / this.limit) * 100);
    try {
      while (parks < MAX_PARKS_PER_SHED) {
        let usage = null as number | null;
        let under = false as boolean;
        const result = await this.park(async () => {
          usage = await this.usage();
          // A failed reading parks nothing, and is never taken as "under".
          if (usage === null) return undefined;
          under = usage < this.stopAt * this.limit;
          if (under) return undefined;
          if (!told) {
            told = true;
            safe(() => this.options.onShedding?.(true), undefined);
          }
          return this.quietest(tried);
        });
        if (usage === null) {
          // Ends only if the last good reading was under the stop line;
          // otherwise read again a settle later, up to a limit.
          if (this.lastGood === null || this.lastGood < this.stopAt * this.limit) {
            ended = 'unreadable';
            return;
          }
          if (++unreadable >= SHED_UNREADABLE_SETTLES) {
            ended = 'unreadable';
            this.log.warn(
              `Memory shed stopped: no reading of this box's memory for ${unreadable} settles; new starts wait until it can be read.`
            );
            return;
          }
          await delay(this.settleMs);
          continue;
        }
        unreadable = 0;
        if (under) {
          ended = 'under';
          return;
        }
        if (!result) {
          ended = 'none_idle';
          this.log.warn(
            `The box is at ${percent(usage)}% of its memory with no idle session left to park.`
          );
          return;
        }
        tried.add(stepKey(result.connection.agentId, result.sessionId));
        if (!result.ok) continue;
        parks++;
        this.log.info(
          `Parking session ${result.sessionId} of agent ${result.connection.agentId} early: the box is at ${percent(usage)}% of its memory.`
        );
      }
      ended = 'limit';
      // The reading after the last park, for the closing line (the others already have one).
      await this.usage();
    } finally {
      if (told) safe(() => this.options.onShedding?.(false), undefined);
      // The reading after the shed and why it stopped, once per shed that began.
      if (told || ended === 'unreadable') {
        const at = this.lastGood === null ? 0 : percent(this.lastGood);
        if (ended === 'under')
          this.log.info(
            `Memory shed done: ${parks} parks, the box is at ${at}% (under the stop line).`
          );
        else if (ended === 'none_idle')
          this.log.info(
            `Memory shed done: ${parks} parks, the box is at ${at}% (no idle session left).`
          );
        else if (ended === 'limit')
          this.log.info(`Memory shed done: ${parks} parks, the box is at ${at}% (the park limit).`);
        else if (ended === 'unreadable')
          this.log.info(`Memory shed done: ${parks} parks, the box's memory can't be read.`);
        else this.log.info(`Memory shed done: ${parks} parks, stopped by an error.`);
      }
    }
  }

  private async round(): Promise<void> {
    const now = this.now();
    for (const [key, since] of this.firstSeen)
      if (now - since >= this.maxWaitMs && !this.waiters.has(key)) this.firstSeen.delete(key);
    for (const [key, waiter] of this.waiters) {
      if (now - waiter.sinceMs < this.maxWaitMs) continue;
      this.waiters.delete(key);
      safe(() => waiter.connection.link.letGo(waiter.messageId, 'timed_out'), undefined);
      this.emit('let_go', waiter.connection.agentId, waiter.sessionId, 'timed_out');
    }
    // Step-overs past their time are forgotten, so the map never grows past the waiters.
    for (const [key, at] of this.steppedOver)
      if (now - at >= (this.options.stepOverMs ?? STEP_OVER_MS)) this.steppedOver.delete(key);
    if (!this.enabled || !this.admitting()) return;
    this.expireLeases();
    const given = new Set<string>();
    const order = [...this.waiters.values()]
      .filter((waiter) => waiter.kind === 'room' && !this.held(waiter.connection.agentId))
      .sort((a, b) => a.sinceMs - b.sinceMs);
    for (const waiter of order) {
      const key = stepKey(waiter.connection.agentId, waiter.sessionId);
      if (given.has(key)) continue;
      given.add(key);
      // Taken off meanwhile, or already given room and starting.
      if (!this.waiters.has(keyOf(waiter.connection.agentId, waiter.messageId))) continue;
      if (this.leaseFor(waiter.connection, waiter.sessionId)) continue;
      const stepped = this.steppedOver.get(key);
      if (stepped !== undefined) {
        if (this.now() - stepped < (this.options.stepOverMs ?? STEP_OVER_MS)) continue;
        this.steppedOver.delete(key);
      }
      const granted = await this.exclusive(async () => {
        if (await this.room(true)) return null;
        // Still there after the wait for room, and its host still connected.
        if (!this.waiters.has(keyOf(waiter.connection.agentId, waiter.messageId))) return undefined;
        if (!waiter.connection.isOpen) return undefined;
        return this.addLease(waiter.connection, waiter.sessionId, true);
      });
      if (granted === null) break;
      if (granted === undefined) continue;
      safe(() => waiter.connection.link.start(waiter.sessionId, granted), undefined);
      this.emit('granted', waiter.connection.agentId, waiter.sessionId, null);
    }
  }

  private leaseFor(connection: BoxConnection, sessionId: string): boolean {
    for (const lease of this.leases.values())
      if (lease.connection.agentId === connection.agentId && lease.sessionId === sessionId)
        return true;
    return false;
  }
}

/**
 * One host's side of the valve, bound to its agent: every id it names is
 * read as that agent's, so it can't touch another agent's sessions, leases
 * or messages.
 */
export class BoxConnection {
  private open = true;

  constructor(
    private readonly valve: BoxValve,
    readonly link: HostLink
  ) {}

  get agentId(): string {
    return this.link.agentId;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Asks to start a session. A lease must be `settle`d once it is up or has failed. */
  admit(sessionId: string, kind: AdmitKind): Promise<AdmitAnswer> {
    if (!this.open) return Promise.resolve({ ok: false, reason: 'limit' });
    return this.valve.admitFor(this, sessionId, kind);
  }

  /** A lease let in is done with: `started` once its session is up, false if it failed or wasn't used. */
  settle(lease: string, started = true): void {
    if (this.open) this.valve.settleFor(this, lease, started);
  }

  /** A message waits for room (or for its session to start); anything but `waiting`/`already` is a let-go. */
  wait(request: WaitRequest): WaitAnswer {
    if (!this.open) return 'held';
    return this.valve.waitFor(this, request, 'live');
  }

  unwait(messageId: string): void {
    if (this.open) this.valve.unwaitFor(this, messageId);
  }

  /**
   * On every (re)connect: the host's waiting messages from its journal, each
   * placed no earlier than the valve's restart less the wait limit. Answers
   * one result per waiter, in order.
   */
  hello(waiting: WaitRequest[]): WaitAnswer[] {
    if (!this.open) return waiting.map(() => 'held');
    return waiting.map((request) => this.valve.waitFor(this, request, 'hello'));
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.valve.closed(this);
  }
}

function stepKey(agentId: string, sessionId: string): string {
  return JSON.stringify([agentId, sessionId]);
}

type Sourced = IdleSession & { connection: BoxConnection };

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

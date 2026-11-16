import { randomUUID } from 'node:crypto';
import type { AgentBridgeEvent } from '@sandboxaq/switch-agent-runtime-box';
import { errorCode, type Logger } from './log';
import type { StartFailure } from './reconcile';
import type { AgentObservation } from './runtime';
import type { AgentAssignment, Assignment } from './schemas';

/**
 * Resting agents. An agent whose sessions have all been parked for a
 * while has its agent host stopped: on a box that is most of what a parked
 * agent holds (its supervisor and worker, about 165 MiB of real memory each
 * agent on box A, 27 Oct). Its events are still held by the controller's hub,
 * and the next one it must answer starts the agent host again, through the
 * same start an assignment change would make; its sessions then wake as from
 * any park.
 *
 * Nothing here is saved: a controller that restarts starts every agent host
 * as it always has, and each rests again once quiet. An agent the memory
 * guard stopped is suspended here too (`out_of_memory`), so its next message
 * starts it the same way: one wake path for both.
 *
 * Off unless `SWITCH_CONTROLLER_REST_AFTER_MS` is set. Hosted boxes, where
 * every agent runs as the controller's own user, set it to 600000 (an idle
 * agent rests after ten minutes): that is the shipping default. Laptops and SSH
 * hosts leave it unset, and agents running as users of their own
 * (`--agent-runtime separate-user`, as on cloud machines) never rest.
 */

export const REST_AFTER_ENV = 'SWITCH_CONTROLLER_REST_AFTER_MS';

/** How long an agent host woken from a suspension is reported as waking before today's start states apply. */
export const WAKE_GRACE_MS = 60_000;

/** How long the agent's own processes are given between being asked to end and being made to. */
export const SWEEP_GRACE_MS = 5_000;

export type SuspendKind = 'resting' | 'out_of_memory';
export type WakeWhy = 'event' | 'room_control' | 'warm';

/** What a suspended or waking agent is reported as, for `mapAgentProcess` and the report. */
export type RestState =
  | { kind: 'resting'; sessions: string[] }
  | { kind: 'out_of_memory' }
  | { kind: 'waking'; sessions: string[] };

/**
 * Has Switch tell a room, as the agent, that the sweep stopped `stopped` of
 * its background processes when it went to rest: Switch's
 * own text, posted once per `key`. `unsupported` from a server without the route.
 */
export type RestNotice = (
  agentId: string,
  notice: { roomId: string; threadId: string | null; key: string; stopped: number }
) => Promise<'posted' | 'unsupported'>;

/** How many times a rest notice is tried, one try per addressed event the agent takes. */
export const REST_NOTICE_TRIES = 3;

/** What a sweep of a stopped agent's left-behind processes found. */
export type SweepResult = {
  /** Asked to end (SIGTERM). */
  signalled: number;
  /** Made to end (SIGKILL) after the grace, still the agent's. */
  killed: number;
  /** Ended, or its id passed to another process, before it was signalled. */
  gone: number;
  /** Its proof failed when checked again: left running and only counted. */
  notProven: number;
};

/**
 * The milliseconds `SWITCH_CONTROLLER_REST_AFTER_MS` names, or null (off)
 * when it is unset. A value that is set but is not a positive whole number
 * is refused rather than read as "never" or "at once", and said so.
 */
export function restAfterFromEnv(env: NodeJS.ProcessEnv, log: Pick<Logger, 'warn'>): number | null {
  const raw = env[REST_AFTER_ENV]?.trim();
  if (raw === undefined || raw === '' || raw === 'off') return null;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isSafeInteger(value) && value >= 60_000) return value;
  log.warn(
    `${REST_AFTER_ENV} is set to "${raw}", which is not a whole number of milliseconds of at least 60000; agents do not rest.`
  );
  return null;
}

/**
 * Whether the agent is quiet enough to rest, from its agent host's own
 * report: running and connected, every session parked (or none at all), and
 * none busy (a turn, an open approval, a reset decision on hold, or room
 * messages waiting for room all count as busy in the agent host). A host too
 * old to report its sessions and what is busy never rests.
 */
export function quietHost(entry: AgentAssignment, observation: AgentObservation): boolean {
  if (entry.desired_state !== 'running') return false;
  const health = observation.alive && observation.health?.current ? observation.health : null;
  if (!health || health.state !== 'connected') return false;
  if (!health.busy || !health.sessions) return false;
  if (health.busy.length > 0) return false;
  return Object.values(health.sessions).every((state) => state === 'parked');
}

/** The hub as resting uses it. */
export type RestHub = {
  setSuspended(agentId: string, suspended: boolean, options?: { drop?: boolean }): void;
  /** Fences the hub at once; false when the event being handed over did not finish in time. */
  hold(agentId: string): Promise<boolean>;
  release(agentId: string): void;
  waiting(agentId: string): boolean;
  lastAddressedAt(agentId: string): number | null;
};

export type AgentRestDeps = {
  hub: RestHub;
  observe: (agentId: string) => Promise<AgentObservation>;
  /** Turns the agent host off and waits for it and its sessions to be gone. */
  stopHost: (agentId: string) => Promise<void>;
  /** Ends what the agent left running, with proof it is the agent's (the ownership marker). */
  sweep: (agentId: string) => Promise<SweepResult>;
  /** Starts the agent host at the agent's current assignment; a failure is recorded on the agent. */
  start: (agentId: string) => Promise<StartFailure | null>;
  /** The controller's serial queue: nothing here races a reconcile. */
  run: <T>(task: () => Promise<T>) => Promise<T>;
  /** Null: agents do not rest (a guard stop still wakes on the next message). */
  restAfterMs: number | null;
  now: () => number;
  log: Logger;
  /** Something `state` reads changed. */
  onChange: () => void;
  /** Posts the line telling the room what the sweep stopped; absent, none is posted. */
  restNotice?: RestNotice;
  /**
   * A suspended agent's start is about to run: called once the queued start
   * has passed its called-off check, never for a wake called off, with what
   * it was suspended as. The memory guard releases its saved hold here.
   */
  onWake?: (agentId: string, was: SuspendKind) => void;
};

type Suspension = {
  kind: SuspendKind;
  /**
   * `stopping` while its agent host is being stopped (a wake then waits for
   * the stop), `stopped` until something needs it, and `waking` while the
   * start for that is queued or under way. It stays suspended through
   * `waking`, so nothing else (a reconcile, a second wake) starts it too.
   */
  phase: 'stopping' | 'stopped' | 'waking';
  wakeAfterStop: boolean;
  /** Its sessions when it went to rest, reported unchanged so nothing reads it as a change. */
  sessions: string[];
  /** When its wake began, for how long it is reported as waking. */
  wakeAt: number | null;
  /** Background processes the sweep stopped when it went to rest, for the room to be told. */
  swept: number;
};

/** A rest notice owed to the room of the agent's next addressed event. */
type OwedNotice = { key: string; stopped: number; tries: number };

export class AgentRest {
  private readonly quietSince = new Map<string, number>();
  private readonly suspensions = new Map<string, Suspension>();
  /** Started from a suspension, until its agent host is back or `WAKE_GRACE_MS` passes. */
  private readonly waking = new Map<string, { since: number; sessions: string[] }>();
  /** Agents with a rest queued or under way, so the poll does not queue another. */
  private readonly queued = new Set<string>();
  /** Held in memory only: a controller restart loses it, and says so in no room. */
  private readonly owedNotices = new Map<string, OwedNotice>();

  constructor(private readonly deps: AgentRestDeps) {}

  /** What the agent is reported as while suspended or waking; null otherwise. */
  state(agentId: string, nowMs: number = this.deps.now()): RestState | null {
    const suspension = this.suspensions.get(agentId);
    if (suspension?.phase === 'waking') return { kind: 'waking', sessions: suspension.sessions };
    if (suspension)
      return suspension.kind === 'out_of_memory'
        ? { kind: 'out_of_memory' }
        : { kind: 'resting', sessions: suspension.sessions };
    const waking = this.waking.get(agentId);
    if (waking && nowMs - waking.since < WAKE_GRACE_MS)
      return { kind: 'waking', sessions: waking.sessions };
    return null;
  }

  /** Its agent host is stopped on purpose, or being started from that; reconcile leaves it alone. */
  suspended(agentId: string): boolean {
    return this.suspensions.has(agentId);
  }

  /**
   * Looks at every agent: one woken whose agent host is back is no longer
   * waking, and one quiet for `restAfterMs` is put to rest. Called on the
   * controller's status poll.
   */
  async check(assignment: Assignment | null): Promise<void> {
    const nowMs = this.deps.now();
    const assigned = new Set<string>();
    for (const entry of assignment?.agents ?? []) {
      const agentId = entry.agent_id;
      assigned.add(agentId);
      if (this.suspensions.has(agentId)) continue;
      const observation = await this.deps.observe(agentId);
      const waking = this.waking.get(agentId);
      if (waking) {
        const back = observation.alive && observation.health?.current;
        if (back || nowMs - waking.since >= WAKE_GRACE_MS) {
          this.waking.delete(agentId);
          this.deps.onChange();
        }
        this.quietSince.delete(agentId);
        continue;
      }
      if (this.deps.restAfterMs === null) continue;
      if (!quietHost(entry, observation) || this.deps.hub.waiting(agentId)) {
        this.quietSince.delete(agentId);
        continue;
      }
      // A detached agent host's report can lag an event it has just been
      // handed, so the quiet time also runs from the last one it took.
      const lastAddressed = this.deps.hub.lastAddressedAt(agentId) ?? 0;
      const since = Math.max(this.quietSince.get(agentId) ?? nowMs, lastAddressed);
      this.quietSince.set(agentId, since);
      if (nowMs - since >= this.deps.restAfterMs && !this.queued.has(agentId))
        void this.rest(entry);
    }
    for (const agentId of [...this.quietSince.keys()])
      if (!assigned.has(agentId)) this.quietSince.delete(agentId);
    for (const agentId of [...this.waking.keys()])
      if (!assigned.has(agentId)) this.waking.delete(agentId);
  }

  /**
   * Puts the agent to rest: the hub stops handing its agent host anything,
   * it is checked again behind that, its agent host is stopped gracefully
   * (its owner records released, so its next start meets none), and what it
   * left running is ended with proof it is the agent's. If anything on the
   * way fails it is not resting, the hub hands its host events again, and
   * its real state shows. An event that arrived on the way wakes it once the
   * stop is done.
   */
  rest(entry: AgentAssignment): Promise<void> {
    const agentId = entry.agent_id;
    this.queued.add(agentId);
    return this.deps.run(async () => {
      try {
        await this.restNow(entry);
      } finally {
        this.queued.delete(agentId);
      }
    });
  }

  private async restNow(entry: AgentAssignment): Promise<void> {
    const agentId = entry.agent_id;
    if (this.suspensions.has(agentId) || this.waking.has(agentId)) return;
    let suspension: Suspension | null = null;
    try {
      if (!(await this.deps.hub.hold(agentId))) {
        this.deps.log.warn(
          'Not resting an agent: its host is still taking an event after the time allowed',
          { agentId }
        );
        this.abandonRest(agentId, null);
        return;
      }
      const observation = await this.deps.observe(agentId);
      const lastAddressed = this.deps.hub.lastAddressedAt(agentId);
      const tookOneLately =
        lastAddressed !== null &&
        this.deps.now() - lastAddressed < (this.deps.restAfterMs ?? Number.POSITIVE_INFINITY);
      if (!quietHost(entry, observation) || this.deps.hub.waiting(agentId) || tookOneLately) {
        this.abandonRest(agentId, null);
        return;
      }
      const sessions = Object.keys(observation.health?.placements ?? {}).sort();
      suspension = {
        kind: 'resting',
        phase: 'stopping',
        wakeAfterStop: false,
        sessions,
        wakeAt: null,
        swept: 0,
      };
      this.suspensions.set(agentId, suspension);
      this.deps.hub.setSuspended(agentId, true);
      this.quietSince.delete(agentId);
      this.deps.onChange();
      this.deps.log.info('Agent is resting: stopping its agent host until its next message', {
        agentId,
        sessions: sessions.length,
      });
      await this.deps.stopHost(agentId);
    } catch (error) {
      this.deps.log.error('Could not put an agent to rest; it is not resting', {
        agentId,
        error: errorCode(error),
      });
      this.abandonRest(agentId, suspension);
      return;
    }
    suspension.swept = await this.sweep(agentId);
    this.finishStop(agentId, suspension);
  }

  /** Lifts the fence and any suspension a rest set up, after it gave up or failed. */
  private abandonRest(agentId: string, suspension: Suspension | null): void {
    if (suspension && this.suspensions.get(agentId) === suspension) {
      this.suspensions.delete(agentId);
      this.deps.hub.setSuspended(agentId, false);
      this.deps.onChange();
    }
    this.quietSince.delete(agentId);
    this.deps.hub.release(agentId);
  }

  /** The stop is done: lifts the fence, and starts the agent at once if something already waits for it. */
  private finishStop(agentId: string, suspension: Suspension): void {
    if (this.suspensions.get(agentId) !== suspension || suspension.phase !== 'stopping') return;
    suspension.phase = 'stopped';
    this.deps.hub.release(agentId);
    if (suspension.wakeAfterStop || this.deps.hub.waiting(agentId))
      this.startWake(agentId, 'event');
  }

  /**
   * The memory guard is stopping the agent's agent host. From now its events
   * are held and reconcile leaves it alone; resolves once the hub has
   * stopped handing the host events (the one being handed over finishes
   * first, within `HOLD_TIMEOUT_MS`), so nothing is confirmed to a host that
   * is about to die. Call `stopped` once the stop is done (its next message,
   * or one that came in meanwhile, then starts it again, as for a resting
   * agent), or `clear` if the stop failed. A wake queued for it is called
   * off. The guard reports its own state until the wake.
   */
  async suspend(agentId: string, kind: SuspendKind): Promise<void> {
    const existing = this.suspensions.get(agentId);
    if (existing && existing.phase !== 'waking') return;
    this.waking.delete(agentId);
    this.quietSince.delete(agentId);
    const suspension: Suspension = {
      kind,
      phase: 'stopping',
      wakeAfterStop: false,
      sessions: existing?.sessions ?? [],
      wakeAt: null,
      swept: existing?.swept ?? 0,
    };
    // Replacing a waking suspension calls its queued start off (`startWake` checks).
    this.suspensions.set(agentId, suspension);
    this.deps.hub.setSuspended(agentId, true);
    this.deps.onChange();
    if (!(await this.deps.hub.hold(agentId)))
      this.deps.log.warn(
        'The memory guard is stopping an agent whose host is still taking an event; it is handed again on the next start',
        { agentId }
      );
  }

  /** The stop `suspend` announced is done: wakes the agent at once if something already waits for it. */
  stopped(agentId: string): void {
    const suspension = this.suspensions.get(agentId);
    if (suspension) this.finishStop(agentId, suspension);
  }

  /** Something the agent must answer arrived: starts its agent host if it is suspended. */
  wake(agentId: string, why: WakeWhy): void {
    const suspension = this.suspensions.get(agentId);
    if (!suspension) return;
    if (suspension.phase === 'stopping') {
      suspension.wakeAfterStop = true;
      return;
    }
    this.startWake(agentId, why);
  }

  /**
   * Forgets the agent's suspension without starting it: its owner stopped it,
   * it was removed, something else is starting it now (a new revision, a
   * restart its owner asked for), or the guard's stop failed. The room
   * controls held for it go too, so none runs on a start long after.
   */
  clear(agentId: string): void {
    const hadSuspension = this.suspensions.delete(agentId);
    const hadWaking = this.waking.delete(agentId);
    this.owedNotices.delete(agentId);
    this.quietSince.delete(agentId);
    this.deps.hub.setSuspended(agentId, false, { drop: true });
    this.deps.hub.release(agentId);
    if (hadSuspension || hadWaking) this.deps.onChange();
  }

  /**
   * Starts a suspended agent's host. It stays suspended until the start
   * finishes, so a reconcile queued meanwhile does not start it a second
   * time; the start is skipped if the suspension changed while it waited in
   * the queue (cleared, or the guard stopping it).
   */
  private startWake(agentId: string, why: WakeWhy): void {
    const suspension = this.suspensions.get(agentId);
    if (!suspension || suspension.phase !== 'stopped') return;
    suspension.phase = 'waking';
    suspension.wakeAt = this.deps.now();
    this.deps.onChange();
    this.deps.log.info('Starting a suspended agent’s host for what it must answer', {
      agentId,
      why,
      was: suspension.kind,
    });
    void this.deps
      .run(async () => {
        if (this.suspensions.get(agentId) !== suspension) return 'called_off' as const;
        try {
          this.deps.onWake?.(agentId, suspension.kind);
        } catch (error) {
          this.deps.log.error('A wake listener failed', { agentId, error: errorCode(error) });
        }
        // The hub hands the new host what it holds, from where it got to,
        // and the room controls it keeps.
        this.deps.hub.setSuspended(agentId, false);
        try {
          return await this.deps.start(agentId);
        } finally {
          if (this.suspensions.get(agentId) === suspension) this.suspensions.delete(agentId);
        }
      })
      .then(
        (outcome) => {
          if (outcome === 'called_off') {
            this.deps.log.info('A suspended agent’s start was called off before it ran', {
              agentId,
            });
            return;
          }
          // A failure is recorded on the agent by the start: today's failed
          // state shows, and the room controls kept for it are dropped (and
          // the room told) rather than run on some later start.
          if (outcome === null) {
            this.waking.set(agentId, {
              since: suspension.wakeAt ?? this.deps.now(),
              sessions: suspension.sessions,
            });
            if (suspension.swept > 0) {
              const earlier = this.owedNotices.get(agentId);
              this.owedNotices.set(agentId, {
                key: earlier?.key ?? randomUUID(),
                stopped: (earlier?.stopped ?? 0) + suspension.swept,
                tries: 0,
              });
            }
          } else this.deps.hub.setSuspended(agentId, false, { drop: true });
          this.deps.onChange();
        },
        (error: unknown) => {
          this.deps.hub.setSuspended(agentId, false, { drop: true });
          this.deps.onChange();
          this.deps.log.error('Could not start a suspended agent’s host', {
            agentId,
            error: errorCode(error),
          });
        }
      );
  }

  /** Ends what the agent left running; resolves how many of its processes it stopped. */
  private async sweep(agentId: string): Promise<number> {
    try {
      const found = await this.deps.sweep(agentId);
      if (found.signalled || found.notProven)
        this.deps.log.warn('A resting agent left processes running after its host stopped', {
          agentId,
          asked: found.signalled,
          forced: found.killed,
          notProvenLeftRunning: found.notProven,
        });
      return found.signalled;
    } catch (error) {
      this.deps.log.error('Could not sweep a resting agent’s left-behind processes', {
        agentId,
        error: errorCode(error),
      });
      return 0;
    }
  }

  /**
   * The agent's agent host took an addressed event: if the sweep stopped
   * background processes when it last went to rest, the room that event
   * came from is told, once, before the agent's reply.
   * Posted by the controller, with a key, so it shows however the agent's
   * own reply goes; tried again on its next events if Switch could not take it.
   */
  addressedTaken(agentId: string, event: AgentBridgeEvent): void {
    const owed = this.owedNotices.get(agentId);
    const post = this.deps.restNotice;
    if (!owed || !post) return;
    const room = (event as { room_id?: unknown }).room_id;
    if (event.type !== 'message' || typeof room !== 'string' || !room) return;
    const payload = (event as { payload?: { thread_id?: unknown } }).payload;
    const threadId =
      typeof payload?.thread_id === 'string' && payload.thread_id ? payload.thread_id : null;
    this.owedNotices.delete(agentId);
    void post(agentId, { roomId: room, threadId, key: owed.key, stopped: owed.stopped }).then(
      (answer) => {
        if (answer === 'unsupported')
          this.deps.log.warn(
            'Switch has no route for the line about background processes stopped at rest; not posted',
            { agentId, stopped: owed.stopped }
          );
        else
          this.deps.log.info('Told the room about background processes stopped at rest', {
            agentId,
            stopped: owed.stopped,
          });
      },
      (error: unknown) => {
        const tries = owed.tries + 1;
        const later = this.owedNotices.get(agentId);
        if (tries < REST_NOTICE_TRIES && !later) this.owedNotices.set(agentId, { ...owed, tries });
        this.deps.log.warn('Could not tell the room about background processes stopped at rest', {
          agentId,
          tries,
          error: errorCode(error),
        });
      }
    );
  }
}

import { setTimeout as delay } from 'node:timers/promises';
import type { AgentBridgeEvent, SwitchEventStreamDeps } from '@sandboxaq/switch-agent-runtime-box';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentHub } from './agent-hub';
import { silentLogger } from './log';
import {
  AgentRest,
  type AgentRestDeps,
  quietHost,
  REST_AFTER_ENV,
  restAfterFromEnv,
  type RestHub,
  WAKE_GRACE_MS,
} from './rest';
import { type AgentObservation, emptyObservation } from './runtime';
import type { AgentAssignment, AgentEventFrame, Assignment } from './schemas';

const AGENT = 'agent-1';
const ROOM = 'room-a';
const SESSION = 'session-1';
const MINUTE = 60_000;
const REST_AFTER = 10 * MINUTE;

function entry(overrides: Partial<AgentAssignment> = {}): AgentAssignment {
  return {
    agent_id: AGENT,
    revision: 1,
    desired_state: 'running',
    definition: {
      name: 'user-b-pm',
      provider: 'claude',
      model: null,
      instructions: null,
      directory: null,
      isolation: 'isolated',
      auto_approve: false,
    },
    ...overrides,
  } as AgentAssignment;
}

function assignment(...entries: AgentAssignment[]): Assignment {
  return { revision: 1, agents: entries.length ? entries : [entry()] } as Assignment;
}

/**
 * What a test box's `health.json` read at each step of a real park (over
 * 20 minutes, with a stand-in AI): attached and connected,
 * the session woken by a ping and answering, then parked about 14–15 min
 * after the reply, with nothing busy. The session's own records went
 * `running` → `parked` → `quiesced`; health shows the first two as
 * `active` and `parked`.
 */
const B_SEQUENCE = {
  waking: { sessions: { [SESSION]: 'waking' }, busy: [SESSION] },
  answering: { sessions: { [SESSION]: 'active' }, busy: [SESSION] },
  idleAwake: { sessions: { [SESSION]: 'active' }, busy: [] },
  parked: { sessions: { [SESSION]: 'parked' }, busy: [] },
} as const;

function observed(
  step: { sessions: Record<string, string>; busy: readonly string[] } | null,
  overrides: Partial<NonNullable<AgentObservation['health']>> = {}
): AgentObservation {
  if (step === null) return emptyObservation();
  return {
    ...emptyObservation(),
    alive: true,
    health: {
      state: 'connected',
      detail: null,
      since: '2026-10-27T12:12:32.800Z',
      placements: { [SESSION]: ROOM },
      busy: [...step.busy],
      sessions: { ...step.sessions } as NonNullable<AgentObservation['health']>['sessions'],
      pid: 4242,
      updatedAt: '2026-10-27T12:31:54.000Z',
      current: true,
      ...overrides,
    },
  };
}

class FakeHub implements RestHub {
  suspendedNow = false;
  holding = false;
  holds = 0;
  releases = 0;
  drops = 0;
  isWaiting = false;
  holdSucceeds = true;
  addressedAt: number | null = null;
  setSuspended(_agentId: string, suspended: boolean, options: { drop?: boolean } = {}): void {
    this.suspendedNow = suspended;
    if (options.drop) this.drops++;
  }
  async hold(): Promise<boolean> {
    this.holding = true;
    this.holds++;
    return this.holdSucceeds;
  }
  release(): void {
    this.holding = false;
    this.releases++;
  }
  waiting(): boolean {
    return this.isWaiting;
  }
  lastAddressedAt(): number | null {
    return this.addressedAt;
  }
}

/** Runs one task at a time, in order, as the controller's queue does. */
function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  };
}

let clock: number;
let hub: FakeHub;
let observation: AgentObservation;
let stops: number;
let starts: number;
let sweeps: number;
let stopHost: () => Promise<void>;
let start: () => Promise<{ reason: 'internal'; detail: string } | null>;
let sweep: AgentRestDeps['sweep'];
let rest: AgentRest;

function build(overrides: Partial<AgentRestDeps> = {}): AgentRest {
  return new AgentRest({
    hub,
    observe: async () => observation,
    stopHost: () => stopHost(),
    sweep: (agentId) => sweep(agentId),
    start: () => start(),
    run: serial(),
    restAfterMs: REST_AFTER,
    now: () => clock,
    log: silentLogger,
    onChange: () => {},
    ...overrides,
  });
}

beforeEach(() => {
  clock = Date.parse('2026-10-27T12:17:00Z');
  hub = new FakeHub();
  observation = observed(B_SEQUENCE.parked);
  stops = 0;
  starts = 0;
  sweeps = 0;
  stopHost = async () => {
    stops++;
    observation = emptyObservation();
  };
  start = async () => {
    starts++;
    return null;
  };
  sweep = async () => {
    sweeps++;
    return { signalled: 0, killed: 0, gone: 0, notProven: 0 };
  };
  rest = build();
});

/** Lets queued work run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await delay(1);
}

async function pollFor(ms: number, every = 5_000): Promise<void> {
  for (let passed = 0; passed <= ms; passed += every) {
    await rest.check(assignment());
    await settle();
    clock += every;
  }
}

describe('quietHost', () => {
  it('is quiet only with every session parked and nothing busy, connected, and wanted running', () => {
    expect(quietHost(entry(), observed(B_SEQUENCE.parked))).toBe(true);
    expect(quietHost(entry(), observed(B_SEQUENCE.waking))).toBe(false);
    expect(quietHost(entry(), observed(B_SEQUENCE.answering))).toBe(false);
    expect(quietHost(entry(), observed(B_SEQUENCE.idleAwake))).toBe(false);
    expect(quietHost(entry({ desired_state: 'stopped' }), observed(B_SEQUENCE.parked))).toBe(false);
    expect(quietHost(entry(), observed(B_SEQUENCE.parked, { state: 'disconnected' }))).toBe(false);
    expect(quietHost(entry(), observed(B_SEQUENCE.parked, { current: false }))).toBe(false);
    expect(quietHost(entry(), emptyObservation())).toBe(false);
  });

  it('counts a session parked with an open approval or held room messages as busy, so not quiet', () => {
    // The agent host lists such a session in `busy` (`sessionBusy`).
    expect(
      quietHost(entry(), observed({ sessions: { [SESSION]: 'parked' }, busy: [SESSION] }))
    ).toBe(false);
  });

  it('is quiet with no sessions at all', () => {
    expect(quietHost(entry(), observed({ sessions: {}, busy: [] }, { placements: {} }))).toBe(true);
  });

  it('never rests an agent host too old to say what is busy or where its sessions stand', () => {
    const old = observed(B_SEQUENCE.parked);
    delete old.health!.busy;
    expect(quietHost(entry(), old)).toBe(false);
    const older = observed(B_SEQUENCE.parked);
    delete older.health!.sessions;
    expect(quietHost(entry(), older)).toBe(false);
  });
});

describe('the rest timer', () => {
  it('rests an agent once quiet for the rest time, not before, and stops its host once', async () => {
    await pollFor(REST_AFTER - 5_000);
    expect(stops).toBe(0);
    await pollFor(10_000);
    expect(stops).toBe(1);
    expect(rest.state(AGENT)).toEqual({ kind: 'resting', sessions: [SESSION] });
    expect(hub.suspendedNow).toBe(true);
    expect(sweeps).toBe(1);
    await pollFor(MINUTE);
    expect(stops).toBe(1);
  });

  it('starts the quiet time again when a session wakes, as in the real park sequence', async () => {
    await pollFor(8 * MINUTE);
    observation = observed(B_SEQUENCE.waking);
    await pollFor(5_000);
    observation = observed(B_SEQUENCE.answering);
    await pollFor(5_000);
    observation = observed(B_SEQUENCE.idleAwake);
    await pollFor(14 * MINUTE);
    observation = observed(B_SEQUENCE.parked);
    await pollFor(REST_AFTER - 10_000);
    expect(stops).toBe(0);
    await pollFor(15_000);
    expect(stops).toBe(1);
  });

  it('does not rest an agent with something held for it', async () => {
    hub.isWaiting = true;
    await pollFor(REST_AFTER + MINUTE);
    expect(stops).toBe(0);
  });

  it('runs the quiet time from the last addressed event its host took, which its report can lag', async () => {
    await pollFor(9 * MINUTE);
    hub.addressedAt = clock;
    await pollFor(5 * MINUTE);
    expect(stops).toBe(0);
    await pollFor(6 * MINUTE);
    expect(stops).toBe(1);
  });

  it('never rests an agent when resting is off', async () => {
    rest = build({ restAfterMs: null });
    await pollFor(REST_AFTER * 3);
    expect(stops).toBe(0);
  });

  it('is not fooled by an agent its owner stopped', async () => {
    for (let passed = 0; passed <= REST_AFTER * 2; passed += 5_000) {
      await rest.check(assignment(entry({ desired_state: 'stopped' })));
      clock += 5_000;
    }
    await settle();
    expect(stops).toBe(0);
  });
});

describe('going to rest', () => {
  it('holds the hub, checks again behind it, and gives up without stopping when the agent woke meanwhile', async () => {
    const pending = rest.rest(entry());
    observation = observed(B_SEQUENCE.waking);
    await pending;
    expect(hub.holds).toBe(1);
    expect(hub.releases).toBe(1);
    expect(stops).toBe(0);
    expect(hub.suspendedNow).toBe(false);
    expect(rest.state(AGENT)).toBeNull();
  });

  it('gives up when an addressed event was taken within the rest time', async () => {
    hub.addressedAt = clock - MINUTE;
    await rest.rest(entry());
    expect(stops).toBe(0);
    expect(hub.releases).toBe(1);
  });

  it('is not resting when its host will not stop, and the hub hands it events again', async () => {
    stopHost = async () => {
      stops++;
      throw new Error(
        'The agent host for agent agent-1 has not stopped 30 s after being turned off.'
      );
    };
    await rest.rest(entry());
    expect(stops).toBe(1);
    expect(rest.state(AGENT)).toBeNull();
    expect(hub.suspendedNow).toBe(false);
    expect(hub.holding).toBe(false);
    expect(sweeps).toBe(0);
  });

  it('wakes once its host has stopped when a message arrived while it was stopping', async () => {
    let finishStop: () => void = () => {};
    stopHost = () =>
      new Promise<void>((resolve) => {
        stops++;
        finishStop = () => {
          observation = emptyObservation();
          resolve();
        };
      });
    const resting = rest.rest(entry());
    await settle();
    expect(rest.state(AGENT)?.kind).toBe('resting');
    rest.wake(AGENT, 'event');
    await settle();
    expect(starts).toBe(0);
    finishStop();
    await resting;
    await settle();
    expect(starts).toBe(1);
    expect(rest.state(AGENT)?.kind).toBe('waking');
  });

  it('wakes once its host has stopped when the hub holds an event that came in on the way', async () => {
    stopHost = async () => {
      stops++;
      hub.isWaiting = true;
    };
    await rest.rest(entry());
    await settle();
    expect(starts).toBe(1);
  });

  it('lifts the fence and is not resting when looking at the agent again throws', async () => {
    let looks = 0;
    rest = build({
      observe: async () => {
        looks++;
        throw new Error('health.json is not valid JSON');
      },
    });
    await rest.rest(entry());
    expect(looks).toBe(1);
    expect(hub.holding).toBe(false);
    expect(stops).toBe(0);
    expect(rest.state(AGENT)).toBeNull();
  });

  it('gives up the rest, and lifts the fence, when its host takes too long over an event', async () => {
    hub.holdSucceeds = false;
    await rest.rest(entry());
    expect(hub.holding).toBe(false);
    expect(stops).toBe(0);
    expect(rest.state(AGENT)).toBeNull();
  });

  it('still rests when the sweep fails, and says so', async () => {
    sweep = async () => {
      throw new Error('/proc is not readable');
    };
    await rest.rest(entry());
    expect(rest.state(AGENT)?.kind).toBe('resting');
  });

  it('sweeps after the host has stopped, never before', async () => {
    const order: string[] = [];
    stopHost = async () => void order.push('stop');
    sweep = async () => {
      order.push('sweep');
      return { signalled: 1, killed: 0, gone: 0, notProven: 1 };
    };
    await rest.rest(entry());
    expect(order).toEqual(['stop', 'sweep']);
  });
});

describe('waking', () => {
  beforeEach(async () => {
    await rest.rest(entry());
    expect(rest.state(AGENT)?.kind).toBe('resting');
  });

  it('starts the host once for a burst of messages, reports it waking, then not once it is back', async () => {
    rest.wake(AGENT, 'event');
    rest.wake(AGENT, 'event');
    rest.wake(AGENT, 'room_control');
    await settle();
    expect(starts).toBe(1);
    expect(hub.suspendedNow).toBe(false);
    expect(rest.state(AGENT)).toEqual({ kind: 'waking', sessions: [SESSION] });
    observation = observed(B_SEQUENCE.waking);
    await rest.check(assignment());
    expect(rest.state(AGENT)).toBeNull();
  });

  it('stops reporting it waking after the grace, so a host that never comes back shows as today', async () => {
    rest.wake(AGENT, 'event');
    await settle();
    clock += WAKE_GRACE_MS;
    expect(rest.state(AGENT)).toBeNull();
  });

  it('stops reporting it waking when the start fails, so the recorded failure shows', async () => {
    start = async () => {
      starts++;
      return { reason: 'internal', detail: 'The shared host launcher failed (exit 1)' };
    };
    rest.wake(AGENT, 'event');
    await settle();
    expect(starts).toBe(1);
    expect(rest.state(AGENT)).toBeNull();
    // What the hub kept for it is dropped, and the room told, not run on a later start.
    expect(hub.drops).toBe(1);
  });

  it('stays suspended until its start has finished, so nothing else starts it meanwhile', async () => {
    let finish: (value: null) => void = () => {};
    start = () =>
      new Promise((resolve) => {
        starts++;
        finish = resolve;
      });
    rest.wake(AGENT, 'event');
    await settle();
    expect(starts).toBe(1);
    // A reconcile queued now sees it suspended, so does not start it again.
    expect(rest.suspended(AGENT)).toBe(true);
    expect(rest.state(AGENT)?.kind).toBe('waking');
    rest.wake(AGENT, 'event');
    await settle();
    expect(starts).toBe(1);
    finish(null);
    await settle();
    expect(rest.suspended(AGENT)).toBe(false);
    expect(rest.state(AGENT)?.kind).toBe('waking');
  });

  it('tells its wake listener once the start runs, with what it was suspended as', async () => {
    const woken: string[] = [];
    rest = build({ onWake: (agentId, was) => void woken.push(`${agentId}:${was}`) });
    await rest.suspend(AGENT, 'out_of_memory');
    rest.stopped(AGENT);
    rest.wake(AGENT, 'event');
    await settle();
    expect(woken).toEqual([`${AGENT}:out_of_memory`]);
  });

  it('does not tell its wake listener of a wake that was called off', async () => {
    const woken: string[] = [];
    let unblock: () => void = () => {};
    const blocked = new Promise<void>((resolve) => (unblock = resolve));
    const run = serial();
    rest = build({ run, onWake: (agentId, was) => void woken.push(`${agentId}:${was}`) });
    await rest.rest(entry());
    void run(() => blocked);
    rest.wake(AGENT, 'event');
    await settle();
    rest.clear(AGENT);
    unblock();
    await settle();
    expect(woken).toEqual([]);
    expect(starts).toBe(0);
  });

  it('calls off a queued wake when the memory guard stops the agent first', async () => {
    let unblock: () => void = () => {};
    const blocked = new Promise<void>((resolve) => (unblock = resolve));
    const run = serial();
    rest = build({ run });
    await rest.rest(entry());
    // Something long holds the queue, as a reconcile might.
    void run(() => blocked);
    rest.wake(AGENT, 'event');
    await settle();
    await rest.suspend(AGENT, 'out_of_memory');
    unblock();
    await settle();
    expect(starts).toBe(0);
    expect(rest.state(AGENT)).toEqual({ kind: 'out_of_memory' });
    expect(rest.suspended(AGENT)).toBe(true);
  });

  it('forgets both its suspension and its waking when cleared, and drops what the hub kept for it', async () => {
    rest.wake(AGENT, 'event');
    await settle();
    expect(rest.state(AGENT)?.kind).toBe('waking');
    rest.clear(AGENT);
    expect(rest.state(AGENT)).toBeNull();
    expect(hub.drops).toBe(1);
  });

  it('does nothing for an agent that is not suspended', async () => {
    rest.clear(AGENT);
    rest.wake(AGENT, 'event');
    await settle();
    expect(starts).toBe(0);
    expect(rest.state(AGENT)).toBeNull();
  });

  it('rests again once quiet after a wake that started only its host', async () => {
    rest.wake(AGENT, 'warm');
    await settle();
    observation = observed(B_SEQUENCE.parked);
    stops = 0;
    await pollFor(REST_AFTER + 10_000);
    expect(starts).toBe(1);
    expect(stops).toBe(1);
  });
});

describe('the memory guard’s stop', () => {
  it('holds the agent through the stop, then starts it on its next message through the same wake', async () => {
    await rest.suspend(AGENT, 'out_of_memory');
    expect(rest.state(AGENT)).toEqual({ kind: 'out_of_memory' });
    expect(hub.suspendedNow).toBe(true);
    rest.wake(AGENT, 'event');
    await settle();
    // Not while the guard is still ending its tree.
    expect(starts).toBe(0);
    rest.stopped(AGENT);
    await settle();
    expect(starts).toBe(1);
  });

  it('starts it as soon as the stop is done when a message came in meanwhile', async () => {
    await rest.suspend(AGENT, 'out_of_memory');
    hub.isWaiting = true;
    rest.stopped(AGENT);
    await settle();
    expect(starts).toBe(1);
  });

  it('waits for its next message when nothing came in during the stop', async () => {
    await rest.suspend(AGENT, 'out_of_memory');
    rest.stopped(AGENT);
    await settle();
    expect(starts).toBe(0);
    rest.wake(AGENT, 'event');
    await settle();
    expect(starts).toBe(1);
  });

  it('fences the hub while the guard stops the agent, and lifts it when the stop is done', async () => {
    await rest.suspend(AGENT, 'out_of_memory');
    expect(hub.holding).toBe(true);
    rest.stopped(AGENT);
    expect(hub.holding).toBe(false);
  });

  it('is cleared when the guard’s stop failed, and starts nothing', async () => {
    await rest.suspend(AGENT, 'out_of_memory');
    rest.clear(AGENT);
    expect(hub.suspendedNow).toBe(false);
    expect(hub.holding).toBe(false);
    rest.wake(AGENT, 'event');
    await settle();
    expect(starts).toBe(0);
  });
});

describe('telling the room what the sweep stopped (criterion m)', () => {
  const event = (seq: number, threadId: string | null = null) =>
    ({
      type: 'message',
      room_id: ROOM,
      sequence: seq,
      payload: {
        addressed: true,
        message_id: `$m${seq}`,
        ...(threadId ? { thread_id: threadId } : {}),
      },
    }) as unknown as AgentBridgeEvent;
  let notices: {
    agentId: string;
    roomId: string;
    threadId: string | null;
    key: string;
    stopped: number;
  }[];
  let answer: () => Promise<'posted' | 'unsupported'>;

  beforeEach(() => {
    notices = [];
    answer = async () => 'posted';
    sweep = async () => ({ signalled: 2, killed: 1, gone: 0, notProven: 0 });
    rest = build({
      restNotice: async (agentId, notice) => {
        notices.push({ agentId, ...notice });
        return answer();
      },
    });
  });

  it('posts it once, in the room and thread of the first message after the wake, with the count only', async () => {
    await rest.rest(entry());
    // Not at rest time: that would read as if it woke up.
    expect(notices).toEqual([]);
    rest.wake(AGENT, 'event');
    await settle();
    rest.addressedTaken(AGENT, event(7, '$thread'));
    rest.addressedTaken(AGENT, event(8));
    await settle();
    expect(notices).toEqual([
      { agentId: AGENT, roomId: ROOM, threadId: '$thread', key: expect.any(String), stopped: 2 },
    ]);
  });

  it('posts nothing when the sweep stopped nothing', async () => {
    sweep = async () => ({ signalled: 0, killed: 0, gone: 1, notProven: 1 });
    await rest.rest(entry());
    rest.wake(AGENT, 'event');
    await settle();
    rest.addressedTaken(AGENT, event(7));
    await settle();
    expect(notices).toEqual([]);
  });

  it('tries again, with the same key, on the next message when Switch could not take it, at most three times', async () => {
    answer = async () => {
      throw new Error('fetch failed');
    };
    await rest.rest(entry());
    rest.wake(AGENT, 'event');
    await settle();
    for (const seq of [7, 8, 9, 10]) {
      rest.addressedTaken(AGENT, event(seq));
      await settle();
    }
    expect(notices).toHaveLength(3);
    expect(new Set(notices.map((notice) => notice.key)).size).toBe(1);
  });

  it('waits for a room message: a task event names no room to tell', async () => {
    await rest.rest(entry());
    rest.wake(AGENT, 'event');
    await settle();
    rest.addressedTaken(AGENT, {
      type: 'task_delegate',
      sequence: 7,
      payload: {},
    } as unknown as AgentBridgeEvent);
    await settle();
    expect(notices).toEqual([]);
    rest.addressedTaken(AGENT, event(8));
    await settle();
    expect(notices).toHaveLength(1);
  });

  it('owes nothing once the agent is stopped by its owner or removed', async () => {
    await rest.rest(entry());
    rest.wake(AGENT, 'event');
    await settle();
    rest.clear(AGENT);
    rest.addressedTaken(AGENT, event(7));
    await settle();
    expect(notices).toEqual([]);
  });
});

describe('restAfterFromEnv', () => {
  it('is off when unset or "off", and takes a whole number of at least a minute', () => {
    expect(restAfterFromEnv({}, silentLogger)).toBeNull();
    expect(restAfterFromEnv({ [REST_AFTER_ENV]: 'off' }, silentLogger)).toBeNull();
    expect(restAfterFromEnv({ [REST_AFTER_ENV]: '600000' }, silentLogger)).toBe(600_000);
  });

  it('refuses a value that is not one, rather than resting at once or never, and says so', () => {
    const warnings: string[] = [];
    const log = { warn: (message: string) => void warnings.push(message) };
    expect(restAfterFromEnv({ [REST_AFTER_ENV]: '0' }, log)).toBeNull();
    expect(restAfterFromEnv({ [REST_AFTER_ENV]: '10m' }, log)).toBeNull();
    expect(restAfterFromEnv({ [REST_AFTER_ENV]: '-5' }, log)).toBeNull();
    expect(warnings).toHaveLength(3);
  });
});

// -- With the real hub: nothing held is lost or handed over twice --------------

function message(seq: number, addressed: boolean): AgentEventFrame {
  return {
    agent_id: AGENT,
    seq,
    event: {
      type: 'message',
      room_id: ROOM,
      payload: { addressed, message_id: `$m${seq}`, body: `hello ${seq}` },
    },
  };
}

describe('resting with the real hub', () => {
  let realHub: AgentHub;
  let confirmed: number[];
  let hosts: { events: AgentBridgeEvent[]; gaps: number; stop: () => void }[];
  /** What the agent host's own journal would save: its last addressed event, or none. */
  let hostCursor: number | undefined;

  function openHost(): { events: AgentBridgeEvent[]; gaps: number; stop: () => void } {
    const events: AgentBridgeEvent[] = [];
    const host = { events, gaps: 0, stop: () => controller.abort() };
    const controller = new AbortController();
    const deps: SwitchEventStreamDeps = {
      creds: { agentId: AGENT, apiEndpoint: '', token: '' },
      connectionId: `connection-${hosts.length + 1}`,
      scope: 'all',
      filter: 'addressed',
      rooms: [],
      ...(hostCursor === undefined ? {} : { startCursor: hostCursor }),
      onEvent: (event) => {
        events.push(event);
        hostCursor = event.sequence;
      },
      onGap: () => void host.gaps++,
      onEvicted: () => {},
      log: { debug: () => {}, warn: () => {}, error: () => {} },
      signal: controller.signal,
    };
    hosts.push(host);
    realHub.open(AGENT, deps).start();
    return host;
  }

  beforeEach(() => {
    confirmed = [];
    hosts = [];
    hostCursor = undefined;
    realHub = new AgentHub({
      log: silentLogger,
      onCursor: (_agentId, cursor) => void confirmed.push(cursor),
      onChange: () => {},
      bufferLimit: 50,
      onWake: (agentId, why) => rest.wake(agentId, why),
      now: () => clock,
    });
    realHub.streamAttached();
    realHub.attach(AGENT, 0, [ROOM]);
    rest = build({
      hub: realHub,
      stopHost: async () => {
        stops++;
        hosts.at(-1)?.stop();
        observation = emptyObservation();
      },
      start: async () => {
        starts++;
        openHost();
        return null;
      },
    });
  });

  it('hands a message sent to a resting agent to its next host once', async () => {
    const first = openHost();
    realHub.ingest(message(1, true));
    await settle();
    expect(first.events.map((event) => event.sequence)).toEqual([1]);
    clock += REST_AFTER + MINUTE;
    await rest.rest(entry());
    expect(rest.state(AGENT)?.kind).toBe('resting');
    realHub.ingest(message(2, true));
    await settle();
    expect(starts).toBe(1);
    const second = hosts.at(-1)!;
    expect(second).not.toBe(first);
    expect(second.events.map((event) => event.sequence)).toEqual([2]);
    expect(first.events.map((event) => event.sequence)).toEqual([1]);
  });

  it('hands three quick messages to a resting agent in order, each once, from one start', async () => {
    openHost();
    await rest.rest(entry());
    for (const seq of [1, 2, 3]) realHub.ingest(message(seq, true));
    await settle();
    expect(starts).toBe(1);
    expect(hosts.at(-1)!.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it('hands the first message to an agent whose host never took one (it saves no cursor)', async () => {
    // Fails without the fix: a later host with no cursor of its own started
    // at the newest event, past the one it was started for.
    openHost();
    await rest.rest(entry());
    realHub.ingest(message(1, true));
    await settle();
    expect(hostCursor).toBe(1);
    expect(hosts.at(-1)!.events.map((event) => event.sequence)).toEqual([1]);
  });

  it('takes the unaddressed chatter itself while the agent rests, so the next host meets no gap', async () => {
    openHost();
    await rest.rest(entry());
    // More chatter than the hub keeps, while resting.
    for (let seq = 1; seq <= 120; seq++) realHub.ingest(message(seq, false));
    expect(starts).toBe(0);
    expect(confirmed.at(-1)).toBe(120);
    realHub.ingest(message(121, true));
    await settle();
    const woken = hosts.at(-1)!;
    expect(woken.events.map((event) => event.sequence)).toEqual([121]);
    expect(woken.gaps).toBe(0);
  });

  it('hands a dying host nothing once the guard is stopping it, and the next host the message once', async () => {
    const first = openHost();
    realHub.ingest(message(1, true));
    await settle();
    expect(first.events.map((event) => event.sequence)).toEqual([1]);
    // The guard, inside the controller's queue: fence, stop the tree, done.
    await rest.suspend(AGENT, 'out_of_memory');
    realHub.ingest(message(2, true));
    await settle();
    // Fails without the fence: the dying host was handed it and it was confirmed.
    expect(first.events.map((event) => event.sequence)).toEqual([1]);
    expect(confirmed.at(-1)).toBe(1);
    first.stop();
    rest.stopped(AGENT);
    await settle();
    expect(starts).toBe(1);
    expect(hosts.at(-1)!.events.map((event) => event.sequence)).toEqual([2]);
  });

  it('keeps a message that arrives while the host is stopping, and hands it over once after', async () => {
    const first = openHost();
    let finishStop: () => void = () => {};
    rest = build({
      hub: realHub,
      stopHost: () =>
        new Promise<void>((resolve) => {
          stops++;
          finishStop = () => {
            first.stop();
            observation = emptyObservation();
            resolve();
          };
        }),
      start: async () => {
        starts++;
        openHost();
        return null;
      },
    });
    const resting = rest.rest(entry());
    await settle();
    // Held: the hub hands the stopping host nothing more.
    realHub.ingest(message(1, true));
    await settle();
    expect(first.events).toEqual([]);
    finishStop();
    await resting;
    await settle();
    expect(starts).toBe(1);
    const all = hosts.flatMap((host) => host.events.map((event) => event.sequence));
    expect(all).toEqual([1]);
  });
});

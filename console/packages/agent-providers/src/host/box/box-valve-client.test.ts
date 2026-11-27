import { describe, expect, it, vi } from 'vitest';
import { BoxValve, type WaitRequest } from './box-valve';
import {
  DirectHostValve,
  giveUpReasonOf,
  type HostSide,
  HubHostValve,
  HubValveChannel,
  LegacyHostValve,
  type ValveChannel,
} from './box-valve-client';
import type { HostValveMessage } from './box-valve-wire';
import { ValveServer } from './box-valve-wire';
import { type ParkCandidate, PressureValve } from './memory-pressure';

const MIB = 1024 ** 2;
const GIB = 1024 * MIB;
const LIMIT = 6 * GIB;
const quiet = { info: () => {}, warn: () => {} };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A host's sessions, as a test drives them. */
function hostSide(agentId: string) {
  const state = {
    awake: 0,
    idle: [] as { sessionId: string; idleSinceMs: number }[],
    waiting: [] as WaitRequest[],
    parked: [] as string[],
  };
  const side: HostSide = {
    awake: () => state.awake,
    idle: () =>
      state.idle.map((s): ParkCandidate => ({
        ...s,
        duplicate: false,
        park: async () => {
          state.parked.push(s.sessionId);
          state.idle = state.idle.filter((other) => other.sessionId !== s.sessionId);
          state.awake--;
          return true;
        },
      })),
    waiting: () => state.waiting,
  };
  const events = { starts: [] as string[], letGos: [] as [string, string][] };
  return {
    agentId,
    state,
    side,
    events,
    handlers: {
      start: async (sessionId: string) => events.starts.push(sessionId),
      letGo: (messageId: string, reason: string) => events.letGos.push([messageId, reason]),
    },
  };
}

/** One hub connection, both ends in memory: the host's channel and the controller's valve server. */
function hub(valve: BoxValve, agentId: string, share = 1) {
  const channel = new HubValveChannel();
  let server: ValveServer | null = null;
  const connect = () => {
    channel.bind((text) => {
      // As the hub socket does: the frame goes to the server as text.
      queueMicrotask(() => server?.receive(text));
      return true;
    });
    server = new ValveServer({
      valve,
      agentId,
      send: (message) => queueMicrotask(() => channel.deliver(JSON.parse(JSON.stringify(message)))),
      log: quiet,
      share,
    });
  };
  const drop = () => {
    server?.close();
    server = null;
    channel.bind(null);
  };
  return { channel, connect, drop };
}

const fallback = (usage = 0.5) => ({
  limit: LIMIT,
  readUsage: async () => usage * LIMIT,
  startReserve: 512 * MIB,
});

describe('five isolated hosts over the hub', () => {
  it('a box at 83% parks one session per settle, never four at once', async () => {
    let usage = 0.83 * LIMIT;
    const SETTLE = 150;
    const valve = new BoxValve({
      limit: LIMIT,
      readUsage: async () => usage,
      settleMs: SETTLE,
      cap: 100,
      log: quiet,
    });
    const t0 = Date.now();
    const parks: number[] = [];
    for (let i = 0; i < 5; i++) {
      const host = hostSide(`agent-${i}`);
      host.state.awake = 3;
      host.state.idle = Array.from({ length: 3 }, (_, j) => ({
        sessionId: `h${i}-s${j}`,
        idleSinceMs: t0 - (i * 3 + j + 1) * 60_000,
      }));
      const side = host.side;
      const wrapped: HostSide = {
        ...side,
        idle: () =>
          side.idle().map((c) => ({
            ...c,
            park: async () => {
              parks.push(Date.now() - t0);
              setTimeout(() => {
                usage -= 235 * MIB;
              }, 100);
              return c.park();
            },
          })),
      };
      const link = hub(valve, host.agentId);
      const client = new HubHostValve(link.channel, fallback(), { log: quiet });
      client.attach(wrapped, host.handlers);
      link.connect();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.all(Array.from({ length: 5 }, () => valve.check()));
    expect(parks.filter((at) => at < 50 + SETTLE).length).toBe(1);
    for (let i = 1; i < parks.length; i++)
      expect(parks[i]! - parks[i - 1]!).toBeGreaterThanOrEqual(SETTLE - 20);
    expect(parks.length).toBe(5);
  });
});

describe('three waiters on three agents', () => {
  /**
   * Three isolated hosts, each with one message waiting at a full box, each handling the box's `start` the way
   * `agent-host` does: it tries the start, whose `admit` must claim the reserved room, and only then settles.
   */
  async function threeWaiting(handlerVoids: boolean, hangs?: { name: string; boundMs: number }) {
    const warnings: string[] = [];
    let otherAwake = 3;
    const valve = new BoxValve({
      limit: LIMIT,
      readUsage: async () => 0,
      cap: 3,
      settleMs: 0,
      log: quiet,
    });
    valve.connect({
      agentId: 'busy-agent',
      awake: () => otherAwake,
      idle: () => [],
      park: async () => false,
      start: () => {},
      letGo: () => {},
    });
    const order: string[] = [];
    const clients = [];
    const t0 = Date.now();
    for (const [i, name] of ['pm', 'designer', 'engineer'].entries()) {
      const host = hostSide(name);
      const link = hub(valve, name);
      const client = new HubHostValve(link.channel, fallback(), {
        log: { info: () => {}, warn: (line: string) => warnings.push(line) },
        startBoundMs: hangs?.boundMs,
      });
      const tryStart = async (sessionId: string) => {
        // The host reads its watch flags and journal before it asks: a few ms in which a dropped promise has
        // already handed the room back.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const answer = await client.admit(sessionId, 'message');
        if (!answer.ok) return false;
        order.push(name);
        host.state.awake++;
        client.changed();
        client.settle(answer.lease, true);
        return true;
      };
      client.attach(host.side, {
        // As the host wires it: the start's promise returned (the fix), or dropped (the bug).
        start:
          hangs?.name === name
            ? () => new Promise<never>(() => {})
            : handlerVoids
              ? async (sessionId) => void tryStart(sessionId)
              : (sessionId) => tryStart(sessionId),
        letGo: () => {},
      });
      link.connect();
      await flush();
      await flush();
      const request: WaitRequest = {
        roomId: `room-${name}`,
        messageId: `m-${name}`,
        sessionId: `s-${name}`,
        sinceMs: t0 + i,
        kind: 'room',
      };
      expect(await client.wait(request)).toBe('waiting');
      clients.push({ name, client, host, tryStart });
    }
    return { valve, order, clients, warnings, free: (to = 0) => (otherAwake = to) };
  }

  it('room frees: all three are admitted in order through the box’s grants, with no step-overs', async () => {
    const { valve, order, clients, free } = await threeWaiting(false);
    // Each host's own retry is refused while the others wait.
    expect(await clients[1]!.client.admit('s-designer', 'message')).toEqual({
      ok: false,
      reason: 'busy',
    });
    free();
    for (let round = 0; round < 3; round++) {
      await valve.tick();
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Each started host's message leaves the box's list, as `agent-host` does once its session is up.
      for (const { name, client } of clients) if (order.includes(name)) client.unwait(`m-${name}`);
      await flush();
    }
    expect(order).toEqual(['pm', 'designer', 'engineer']);
    const stepped = (valve as unknown as { steppedOver: Map<string, number> }).steppedOver;
    expect(stepped.size).toBe(0);
    expect(valve.starting).toBe(0);
  });

  it('with the start dropped (the old bug), nobody gets in', async () => {
    const { valve, order, free } = await threeWaiting(true);
    free();
    for (let round = 0; round < 3; round++) {
      await valve.tick();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(order).toEqual([]);
  });

  it('a start that never settles hands its room back at the bound, and the next waiter gets it', async () => {
    const { valve, order, clients, warnings, free } = await threeWaiting(false, {
      name: 'pm',
      boundMs: 100,
    });
    // Room for one only.
    free(2);
    // The box reserves that room for the oldest (pm), whose start hangs.
    await valve.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual([]);
    expect(valve.starting).toBe(1);
    // At the bound, pm's room is handed back once, with one line.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await flush();
    expect(valve.starting).toBe(0);
    expect(
      warnings.filter((line) => line.includes('s-pm') && line.includes('timed out'))
    ).toHaveLength(1);
    // The next round gives the room to the next waiter, which takes it.
    await valve.tick();
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const { name, client } of clients) if (order.includes(name)) client.unwait(`m-${name}`);
    await flush();
    expect(order).toEqual(['designer']);
    expect(warnings).toHaveLength(1);
  });

  it('three never given room are each let go at their own 10 minutes', async () => {
    let clock = 1_000_000;
    const valve = new BoxValve({
      limit: LIMIT,
      readUsage: async () => 0,
      cap: 1,
      now: () => clock,
      log: quiet,
    });
    valve.connect({
      agentId: 'busy-agent',
      awake: () => 1,
      idle: () => [],
      park: async () => false,
      start: () => {},
      letGo: () => {},
    });
    const letGos: string[] = [];
    for (const name of ['pm', 'designer', 'engineer']) {
      const connection = valve.connect({
        agentId: name,
        awake: () => 0,
        idle: () => [],
        park: async () => false,
        start: () => {},
        letGo: (messageId) => letGos.push(messageId),
      });
      connection.wait({
        roomId: `r-${name}`,
        messageId: `m-${name}`,
        sessionId: `s-${name}`,
        sinceMs: clock,
        kind: 'room',
      });
      // A live wait is placed when it arrives: one a second apart.
      clock += 1000;
    }
    clock += 10 * 60_000 - 3000;
    await valve.tick();
    expect(letGos).toEqual(['m-pm']);
    clock += 2_000;
    await valve.tick();
    expect(letGos).toEqual(['m-pm', 'm-designer', 'm-engineer']);
  });
});

describe('HubHostValve: on the box valve', () => {
  it('admits over the hub, and settles the lease it was given', async () => {
    const valve = new BoxValve({ limit: LIMIT, readUsage: async () => 0, cap: 2, log: quiet });
    const host = hostSide('a');
    const link = hub(valve, 'a');
    const client = new HubHostValve(link.channel, fallback(), { log: quiet });
    client.attach(host.side, host.handlers);
    link.connect();
    await flush();
    expect(client.boxWide).toBe(true);
    const answer = await client.admit('s1', 'message');
    expect(answer.ok).toBe(true);
    expect(valve.starting).toBe(1);
    if (answer.ok) client.settle(answer.lease, true);
    await flush();
    expect(valve.starting).toBe(0);
  });

  it('re-sends its waiting messages and its state on (re)connect', async () => {
    const valve = new BoxValve({ limit: LIMIT, readUsage: async () => 0, cap: 2, log: quiet });
    const host = hostSide('a');
    host.state.awake = 2;
    host.state.waiting = [
      { roomId: 'r', messageId: 'm1', sessionId: 's9', sinceMs: Date.now(), kind: 'room' },
    ];
    const link = hub(valve, 'a');
    const client = new HubHostValve(link.channel, fallback(), { log: quiet });
    client.attach(host.side, host.handlers);
    link.connect();
    await flush();
    await flush();
    expect(valve.status()).toMatchObject({ awake: 2, waiting: 1 });
    link.drop();
    expect(valve.status()).toMatchObject({ awake: 0, waiting: 0 });
    link.connect();
    await flush();
    await flush();
    expect(valve.status()).toMatchObject({ awake: 2, waiting: 1 });
  });

  it('asks the box before a message waits, and hears start and letGo', async () => {
    const valve = new BoxValve({
      limit: LIMIT,
      readUsage: async () => 0,
      cap: 1,
      maxPerAgent: 1,
      log: quiet,
    });
    const host = hostSide('a');
    host.state.awake = 1;
    const link = hub(valve, 'a');
    const client = new HubHostValve(link.channel, fallback(), { log: quiet });
    client.attach(host.side, host.handlers);
    link.connect();
    await flush();
    await flush();
    const wait = (messageId: string, sessionId: string): WaitRequest => ({
      roomId: 'r',
      messageId,
      sessionId,
      sinceMs: Date.now(),
      kind: 'room',
    });
    expect(await client.wait(wait('m1', 's2'))).toBe('waiting');
    expect(await client.wait(wait('m2', 's3'))).toBe('agent_full');
    host.state.awake = 0;
    client.changed();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await valve.tick();
    await flush();
    expect(host.events.starts).toEqual(['s2']);
    // Its admit now takes the room the start reserved.
    expect((await client.admit('s2', 'message')).ok).toBe(true);
  });

  it('parks a session when the box valve asks, and only one it offered', async () => {
    const valve = new BoxValve({ limit: LIMIT, readUsage: async () => 0, cap: 1, log: quiet });
    const host = hostSide('a');
    host.state.awake = 1;
    host.state.idle = [{ sessionId: 's1', idleSinceMs: 1 }];
    const link = hub(valve, 'a');
    const client = new HubHostValve(link.channel, fallback(), { log: quiet });
    client.attach(host.side, host.handlers);
    link.connect();
    await flush();
    await flush();
    const other = hostSide('b');
    const direct = new DirectHostValve(valve, 'b');
    direct.attach(other.side, other.handlers);
    const admitting = direct.admit('b1', 'message');
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.changed();
    expect(host.state.parked).toEqual(['s1']);
    expect((await admitting).ok).toBe(true);
  });
});

/** A hub the test speaks for: records what the host sends, and delivers what the test says. */
function scriptedHub() {
  const sent: HostValveMessage[] = [];
  let up = true;
  const messages = new Set<(message: unknown) => void>();
  const downs = new Set<() => void>();
  const channel: ValveChannel = {
    send: (message) => {
      if (!up) return false;
      sent.push(message);
      return true;
    },
    onMessage: (listener) => {
      messages.add(listener);
      return () => messages.delete(listener);
    },
    onDown: (listener) => {
      downs.add(listener);
      return () => downs.delete(listener);
    },
  };
  return {
    channel,
    sent,
    deliver: (message: object) => {
      for (const listener of messages) listener({ type: 'valve', ...message });
    },
    sending: (on: boolean) => {
      up = on;
    },
  };
}

describe('HubHostValve: leases and answers never go astray', () => {
  it('a failed send while ready is decided by the fallback once: no orphaned local lease', async () => {
    const hub = scriptedHub();
    const client = new HubHostValve(hub.channel, fallback(), { log: quiet });
    const host = hostSide('a');
    client.attach(host.side, host.handlers);
    hub.deliver({ op: 'ready', cap: 12, share: 2 });
    hub.sending(false);
    const answer = await client.admit('s1', 'message');
    expect(answer.ok).toBe(true);
    if (answer.ok) client.settle(answer.lease, true);
    // Its share is 2: two more fit only if no lease was left behind.
    expect((await client.admit('s2', 'message')).ok).toBe(true);
    expect((await client.admit('s3', 'message')).ok).toBe(true);
    expect(await client.admit('s4', 'message')).toEqual({ ok: false, reason: 'cap' });
  });

  it('an admitted that comes after the host gave up is handed straight back', async () => {
    const hub = scriptedHub();
    const client = new HubHostValve(hub.channel, fallback(), { log: quiet, admitTimeoutMs: 20 });
    const host = hostSide('a');
    client.attach(host.side, host.handlers);
    hub.deliver({ op: 'ready', cap: 12, share: 2 });
    expect(await client.admit('s1', 'message')).toEqual({ ok: false, reason: 'busy' });
    const request = hub.sent.find((m) => m.op === 'admit') as { requestId: number };
    hub.deliver({ op: 'admitted', requestId: request.requestId, lease: 'late-lease' });
    expect(hub.sent.at(-1)).toEqual({
      type: 'valve',
      op: 'settle',
      lease: 'late-lease',
      started: false,
    });
  });

  it('a start the host does not take up is handed back; one it takes up is not', async () => {
    const hub = scriptedHub();
    const client = new HubHostValve(hub.channel, fallback(), { log: quiet });
    const host = hostSide('a');
    let takeUp = false;
    client.attach(host.side, {
      start: async (sessionId) => {
        if (!takeUp) return false;
        const answer = client.admit(sessionId, 'message');
        const request = hub.sent.filter((m) => m.op === 'admit').at(-1) as { requestId: number };
        hub.deliver({ op: 'admitted', requestId: request.requestId, lease: 'start-2' });
        return (await answer).ok;
      },
      letGo: () => {},
    });
    hub.deliver({ op: 'ready', cap: 12, share: 2 });
    hub.deliver({ op: 'start', sessionId: 's1', lease: 'start-1' });
    await flush();
    expect(hub.sent.filter((m) => m.op === 'settle')).toEqual([
      { type: 'valve', op: 'settle', lease: 'start-1', started: false },
    ]);
    takeUp = true;
    hub.deliver({ op: 'start', sessionId: 's2', lease: 'start-2' });
    await flush();
    await flush();
    expect(hub.sent.filter((m) => m.op === 'settle')).toHaveLength(1);
  });

  it('a wait refused by the rate limit waits here and is asked again', async () => {
    const hub = scriptedHub();
    const client = new HubHostValve(hub.channel, fallback(), { log: quiet });
    const host = hostSide('a');
    client.attach(host.side, host.handlers);
    hub.deliver({ op: 'ready', cap: 12, share: 2 });
    const request: WaitRequest = {
      roomId: 'r',
      messageId: 'm1',
      sessionId: 's1',
      sinceMs: 1,
      kind: 'room',
    };
    const waiting = client.wait(request);
    const first = hub.sent.filter((m) => m.op === 'wait').at(-1) as { requestId: number };
    hub.deliver({ op: 'waited', requestId: first.requestId, answer: 'limit' });
    expect(await waiting).toBe('waiting');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(hub.sent.filter((m) => m.op === 'wait')).toHaveLength(2);
  });

  it('an unwait refused by the rate limit is asked again until it is answered', async () => {
    const hub = scriptedHub();
    const client = new HubHostValve(hub.channel, fallback(), { log: quiet });
    const host = hostSide('a');
    client.attach(host.side, host.handlers);
    hub.deliver({ op: 'ready', cap: 12, share: 2 });
    client.unwait('m1');
    const first = hub.sent.filter((m) => m.op === 'unwait').at(-1) as { requestId: number };
    hub.deliver({ op: 'unwaited', requestId: first.requestId, ok: false });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const again = hub.sent.filter((m) => m.op === 'unwait');
    expect(again).toHaveLength(2);
    hub.deliver({
      op: 'unwaited',
      requestId: (again[1] as { requestId: number }).requestId,
      ok: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(hub.sent.filter((m) => m.op === 'unwait')).toHaveLength(2);
  });
});

describe('HubHostValve: the hub-down fallback', () => {
  it('before the box valve is ready: only its share, never a park', async () => {
    const host = hostSide('a');
    host.state.idle = [{ sessionId: 's1', idleSinceMs: 1 }];
    host.state.awake = 1;
    const client = new HubHostValve(new HubValveChannel(), fallback(), { log: quiet });
    client.attach(host.side, host.handlers);
    expect(client.boxWide).toBe(false);
    // Its share is 1 until the controller says otherwise: one awake already.
    expect(await client.admit('s2', 'message')).toEqual({ ok: false, reason: 'cap' });
    expect(host.state.parked).toEqual([]);
  });

  it('keeps to the share the controller gave, refuses at the 90% line', async () => {
    const valve = new BoxValve({ limit: LIMIT, readUsage: async () => 0, cap: 12, log: quiet });
    const host = hostSide('a');
    let usage = 0.5;
    const link = hub(valve, 'a', 3);
    const client = new HubHostValve(
      link.channel,
      { ...fallback(), readUsage: async () => usage * LIMIT },
      { log: quiet }
    );
    client.attach(host.side, host.handlers);
    link.connect();
    await flush();
    link.drop();
    const leases: string[] = [];
    for (let i = 0; i < 3; i++) {
      const answer = await client.admit(`s${i}`, 'message');
      expect(answer.ok).toBe(true);
      if (answer.ok) leases.push(answer.lease);
    }
    expect(await client.admit('s3', 'message')).toEqual({ ok: false, reason: 'cap' });
    for (const lease of leases) client.settle(lease, true);
    usage = 0.85;
    // 85% plus one start's reserve is past 90% of 6 GiB.
    expect(await client.admit('s4', 'message')).toEqual({ ok: false, reason: 'memory' });
  });

  it('starts nothing new after 2 minutes without the box valve, and resumes when it is back', async () => {
    let now = 0;
    const valve = new BoxValve({ limit: LIMIT, readUsage: async () => 0, cap: 12, log: quiet });
    const host = hostSide('a');
    const warn = vi.fn();
    const link = hub(valve, 'a', 4);
    const client = new HubHostValve(link.channel, fallback(), {
      log: { info: () => {}, warn },
      now: () => now,
    });
    client.attach(host.side, host.handlers);
    link.connect();
    await flush();
    link.drop();
    expect(warn).toHaveBeenCalledTimes(1);
    now += 119_999;
    expect((await client.admit('s1', 'message')).ok).toBe(true);
    now += 1;
    expect(await client.admit('s2', 'message')).toEqual({ ok: false, reason: 'cap' });
    link.connect();
    await flush();
    expect(client.boxWide).toBe(true);
    expect((await client.admit('s2', 'message')).ok).toBe(true);
  });

  it('an admit in flight when the hub drops is decided by the fallback', async () => {
    const valve = new BoxValve({ limit: LIMIT, readUsage: async () => 0, cap: 12, log: quiet });
    const host = hostSide('a');
    const link = hub(valve, 'a', 2);
    const client = new HubHostValve(link.channel, fallback(), { log: quiet });
    client.attach(host.side, host.handlers);
    link.connect();
    await flush();
    const answer = client.admit('s1', 'message');
    link.drop();
    expect(await answer).toMatchObject({ ok: true });
    expect((await answer.then((a) => (a.ok ? a.lease : ''))).startsWith('local-')).toBe(true);
  });

  it('waits are kept locally while the hub is down', async () => {
    const client = new HubHostValve(new HubValveChannel(), fallback(), { log: quiet });
    const host = hostSide('a');
    client.attach(host.side, host.handlers);
    expect(
      await client.wait({ roomId: 'r', messageId: 'm', sessionId: 's', sinceMs: 0, kind: 'room' })
    ).toBe('waiting');
  });

  it('with no box limit, the fallback admits everything, as today', async () => {
    const client = new HubHostValve(
      new HubValveChannel(),
      { limit: null, readUsage: async () => null, startReserve: 0 },
      { log: quiet }
    );
    const host = hostSide('a');
    host.state.awake = 50;
    client.attach(host.side, host.handlers);
    expect((await client.admit('s', 'message')).ok).toBe(true);
  });
});

describe('DirectHostValve and LegacyHostValve', () => {
  it('a host in the controller’s process re-sends its waiters and hears letGo at once for one over its share', async () => {
    const valve = new BoxValve({
      limit: LIMIT,
      readUsage: async () => 0,
      cap: 2,
      maxPerAgent: 1,
      log: quiet,
    });
    const host = hostSide('a');
    host.state.waiting = [
      { roomId: 'r', messageId: 'm1', sessionId: 's1', sinceMs: Date.now(), kind: 'room' },
      { roomId: 'r', messageId: 'm2', sessionId: 's2', sinceMs: Date.now(), kind: 'room' },
    ];
    const direct = new DirectHostValve(valve, 'a');
    const leave = direct.attach(host.side, host.handlers);
    await flush();
    expect(host.events.letGos).toEqual([['m2', 'agent_full']]);
    leave();
    expect(valve.status().waiting).toBe(0);
  });

  it('a host in the controller’s process bounds a start that never settles, and logs it once', async () => {
    const warnings: string[] = [];
    const valve = new BoxValve({ limit: LIMIT, readUsage: async () => 0, cap: 1, log: quiet });
    const host = hostSide('a');
    host.state.awake = 1;
    const direct = new DirectHostValve(valve, 'a', {
      log: { warn: (line: string) => warnings.push(line) },
      startBoundMs: 100,
    });
    direct.attach(host.side, {
      ...host.handlers,
      start: () => new Promise<never>(() => {}),
    });
    expect(
      await direct.wait({
        roomId: 'r',
        messageId: 'm1',
        sessionId: 's1',
        sinceMs: Date.now(),
        kind: 'room',
      })
    ).toBe('waiting');
    // Room frees: the box reserves it for s1, whose start hangs.
    host.state.awake = 0;
    await valve.tick();
    await flush();
    expect(valve.starting).toBe(1);
    // At the bound the room is handed back, with one line.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await flush();
    expect(valve.starting).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('s1');
    expect(warnings[0]).toContain('timed out');
  });

  it('a process with no controller keeps today’s valve', async () => {
    const pressure = new PressureValve({ limit: null, readUsage: async () => null });
    const legacy = new LegacyHostValve(pressure);
    const host = hostSide('a');
    legacy.attach(host.side, host.handlers);
    expect(await legacy.admit()).toEqual({ ok: true, lease: 'local' });
    expect(await legacy.wait()).toBe('waiting');
    expect(legacy.boxWide).toBe(false);
  });

  it('maps the box’s let-go codes to the host’s own lines', () => {
    expect(giveUpReasonOf('timed_out')).toBe('timed out');
    expect(giveUpReasonOf('list_full')).toBe('list full');
    expect(giveUpReasonOf('agent_full')).toBe('list full');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { BoxValve, LET_GO_REASONS, REFUSE_REASONS } from './box-valve';
import {
  type ControllerValveMessage,
  controllerValveMessageSchema,
  hostValveMessageSchema,
  isValveFrame,
  RateLimit,
  VALVE_MESSAGE_MAX_BYTES,
  ValveServer,
} from './box-valve-wire';

const GIB = 1024 ** 3;
const quiet = { info: () => {}, warn: () => {} };

function server(over: { agentId?: string; valve?: BoxValve; clock?: { now: number } } = {}) {
  const clock = over.clock ?? { now: 1_000_000 };
  const valve =
    over.valve ??
    new BoxValve({
      limit: 6 * GIB,
      readUsage: async () => 0.5 * 6 * GIB,
      cap: 3,
      settleMs: 0,
      now: () => clock.now,
      log: quiet,
    });
  const sent: ControllerValveMessage[] = [];
  const log = { info: vi.fn(), warn: vi.fn() };
  const s = new ValveServer({
    valve,
    agentId: over.agentId ?? 'a',
    send: (message) => sent.push(message),
    log,
    share: 2,
    now: () => clock.now,
  });
  const send = (message: object) => s.receive(JSON.stringify({ type: 'valve', ...message }));
  return { s, valve, sent, log, send, clock };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const waitShape = (messageId: string, sessionId = 's1', sinceMs = 1_000_000) => ({
  roomId: '!room:server',
  messageId,
  sessionId,
  sinceMs,
  kind: 'room',
});

describe('the box valve on the hub: shapes', () => {
  it('says ready with the cap and this agent’s fallback share', () => {
    const { sent } = server();
    expect(sent[0]).toEqual({ type: 'valve', op: 'ready', cap: 3, share: 2 });
  });

  it('admits and refuses with fixed codes only', async () => {
    const { sent, send } = server();
    for (let i = 0; i < 4; i++)
      send({ op: 'admit', requestId: i, sessionId: `s${i}`, kind: 'message' });
    await flush();
    const answers = sent.filter((m) => m.op === 'admitted' || m.op === 'refused');
    expect(answers.filter((m) => m.op === 'admitted')).toHaveLength(3);
    expect(answers.find((m) => m.op === 'refused')).toEqual({
      type: 'valve',
      op: 'refused',
      requestId: 3,
      reason: 'cap',
    });
    for (const m of sent) expect(controllerValveMessageSchema.safeParse(m).success).toBe(true);
  });

  it.each([
    ['an unknown op', { op: 'shout', requestId: 1 }],
    ['an extra field', { op: 'unwait', requestId: 1, messageId: 'm1', text: 'hello' }],
    ['an id with a space', { op: 'unwait', requestId: 1, messageId: 'm 1' }],
    ['an id with a newline', { op: 'unwait', requestId: 1, messageId: 'm\n1' }],
    ['a negative time', { op: 'wait', requestId: 1, wait: { ...waitShape('m1'), sinceMs: -1 } }],
    ['a bad kind', { op: 'admit', requestId: 1, sessionId: 's', kind: 'everything' }],
  ])('drops %s, and logs it once as a code and a count', (_, message) => {
    const { sent, send, log, valve } = server();
    send(message);
    expect(sent.filter((m) => m.op !== 'ready')).toEqual([]);
    expect(valve.status().waiting).toBe(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [line, fields] = log.warn.mock.calls[0]!;
    expect(line).toBe('Refused box valve messages from an agent host');
    expect(fields).toEqual({ agentId: 'a', refused: { unreadable: 1 } });
    // Never the message itself.
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('hello');
  });

  it('drops a message over 4 KiB, and a hello over 64 KiB', () => {
    const { s, send, log } = server();
    send({
      op: 'unwait',
      requestId: 1,
      messageId: 'm'.repeat(200),
      pad: 'x'.repeat(VALVE_MESSAGE_MAX_BYTES),
    });
    send({ op: 'hello', waiting: [], pad: 'x'.repeat(70 * 1024) });
    // A hello may be larger, up to 64 KiB: this one is only unreadable (its pad).
    send({ op: 'hello', waiting: [], pad: 'x'.repeat(8 * 1024) });
    expect(log.warn.mock.calls[0]![1]).toEqual({ agentId: 'a', refused: { too_big: 1 } });
    // The rest within the minute are counted, and said when the connection closes.
    s.close();
    expect(log.warn.mock.calls[1]![1]).toEqual({
      agentId: 'a',
      refused: { too_big: 1, unreadable: 1 },
    });
  });

  it('refuses a hello carrying more than the box list’s 20 waiters, whole', () => {
    const { send, valve } = server();
    send({ op: 'hello', waiting: Array.from({ length: 21 }, (_, i) => waitShape(`m${i}`)) });
    expect(valve.status().waiting).toBe(0);
  });

  it('a raw frame is a valve frame only by its leading type', () => {
    expect(isValveFrame('{"type":"valve","op":"admit"}')).toBe(true);
    expect(isValveFrame(' { "type" : "valve" }')).toBe(true);
    expect(isValveFrame('{"type":"done","id":1,"x":{"type":"valve"}}')).toBe(false);
  });

  it('the codes the schemas accept are exactly the fixed ones', () => {
    const refused = (reason: string) =>
      controllerValveMessageSchema.safeParse({ type: 'valve', op: 'refused', requestId: 1, reason })
        .success;
    for (const reason of REFUSE_REASONS) expect(refused(reason)).toBe(true);
    expect(refused('the box is on fire')).toBe(false);
    const letGo = (reason: string) =>
      controllerValveMessageSchema.safeParse({ type: 'valve', op: 'letGo', messageId: 'm', reason })
        .success;
    for (const reason of LET_GO_REASONS) expect(letGo(reason)).toBe(true);
    expect(letGo('because')).toBe(false);
    expect(
      hostValveMessageSchema.safeParse({ type: 'valve', op: 'state', awake: 1, idle: [] }).success
    ).toBe(true);
  });
});

describe('the box valve on the hub: rate limits', () => {
  it('admit: refused with limit past a burst of 20, logged once a minute', async () => {
    const valve = new BoxValve({
      limit: 6 * GIB,
      readUsage: async () => 0,
      cap: 1000,
      log: quiet,
    });
    const { sent, send, log, clock } = server({ valve });
    for (let i = 0; i < 25; i++)
      send({ op: 'admit', requestId: i, sessionId: `s${i}`, kind: 'message' });
    await flush();
    expect(sent.filter((m) => m.op === 'refused' && m.reason === 'limit')).toHaveLength(5);
    expect(log.warn).toHaveBeenCalledTimes(1);
    // More within the minute: counted, not logged.
    send({ op: 'admit', requestId: 99, sessionId: 'x', kind: 'message' });
    expect(log.warn).toHaveBeenCalledTimes(1);
    clock.now += 60_000;
    send({ op: 'nonsense' });
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[1]![1]).toEqual({
      agentId: 'a',
      refused: { limit: 5, unreadable: 1 },
    });
  });

  it('wait and unwait share 10 a second with bursts of 20', () => {
    const { send, valve } = server({
      valve: new BoxValve({
        limit: 6 * GIB,
        readUsage: async () => 0,
        cap: 5,
        maxWaiting: 100,
        maxPerAgent: 100,
        log: quiet,
      }),
    });
    for (let i = 0; i < 25; i++)
      send({ op: 'wait', requestId: i, wait: waitShape(`m${i}`, `s${i}`, Date.now()) });
    expect(valve.status().waiting).toBe(20);
  });

  it('a wait or unwait over the limit is answered, never dropped in silence', () => {
    const valve = new BoxValve({
      limit: 6 * GIB,
      readUsage: async () => 0,
      cap: 5,
      maxWaiting: 100,
      maxPerAgent: 100,
      log: quiet,
    });
    const { sent, send } = server({ valve });
    for (let i = 0; i < 20; i++)
      send({ op: 'wait', requestId: i, wait: waitShape(`m${i}`, `s${i}`, Date.now()) });
    send({ op: 'wait', requestId: 20, wait: waitShape('m20', 's20', Date.now()) });
    send({ op: 'unwait', requestId: 21, messageId: 'm0' });
    expect(sent.find((m) => m.op === 'waited' && m.requestId === 20)).toMatchObject({
      answer: 'limit',
    });
    expect(sent.find((m) => m.op === 'unwaited')).toEqual({
      type: 'valve',
      op: 'unwaited',
      requestId: 21,
      ok: false,
    });
    // Refused, so m0 is still on the list: the host asks again.
    expect(valve.status().waiting).toBe(20);
  });

  it('parked is rate-limited like the rest', () => {
    const { send, log, s } = server();
    for (let i = 0; i < 25; i++) send({ op: 'parked', requestId: i, ok: true });
    s.close();
    const counted = log.warn.mock.calls.reduce(
      (sum, [, fields]) => sum + ((fields as { refused: { limit?: number } }).refused.limit ?? 0),
      0
    );
    expect(counted).toBe(5);
  });

  it('hello: once per 10 s', () => {
    const { send, valve, clock } = server();
    send({ op: 'hello', waiting: [waitShape('m1', 's1', clock.now)] });
    send({ op: 'hello', waiting: [waitShape('m2', 's2', clock.now)] });
    expect(valve.status().waiting).toBe(1);
    clock.now += 10_000;
    send({ op: 'hello', waiting: [waitShape('m2', 's2', clock.now)] });
    expect(valve.status().waiting).toBe(2);
  });

  it('a token bucket refills at its rate', () => {
    let now = 0;
    const limit = new RateLimit(10, 2, () => now);
    expect([limit.take(), limit.take(), limit.take()]).toEqual([true, true, false]);
    now += 100;
    expect(limit.take()).toBe(true);
    expect(limit.take()).toBe(false);
  });
});

describe('the box valve on the hub: one agent only', () => {
  it('parks only a session the host offered as idle', async () => {
    const { s, sent, send, valve } = server();
    void s;
    send({ op: 'state', awake: 3, idle: [{ sessionId: 's1', idleSinceMs: 5, duplicate: false }] });
    // Over the cap: the valve asks this host to park its idle session, and only that one.
    const admitting = valve
      .connect({
        agentId: 'b',
        awake: () => 0,
        idle: () => [],
        park: async () => false,
        start: () => {},
        letGo: () => {},
      })
      .admit('b1', 'message');
    await flush();
    const park = sent.find((m) => m.op === 'park');
    expect(park).toMatchObject({ op: 'park', sessionId: 's1' });
    send({ op: 'parked', requestId: (park as { requestId: number }).requestId, ok: true });
    send({ op: 'state', awake: 2, idle: [] });
    expect(await admitting).toMatchObject({ ok: true });
  });

  it('until its first state, a host counts what its health file says, not zero', async () => {
    const { send, valve } = server();
    valve.noteHealth('a', 3);
    expect(valve.awake).toBe(3);
    send({ op: 'state', awake: 1, idle: [] });
    // Its health file still says 3 until the next poll: the larger counts.
    expect(valve.awake).toBe(3);
    valve.noteHealth('a', 1);
    expect(valve.awake).toBe(1);
  });

  it('a host answering parked for a request it was never sent changes nothing', () => {
    const { send } = server();
    expect(() => send({ op: 'parked', requestId: 42, ok: true })).not.toThrow();
  });

  it('one agent’s connection cannot settle another’s lease or unwait its message', async () => {
    const valve = new BoxValve({ limit: 6 * GIB, readUsage: async () => 0, cap: 5, log: quiet });
    const a = server({ valve, agentId: 'a' });
    const b = server({ valve, agentId: 'b' });
    a.send({ op: 'admit', requestId: 1, sessionId: 's1', kind: 'message' });
    await flush();
    a.send({ op: 'wait', requestId: 2, wait: waitShape('m1', 's2', Date.now()) });
    const lease = (a.sent.find((m) => m.op === 'admitted') as { lease: string }).lease;
    b.send({ op: 'settle', lease, started: true });
    b.send({ op: 'unwait', requestId: 3, messageId: 'm1' });
    expect(valve.starting).toBe(1);
    expect(valve.status().waiting).toBe(1);
  });

  it('answers each wait, and lets go of hello waiters past a limit with a fixed code', () => {
    const valve = new BoxValve({
      limit: 6 * GIB,
      readUsage: async () => 0,
      cap: 5,
      maxPerAgent: 1,
      log: quiet,
    });
    const { sent, send } = server({ valve });
    send({ op: 'wait', requestId: 7, wait: waitShape('m1', 's1', Date.now()) });
    send({
      op: 'hello',
      waiting: [waitShape('m1', 's1', Date.now()), waitShape('m2', 's2', Date.now())],
    });
    expect(sent.filter((m) => m.op !== 'ready')).toEqual([
      { type: 'valve', op: 'waited', requestId: 7, answer: 'waiting' },
      { type: 'valve', op: 'letGo', messageId: 'm2', reason: 'agent_full' },
    ]);
  });

  it('closing leaves the valve: leases and waiters go', async () => {
    const { s, send, valve } = server();
    send({ op: 'admit', requestId: 1, sessionId: 's1', kind: 'message' });
    send({ op: 'wait', requestId: 2, wait: waitShape('m1', 's2', Date.now()) });
    await flush();
    s.close();
    expect(valve.starting).toBe(0);
    expect(valve.status().waiting).toBe(0);
  });
});

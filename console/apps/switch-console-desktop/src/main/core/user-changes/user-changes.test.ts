import { describe, expect, it, vi } from 'vitest';
import type { UserChangesEvent } from '@shared/events/userChangesEvents';
import { createUserChangesService, type UserChangesDeps } from './user-changes';

vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { debug: vi.fn() } }));
vi.mock('@main/core/switch-servers/gateway-client', () => ({ gatewaySocketTarget: vi.fn() }));
vi.mock('@main/core/workspaces/workspace-session', () => ({
  withReachableServerWorkspaceSession: vi.fn(),
}));

type Listener = (event: { data?: unknown; code?: number }) => void;

class FakeSocket {
  static opened: FakeSocket[] = [];
  readonly sent: unknown[] = [];
  closedWith: number | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    readonly init: { headers: Record<string, string> }
  ) {
    FakeSocket.opened.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000): void {
    this.closedWith = code;
  }

  fire(type: string, event: { data?: unknown; code?: number } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  frame(event: string, data: Record<string, unknown> = {}): void {
    this.fire('message', { data: JSON.stringify({ event, data }) });
  }
}

function setup() {
  FakeSocket.opened = [];
  const emitted: UserChangesEvent[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const deps: UserChangesDeps = {
    target: async (serverId) => ({
      url: `ws://server/${serverId}/gateway/changes/ws`,
      headers: { Cookie: 'switch_auth=abc' },
    }),
    socket: FakeSocket as unknown as UserChangesDeps['socket'],
    emit: ((_channel: unknown, event: UserChangesEvent) => {
      emitted.push(event);
    }) as UserChangesDeps['emit'],
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
  };
  return { service: createUserChangesService(deps), emitted, timers };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('user changes', () => {
  it('opens one socket per watched server, with the session cookie', async () => {
    const { service } = setup();
    service.watch('s1');
    service.watch('s1');
    await tick();
    expect(FakeSocket.opened).toHaveLength(1);
    expect(FakeSocket.opened[0].url).toBe('ws://server/s1/gateway/changes/ws');
    expect(FakeSocket.opened[0].init.headers.Cookie).toBe('switch_auth=abc');
  });

  it('is live after hello, and forwards notices', async () => {
    const { service, emitted } = setup();
    service.watch('s1');
    await tick();
    const socket = FakeSocket.opened[0];
    socket.fire('open');
    socket.frame('hello', { kinds: ['managed_agent', 'machine'], ping_interval_s: 25 });
    socket.frame('changed', { changes: [{ kind: 'managed_agent', id: 'a1' }] });
    expect(service.isLive('s1')).toBe(true);
    expect(emitted).toEqual([
      { serverId: 's1', type: 'live', kinds: ['managed_agent', 'machine'] },
      { serverId: 's1', type: 'changed', changes: [{ kind: 'managed_agent', id: 'a1' }] },
    ]);
  });

  it('answers pings', async () => {
    const { service } = setup();
    service.watch('s1');
    await tick();
    const socket = FakeSocket.opened[0];
    socket.frame('ping');
    expect(socket.sent).toEqual([{ type: 'pong' }]);
  });

  it('goes down on close and opens again while watched', async () => {
    const { service, emitted, timers } = setup();
    service.watch('s1');
    await tick();
    const socket = FakeSocket.opened[0];
    socket.fire('open');
    socket.frame('hello', { kinds: ['machine'], ping_interval_s: 25 });
    socket.fire('close', { code: 1012 });
    expect(service.isLive('s1')).toBe(false);
    expect(emitted.at(-1)).toEqual({ serverId: 's1', type: 'down' });
    const retry = timers.at(-1)!;
    expect(retry.ms).toBeLessThanOrEqual(1000);
    retry.fn();
    await tick();
    expect(FakeSocket.opened).toHaveLength(2);
  });

  it('waits long before trying a server whose handshake never opened again', async () => {
    const { service, timers } = setup();
    service.watch('s1');
    await tick();
    FakeSocket.opened[0].fire('close', { code: 1006 });
    expect(timers.at(-1)!.ms).toBe(5 * 60_000);
  });

  it('keeps retrying at the usual pace when a server that said hello is restarting', async () => {
    const { service, timers } = setup();
    service.watch('s1');
    await tick();
    const first = FakeSocket.opened[0];
    first.fire('open');
    first.frame('hello', { kinds: ['machine'], ping_interval_s: 25 });
    first.fire('close', { code: 1012 });
    timers.at(-1)!.fn();
    await tick();
    // The server is still down: the handshake fails without opening (a 502).
    FakeSocket.opened[1].fire('close', { code: 1006 });
    expect(timers.at(-1)!.ms).toBeLessThan(60_000);
    timers.at(-1)!.fn();
    await tick();
    expect(FakeSocket.opened).toHaveLength(3);
  });

  it('closes the socket when the last watcher goes', async () => {
    const { service } = setup();
    service.watch('s1');
    service.watch('s1');
    await tick();
    const socket = FakeSocket.opened[0];
    service.unwatch('s1');
    expect(socket.closedWith).toBeNull();
    service.unwatch('s1');
    expect(socket.closedWith).toBe(1000);
    expect(service.isLive('s1')).toBe(false);
  });

  it('takes a server that stops pinging for dead', async () => {
    const { service, timers } = setup();
    service.watch('s1');
    await tick();
    const socket = FakeSocket.opened[0];
    socket.fire('open');
    socket.frame('hello', { kinds: ['machine'], ping_interval_s: 10 });
    const watchdog = timers.at(-1)!;
    expect(watchdog.ms).toBe(30_000);
    watchdog.fn();
    expect(socket.closedWith).toBe(4000);
  });
});

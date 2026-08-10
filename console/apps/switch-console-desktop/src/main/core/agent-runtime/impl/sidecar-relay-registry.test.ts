import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawHookRequest } from '@main/core/agent-hooks/hook-server';
import { SidecarRelayRegistry, sidecarRelayKey } from './sidecar-relay-registry';

const mocks = vi.hoisted(() => ({
  /** Captures the deps each constructed relay was given, so tests can drive its sink. */
  instances: [] as Array<{
    deps: Record<string, unknown>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('./remote-hook-event-relay', () => ({
  RemoteHookEventRelay: class {
    start = vi.fn();
    stop = vi.fn();
    constructor(public deps: Record<string, unknown>) {
      mocks.instances.push({ deps, start: this.start, stop: this.stop });
    }
  },
}));

vi.mock('@main/lib/logger', () => ({
  log: { child: () => ({ debug() {}, info() {}, warn() {} }), info() {}, warn() {} },
}));

function rawEvent(overrides: Partial<RawHookRequest> = {}): RawHookRequest {
  return { ptyId: 'claude-session-a', type: 'stop', body: '{}', ...overrides };
}

/** Drives the sink the registry installed on the relay it created. */
function sinkOf(index = 0): (raw: RawHookRequest) => Promise<void> {
  return mocks.instances[index]!.deps.sink as (raw: RawHookRequest) => Promise<void>;
}

describe('SidecarRelayRegistry', () => {
  const key = sidecarRelayKey({
    connectionId: 'agent-ssh:dev-vm',
    repoDir: '/home/me/agent',
    credsSlug: 'my-agent',
  });

  let registry: SidecarRelayRegistry;
  let sink: ReturnType<typeof vi.fn<(raw: RawHookRequest) => Promise<void>>>;

  const subscribe = (sessionId: string, onSessionTerminated = vi.fn()) => {
    const subscriber = { sessionId, onSessionTerminated };
    registry.acquire({
      key,
      credsSlug: 'my-agent',
      subscriber,
      opener: { openChannel: vi.fn() },
      port: 4000,
      token: 'tok',
      resolveEndpoint: async () => ({ port: 4000, token: 'tok' }),
      sink,
    });
    return subscriber;
  };

  beforeEach(() => {
    mocks.instances.length = 0;
    registry = new SidecarRelayRegistry();
    sink = vi.fn<(raw: RawHookRequest) => Promise<void>>(async () => {});
  });

  it('starts exactly one relay however many sessions share the sidecar', () => {
    subscribe('session-a');
    subscribe('session-b');
    subscribe('session-c');

    expect(mocks.instances).toHaveLength(1);
    expect(mocks.instances[0]!.start).toHaveBeenCalledTimes(1);
    expect(registry.subscriberCount(key)).toBe(3);
  });

  it('replays a normal event through the hook path exactly once', async () => {
    subscribe('session-a');
    subscribe('session-b');
    subscribe('session-c');

    await sinkOf()(rawEvent());

    // The event carries its own ptyId, so one delivery routes it correctly —
    // this is the 16x duplicate processing the shared relay removes.
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('fans session-terminated out to every subscriber', async () => {
    const a = subscribe('session-a');
    const b = subscribe('session-b');
    const c = subscribe('session-c');

    const body = JSON.stringify({ sessionId: 'session-b' });
    await sinkOf()(rawEvent({ type: 'session-terminated', body }));

    for (const subscriber of [a, b, c]) {
      expect(subscriber.onSessionTerminated).toHaveBeenCalledWith(body);
    }
    // A terminated broadcast is not a hook event.
    expect(sink).not.toHaveBeenCalled();
  });

  it('keeps the relay running while any subscriber remains', () => {
    subscribe('session-a');
    subscribe('session-b');

    registry.release(key, 'session-a');

    expect(mocks.instances[0]!.stop).not.toHaveBeenCalled();
    expect(registry.subscriberCount(key)).toBe(1);
  });

  it('stops the relay when the last subscriber leaves', () => {
    subscribe('session-a');
    subscribe('session-b');

    registry.release(key, 'session-a');
    registry.release(key, 'session-b');

    expect(mocks.instances[0]!.stop).toHaveBeenCalledTimes(1);
    expect(registry.get(key)).toBeUndefined();
  });

  it('starts a fresh relay when re-acquired after the last release', () => {
    subscribe('session-a');
    registry.release(key, 'session-a');
    subscribe('session-b');

    expect(mocks.instances).toHaveLength(2);
    expect(mocks.instances[1]!.start).toHaveBeenCalledTimes(1);
  });

  it('keeps one relay per sidecar when a host serves several agents', () => {
    subscribe('session-a');
    const otherKey = sidecarRelayKey({
      connectionId: 'agent-ssh:dev-vm',
      repoDir: '/home/me/other-agent',
      credsSlug: 'other-agent',
    });
    registry.acquire({
      key: otherKey,
      credsSlug: 'other-agent',
      subscriber: { sessionId: 'session-z', onSessionTerminated: vi.fn() },
      opener: { openChannel: vi.fn() },
      port: 4100,
      token: 'tok2',
      resolveEndpoint: async () => ({ port: 4100, token: 'tok2' }),
      sink,
    });

    expect(mocks.instances).toHaveLength(2);
    expect(registry.subscriberCount(key)).toBe(1);
    expect(registry.subscriberCount(otherKey)).toBe(1);
  });

  it('re-acquiring for the same session replaces its subscriber without restarting the relay', async () => {
    subscribe('session-a');
    const replacement = subscribe('session-a');

    expect(mocks.instances).toHaveLength(1);
    expect(registry.subscriberCount(key)).toBe(1);

    await sinkOf()(rawEvent({ type: 'session-terminated', body: '{}' }));
    expect(replacement.onSessionTerminated).toHaveBeenCalledTimes(1);
  });

  it('gives the relay an endpoint resolver that outlives the first subscriber', () => {
    subscribe('session-a');
    subscribe('session-b');
    registry.release(key, 'session-a');

    // The resolver is the relay's only way to follow a restarted sidecar onto a
    // fresh port/token; it must not have been torn down with session-a.
    expect(mocks.instances[0]!.deps.resolveEndpoint).toBeTypeOf('function');
    expect(mocks.instances[0]!.stop).not.toHaveBeenCalled();
  });

  it('releasing an unknown key or session is a no-op', () => {
    subscribe('session-a');

    expect(() => registry.release('no-such-key', 'session-a')).not.toThrow();
    expect(() => registry.release(key, 'no-such-session')).not.toThrow();
    expect(registry.subscriberCount(key)).toBe(1);
    expect(mocks.instances[0]!.stop).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type HostReachability,
  HostUnreachableError,
} from '@shared/core/remote-hosts/reachability';
import { HostReachabilityService, probeDelayFor } from './host-reachability-service';

vi.mock('./reachability-store', () => ({
  listPersistedReachability: vi.fn(async () => []),
  savePersistedReachability: vi.fn(async () => {}),
  hydrate: (record: unknown) => ({
    ...(record as object),
    nextProbeAt: null,
    probing: false,
  }),
}));

class AuthError extends Error {}

function makeService(probe: (sshHost: string) => Promise<void>) {
  const published: HostReachability[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const service = new HostReachabilityService({
    probe,
    isAuthError: (error) => error instanceof AuthError,
    publish: (reachability) => published.push(reachability),
    log: { info: () => {}, warn: () => {} },
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length as unknown as NodeJS.Timeout;
    },
    clearTimer: () => {},
    now: () => 1_700_000_000_000,
  });
  return { service, published, timers };
}

/** Flush the microtask queue so fire-and-forget transitions settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('HostReachabilityService', () => {
  let service: HostReachabilityService;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats a never-probed host as unknown and lets work through', () => {
    ({ service } = makeService(async () => {}));
    expect(service.get('vm').status).toBe('unknown');
    expect(service.isBlocked('vm')).toBe(false);
    expect(() => service.requireReachable('vm')).not.toThrow();
  });

  it('blocks work and throws the modeled reason once a host is unreachable', async () => {
    ({ service } = makeService(async () => {
      throw new Error('Connection lost before handshake');
    }));

    await service.checkNow('vm');

    expect(service.get('vm').status).toBe('unreachable');
    expect(service.isBlocked('vm')).toBe(true);
    expect(() => service.requireReachable('vm')).toThrow(HostUnreachableError);
    expect(() => service.requireReachable('vm')).toThrow(/Connection lost before handshake/);
  });

  it('does not auto-probe an auth failure — a rejected key never self-heals', async () => {
    const { service: svc, timers } = makeService(async () => {
      throw new AuthError('All configured authentication methods failed');
    });

    await svc.checkNow('vm');

    expect(svc.get('vm').status).toBe('suspended');
    expect(timers).toHaveLength(0);
  });

  it('backs off between probes instead of retrying at a fixed interval', async () => {
    const { service: svc, timers } = makeService(async () => {
      throw new Error('unreachable');
    });

    await svc.checkNow('vm');
    expect(timers.at(-1)?.ms).toBe(1_000);

    await svc.checkNow('vm');
    expect(timers.at(-1)?.ms).toBe(5_000);

    await svc.checkNow('vm');
    expect(timers.at(-1)?.ms).toBe(15_000);
  });

  it('probes tightly at first, then caps at five minutes', () => {
    expect(probeDelayFor(1)).toBe(1_000);
    expect(probeDelayFor(4)).toBe(30_000);
    expect(probeDelayFor(6)).toBe(300_000);
    expect(probeDelayFor(50)).toBe(300_000);
  });

  it('clears the blocked state and emits a change when the host recovers', async () => {
    let reachable = false;
    const { service: svc } = makeService(async () => {
      if (!reachable) throw new Error('down');
    });
    const changes: string[] = [];
    svc.on('change', ({ current }) => changes.push(current.status));

    await svc.checkNow('vm');
    expect(svc.isBlocked('vm')).toBe(true);

    reachable = true;
    await svc.checkNow('vm');

    expect(svc.get('vm').status).toBe('reachable');
    expect(svc.isBlocked('vm')).toBe(false);
    expect(svc.get('vm').consecutiveFailures).toBe(0);
    expect(svc.get('vm').lastError).toBeNull();
    expect(changes).toEqual(['unreachable', 'reachable']);
  });

  it('coalesces concurrent probes onto one round trip', async () => {
    const probe = vi.fn(async () => {});
    const { service: svc } = makeService(probe);

    await Promise.all([svc.checkNow('vm'), svc.checkNow('vm'), svc.checkNow('vm')]);

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('probes each host independently', async () => {
    const { service: svc } = makeService(async (sshHost) => {
      if (sshHost === 'bad') throw new Error('down');
    });

    await svc.checkNow('good');
    await svc.checkNow('bad');

    expect(svc.isBlocked('good')).toBe(false);
    expect(svc.isBlocked('bad')).toBe(true);
  });

  it('lets ordinary traffic keep the record fresh without a probe', async () => {
    const probe = vi.fn(async () => {
      throw new Error('down');
    });
    const { service: svc } = makeService(probe);

    await svc.checkNow('vm');
    expect(svc.isBlocked('vm')).toBe(true);

    svc.reportSuccess('vm');
    await settle();

    expect(svc.get('vm').status).toBe('reachable');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('reports a transport failure from real work as unreachable', async () => {
    const { service: svc } = makeService(async () => {});

    svc.reportFailure('vm', new Error('Connection lost before handshake'));
    await settle();

    expect(svc.get('vm').status).toBe('unreachable');
    expect(svc.get('vm').lastError).toBe('Connection lost before handshake');
  });

  it('folds a live SSH connection into the host model', async () => {
    const { service: svc } = makeService(async () => {
      throw new Error('down');
    });

    await svc.checkNow('vm');
    svc.handleSshConnectionEvent('vm', { type: 'connected', connectionId: 'agent-ssh:vm' });
    await settle();

    expect(svc.get('vm').status).toBe('reachable');
  });

  it('re-probes blocked hosts after a system resume', async () => {
    const probe = vi.fn(async () => {
      throw new Error('down');
    });
    const { service: svc } = makeService(probe);

    await svc.checkNow('vm');
    probe.mockClear();

    svc.handleSystemResume();
    await settle();

    expect(probe).toHaveBeenCalledWith('vm');
  });
});

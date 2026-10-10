import { describe, expect, it, vi } from 'vitest';
import {
  allFeatureFlagsOff,
  type RemoteFeatureFlag,
  type ServerFeatureFlags,
} from '@shared/core/feature-flags/feature-flags';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { FeatureFlagsService } from './feature-flags-service';

const server = (id: string) => ({ id }) as SwitchServer;

function harness(servers: SwitchServer[]) {
  const responses = new Map<string, RemoteFeatureFlag[] | Error>();
  const changes: ServerFeatureFlags[] = [];
  const warn = vi.fn();
  const service = new FeatureFlagsService({
    listServers: async () => servers,
    fetchFlags: async (s) => {
      const response = responses.get(s.id);
      if (response instanceof Error) throw response;
      return response ?? [];
    },
    onChange: (state) => changes.push(state),
    warn,
    intervalMs: 60_000,
  });
  return { service, responses, changes, warn, servers };
}

describe('FeatureFlagsService', () => {
  it('reads every server separately', async () => {
    const h = harness([server('a'), server('b')]);
    h.responses.set('a', [{ key: 'ecosystem.show_owners', enabled: true }]);
    h.responses.set('b', [{ key: 'ecosystem.show_owners', enabled: false }]);
    await h.service.refreshAll();
    expect(h.service.get('a').flags['ecosystem.show_owners']).toBe(true);
    expect(h.service.get('b').flags['ecosystem.show_owners']).toBe(false);
  });

  it('ignores keys it does not know and treats missing keys as off', async () => {
    const h = harness([server('a')]);
    h.responses.set('a', [{ key: 'not.a.console.flag', enabled: true }]);
    await h.service.refreshAll();
    expect(h.service.get('a').flags).toEqual(allFeatureFlagsOff());
    expect(h.service.get('a').flags).not.toHaveProperty('not.a.console.flag');
  });

  it('reports a change seen on a later poll, and nothing when nothing changed', async () => {
    const h = harness([server('a')]);
    await h.service.refreshAll();
    expect(h.changes).toHaveLength(1);
    await h.service.refreshAll();
    expect(h.changes).toHaveLength(1);
    h.responses.set('a', [{ key: 'ecosystem.show_owners', enabled: true }]);
    await h.service.refreshAll();
    expect(h.changes).toHaveLength(2);
    expect(h.changes[1].flags['ecosystem.show_owners']).toBe(true);
  });

  it('keeps the last values read when a read fails, and says why', async () => {
    const h = harness([server('a')]);
    h.responses.set('a', [{ key: 'ecosystem.show_owners', enabled: true }]);
    await h.service.refreshAll();
    h.responses.set('a', new Error('unreachable'));
    await h.service.refreshAll();
    await h.service.refreshAll();
    const state = h.service.get('a');
    expect(state.flags['ecosystem.show_owners']).toBe(true);
    expect(state.error).toBe('unreachable');
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it('has every flag off for a server never read', async () => {
    const h = harness([server('a')]);
    h.responses.set('a', new Error('signed out'));
    await h.service.refreshAll();
    expect(h.service.get('a')).toMatchObject({
      flags: { 'ecosystem.show_owners': false },
      fetchedAt: null,
      error: 'signed out',
    });
  });

  it('reads a server never read before answering for it, and only then', async () => {
    const h = harness([server('a')]);
    h.responses.set('a', [{ key: 'agent_management', enabled: true }]);
    expect((await h.service.current(server('a'))).flags.agent_management).toBe(true);
    h.responses.set('a', [{ key: 'agent_management', enabled: false }]);
    expect((await h.service.current(server('a'))).flags.agent_management).toBe(true);
  });

  it('says whether any server turns a flag on', async () => {
    const h = harness([server('a'), server('b')]);
    expect(h.service.anyEnabled('agent_management')).toBe(false);
    h.responses.set('b', [{ key: 'agent_management', enabled: true }]);
    await h.service.refreshAll();
    expect(h.service.anyEnabled('agent_management')).toBe(true);
    expect(h.service.anyEnabled('hosted_agents')).toBe(false);
  });

  it('forgets a server that was removed', async () => {
    const h = harness([server('a')]);
    h.responses.set('a', [{ key: 'ecosystem.show_owners', enabled: true }]);
    await h.service.refreshAll();
    h.servers.length = 0;
    await h.service.refreshAll();
    expect(h.service.get('a').fetchedAt).toBeNull();
  });

  it('polls on the interval once started', async () => {
    vi.useFakeTimers();
    try {
      const h = harness([server('a')]);
      const read = vi.spyOn(h.service, 'refreshAll');
      h.service.start();
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(read).toHaveBeenCalledTimes(2);
      h.service.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

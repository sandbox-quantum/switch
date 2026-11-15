import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PendingInstall from './pending-install';

const h = vi.hoisted(() => ({ values: new Map<string, unknown>(), reads: 0 }));

vi.mock('@main/db/kv', () => ({
  KV: class {
    async get(key: string) {
      h.reads += 1;
      return h.values.get(key) ?? null;
    }
    async set(key: string, value: unknown) {
      h.values.set(key, value);
    }
    async del(key: string) {
      h.values.delete(key);
    }
    async clear() {
      h.values.clear();
    }
  },
}));

describe('the handover marker', () => {
  let marker: typeof PendingInstall;

  beforeEach(async () => {
    vi.resetModules();
    h.values.clear();
    h.reads = 0;
    marker = await import('./pending-install');
  });

  it('gives every caller in a run the same answer, and clears the record once', async () => {
    h.values.set('handover', true);

    const [first, second] = await Promise.all([
      marker.pendingInstall.take(),
      marker.pendingInstall.take(),
    ]);

    // The update service and the launch report both ask; whichever is second
    // must not read the record the first one cleared and answer no.
    // A marker from a build that recorded no version.
    const handover = { targetVersion: null, fromVersion: null };
    expect([first, second]).toEqual([handover, handover]);
    expect(await marker.pendingInstall.take()).toEqual(handover);
    expect(h.values.has('handover')).toBe(false);
    // One read of each of the three keys, once for the whole run.
    expect(h.reads).toBe(3);
  });

  it('answers no when the previous run handed nothing over', async () => {
    expect(await marker.pendingInstall.take()).toBeNull();
  });
});

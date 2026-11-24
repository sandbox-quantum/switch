import { ok } from '@switch-console/shared';
import { expect, it, vi } from 'vitest';
import { ProviderUsageStore } from '@renderer/features/provider-usage/provider-usage-store';
import type { ProviderUsageState } from '@shared/core/provider-usage/provider-usage';

vi.mock('@renderer/lib/ipc', () => ({ events: {}, rpc: {} }));

const state = (revision: number, installedProviderIds: string[] = []): ProviderUsageState => ({
  revision,
  installedProviderIds,
  snapshots: [],
  refreshingProviderIds: [],
});

it('loads initial usage, consumes newer events, refreshes and disposes', async () => {
  let push: ((state: ProviderUsageState) => void) | undefined;
  const unsubscribe = vi.fn();
  const load = Promise.withResolvers<ReturnType<typeof ok<ProviderUsageState>>>();
  const bridge = {
    subscribe: vi.fn((listener: (state: ProviderUsageState) => void) => {
      push = listener;
      return unsubscribe;
    }),
    getSnapshots: vi.fn(() => load.promise),
    setActive: vi.fn(async () => ok<void>()),
    refresh: vi.fn(async () => ok(state(3, ['second']))),
  };
  const store = new ProviderUsageStore(bridge);
  const dispose = store.mount();
  await vi.waitFor(() => expect(bridge.getSnapshots).toHaveBeenCalledOnce());
  load.resolve(ok(state(1, ['first'])));
  await vi.waitFor(() => expect(store.state.revision).toBe(1));

  push?.(state(2, ['first', 'second']));
  expect(store.state.installedProviderIds).toEqual(['first', 'second']);
  push?.(state(1, ['first']));
  expect(store.state.revision).toBe(2);
  await store.refresh('second');
  expect(bridge.refresh).toHaveBeenCalledWith('second');
  expect(store.state.revision).toBe(3);

  dispose();
  push?.(state(4, ['second']));
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(bridge.setActive.mock.calls).toEqual([[true], [false]]);
  expect(store.state.installedProviderIds).toEqual([]);
});

// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { UserChangesEvent } from '@shared/events/userChangesEvents';

const listeners = new Set<(event: UserChangesEvent) => void>();
const watch = vi.fn(async () => false);
const unwatch = vi.fn(async () => {});

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: (_channel: unknown, listener: (event: UserChangesEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
  rpc: { userChanges: { watch, unwatch } },
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: () => 'w1' },
}));

const { useUserChangesLive } = await import('./use-user-changes');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const emit = (event: UserChangesEvent) => {
  for (const listener of [...listeners]) listener(event);
};

describe('useUserChangesLive', () => {
  it('reads the lists once per notice, however many rows use it', async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    const seen: boolean[] = [];
    function Row({ index }: { index: number }) {
      seen[index] = useUserChangesLive('s1');
      return null;
    }
    const rows = Array.from({ length: 21 }, (_, index) =>
      createElement(Row, { key: index, index })
    );
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Fragment, null, rows)
        )
      );
    });
    expect(watch).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);

    await act(async () => {
      emit({ serverId: 's1', workspaceId: 'w1', type: 'live', kinds: ['machine'] });
    });
    expect(seen.every(Boolean)).toBe(true);
    invalidate.mockClear();

    await act(async () => {
      emit({
        serverId: 's1',
        workspaceId: 'w1',
        type: 'changed',
        changes: [{ kind: 'machine', id: 'm1' }],
      });
    });
    expect(invalidate).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    expect(unwatch).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
});

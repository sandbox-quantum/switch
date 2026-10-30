/**
 * After a restart the managed-agents list is read while the server and the
 * window are still settling. A read that came back without an agent (the
 * switch-buddy) must be read again once the change feed is up or the
 * workspaces settle, without the list having to be remounted.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    handlers,
    emit: (name: string, data: unknown) => {
      for (const handler of handlers.get(name) ?? []) handler(data);
    },
    list: vi.fn(),
    watch: vi.fn(),
  };
});

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: (channel: { name: string }, handler: (data: unknown) => void) => {
      const set = ipc.handlers.get(channel.name) ?? new Set();
      set.add(handler);
      ipc.handlers.set(channel.name, set);
      return () => set.delete(handler);
    },
  },
  rpc: {
    managedAgents: { list: ipc.list },
    userChanges: { watch: ipc.watch, unwatch: async () => {} },
  },
}));
vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ agent_management: true }),
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    isConnected: () => true,
    statusFor: () => ({ user: { id: 'user-1' } }),
  },
}));
vi.mock('@renderer/features/switch-servers/server-availability', () => ({
  serverAvailability: () => 'connected',
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: () => 'ws' },
}));

import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';

function Names() {
  const agents = useManagedAgents('srv');
  return <p>{(agents.data ?? []).map((agent) => agent.name).join(',') || 'none'}</p>;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  ipc.handlers.clear();
  ipc.list.mockReset();
  ipc.watch.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

it('reads the list again once the change feed turns out to be live', async () => {
  let resolveWatch!: (live: boolean) => void;
  ipc.watch.mockReturnValue(new Promise((resolve) => (resolveWatch = resolve)));
  // Read at startup, before the buddy is in the list; it is there when read again.
  ipc.list.mockResolvedValueOnce([]).mockResolvedValue([{ agentId: 'b', name: 'switch-buddy' }]);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Names />
      </QueryClientProvider>
    )
  );
  await settle();
  expect(container.textContent).toBe('none');
  await act(async () => resolveWatch(true));
  await settle();
  expect(container.textContent).toBe('switch-buddy');
});

it('reads the list again when the workspaces settle', async () => {
  ipc.watch.mockResolvedValue(false);
  ipc.list.mockResolvedValueOnce([]).mockResolvedValue([{ agentId: 'b', name: 'switch-buddy' }]);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Names />
      </QueryClientProvider>
    )
  );
  await settle();
  expect(container.textContent).toBe('none');
  await act(async () => ipc.emit('workspaces:changed', undefined));
  await settle();
  expect(container.textContent).toBe('switch-buddy');
});

/**
 * A server without cloud agents (its Core has no launch list) shows no error
 * and is not polled; it is asked again once its session or version changes.
 * A server with an empty list keeps being polled, and a failure still shows.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const sdkHost = vi.hoisted(() => ({ cloudAgents: vi.fn() }));
const status = await vi.hoisted(async () => {
  const { observable } = await import('mobx');
  return observable.box<{ user: { id: string; server: { version: string } } | null }>({
    user: { id: 'user', server: { version: '0.28.0' } },
  });
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { sdkHost },
}));

vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: { workspacesNotSignedIn: [], roomNameById: () => null },
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    activeServerId: 'server',
    statusFor: () => ({ serverId: 'server', connected: true, ...status.get() }),
  },
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: vi.fn() }),
  useParams: () => ({ params: {} }),
}));

vi.mock('@renderer/lib/layout/workspace-slots', () => ({
  useWorkspaceSlots: () => ({ currentView: 'home' }),
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: { isGroupExpanded: () => false, toggleGroupExpanded: () => {} },
}));

import { runInAction } from 'mobx';
import { CloudAgentList } from '@renderer/features/cloud-agents/cloud-agent-list';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  sdkHost.cloudAgents.mockReset();
  runInAction(() => status.set({ user: { id: 'user', server: { version: '0.28.0' } } }));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
});

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function render(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <CloudAgentList />
      </QueryClientProvider>
    )
  );
  await settle();
  return container;
}

it('shows nothing for a server without cloud agents, and stops asking it', async () => {
  sdkHost.cloudAgents.mockResolvedValue(null);
  const el = await render();
  expect(el.querySelector('[role="alert"]')).toBeNull();
  await settle(20_000);
  expect(sdkHost.cloudAgents).toHaveBeenCalledTimes(1);
});

it('keeps asking a server whose launch list is empty', async () => {
  sdkHost.cloudAgents.mockResolvedValue([]);
  const el = await render();
  expect(el.querySelector('[role="alert"]')).toBeNull();
  await settle(5_000);
  expect(sdkHost.cloudAgents).toHaveBeenCalledTimes(2);
});

it.each([
  ['Switch session expired — please sign in again.'],
  ['Could not reach http://switch.example.com: connection refused'],
  ['Switch gateway returned 500'],
])('still shows a failure: %s', async (message) => {
  sdkHost.cloudAgents.mockRejectedValue(new Error(message));
  const el = await render();
  expect(el.querySelector('[role="alert"]')?.textContent).toContain(message);
});

it.each([
  ['an upgrade', { id: 'user', server: { version: '0.29.0' } }],
  ['a new sign-in', { id: 'someone-else', server: { version: '0.28.0' } }],
])('asks a server without cloud agents again after %s', async (_name, user) => {
  sdkHost.cloudAgents.mockResolvedValue(null);
  await render();
  expect(sdkHost.cloudAgents).toHaveBeenCalledTimes(1);

  await act(async () => runInAction(() => status.set({ user })));
  await settle();
  expect(sdkHost.cloudAgents).toHaveBeenCalledTimes(2);
});

it('asks a server without cloud agents again once it reconnects', async () => {
  sdkHost.cloudAgents.mockResolvedValue(null);
  await render();
  await act(async () => runInAction(() => status.set({ user: null })));
  await settle();
  const whileDisconnected = sdkHost.cloudAgents.mock.calls.length;

  await act(async () =>
    runInAction(() => status.set({ user: { id: 'user', server: { version: '0.28.0' } } }))
  );
  await settle();
  expect(sdkHost.cloudAgents).toHaveBeenCalledTimes(whileDisconnected + 1);
});

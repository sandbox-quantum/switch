import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloudAgentRepository } from '@renderer/features/locations/components/add-agent-modal/cloud-agent-repository';
import { CreateSessionModal } from '@renderer/features/sessions/create-session-modal/create-session-modal';
import { rpc } from '@renderer/lib/ipc';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@renderer/lib/components/agent-icon', () => ({ AgentIcon: () => null }));
const navigate = vi.hoisted(() => vi.fn());
const roomError = vi.hoisted(() => vi.fn());
const fetchAgentRooms = vi.hoisted(() => vi.fn());
const launches = vi.hoisted(() => [
  {
    request_id: 'launch',
    agent_id: 'agent',
    name: 'Cloud agent',
    state: 'ready',
    provider: 'claude',
    sleeping: false,
  },
  {
    request_id: 'other-launch',
    agent_id: 'other-agent',
    name: 'Other agent',
    state: 'ready',
    provider: 'claude',
    sleeping: false,
  },
]);
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    switchServers: {
      getCloudProviderConnection: vi.fn(),
      getGitHubConnection: vi.fn(),
      cloudSessionOperation: vi.fn(),
      cloudOperationStatus: vi.fn(),
    },
    sdkHost: { sharedList: vi.fn() },
  },
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: { byLocation: new Map(), loaded: true, load: vi.fn() },
}));
vi.mock('@renderer/features/locations/stores/location-selectors', () => ({
  getLocationManagerStore: () => ({ locations: new Map() }),
}));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionManagerStore: vi.fn(),
}));
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    roomsFor: () => [],
    isLoading: () => false,
    errorFor: roomError,
    fetchAgentRooms,
  },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { activeServerId: 'server' },
}));
vi.mock('@renderer/features/switch-servers/use-cloud-launches', () => ({
  useCloudLaunches: () => ({ data: launches, isLoading: false }),
}));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useNavigate: () => ({ navigate }) }));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation: {} },
  sidebarStore: { setCloudSessionName: vi.fn() },
}));
vi.mock('@renderer/utils/logger', () => ({ log: { error: vi.fn() } }));
vi.mock('@renderer/lib/ui/dialog', () => ({
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogContentArea: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
}));
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});
async function render(children: ReactNode) {
  await act(async () =>
    root.render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)
  );
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.trim().startsWith(text)
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it('keeps the provider controls available when GitHub needs a new sign-in', async () => {
  vi.mocked(rpc.switchServers.getCloudProviderConnection).mockResolvedValue({
    status: 'not_connected',
  } as never);
  vi.mocked(rpc.switchServers.getGitHubConnection).mockRejectedValue(new Error('Reconnect GitHub'));
  const connect = vi.fn();
  await render(
    <CloudAgentRepository
      serverId="server"
      providerId="claude"
      onProviderChange={vi.fn()}
      onSelection={vi.fn()}
      onConnectProvider={vi.fn()}
      onConnectGitHub={connect}
    />
  );
  await expect.poll(() => container.textContent).toContain('Not connected');
  expect(container.querySelector('[aria-label="Connect Claude Code"]')).not.toBeNull();
  await click('Reconnect GitHub');
  expect(connect).toHaveBeenCalledOnce();
});

it('starts a new identity only when the earlier operation is known to have failed', async () => {
  vi.mocked(rpc.switchServers.cloudSessionOperation)
    .mockResolvedValueOnce({ state: 'failed', error: 'The queued request was cancelled.' } as never)
    .mockResolvedValueOnce({ state: 'applied' } as never);
  await render(
    <CreateSessionModal
      onSuccess={vi.fn()}
      cloudRequestId="launch"
      entryPoint={'sidebar' as never}
      onClose={vi.fn()}
    />
  );
  await click('Spawn');
  expect(container.textContent).toContain('Retry to start a new request');
  await click('Spawn');
  const calls = vi.mocked(rpc.switchServers.cloudSessionOperation).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0]![2].session_id).not.toBe(calls[1]![2].session_id);
  expect(navigate).toHaveBeenCalledWith(
    'cloudSession',
    expect.objectContaining({ sessionId: calls[1]![2].session_id })
  );
});

it('opens the same identity after an unknown start and clears it when the agent changes', async () => {
  vi.mocked(rpc.switchServers.cloudSessionOperation).mockResolvedValue({
    state: 'unknown',
    error: null,
  } as never);
  vi.mocked(rpc.sdkHost.sharedList).mockResolvedValue([]);
  const close = vi.fn();
  await render(
    <CreateSessionModal
      onSuccess={vi.fn()}
      cloudRequestId="launch"
      entryPoint={'sidebar' as never}
      onClose={close}
    />
  );
  await click('Spawn');
  expect(rpc.sdkHost.sharedList).toHaveBeenCalledWith('server');
  const id = vi.mocked(rpc.switchServers.cloudSessionOperation).mock.calls[0]![2].session_id;
  await click('Open session');
  expect(navigate).toHaveBeenCalledWith('cloudSession', expect.objectContaining({ sessionId: id }));
  expect(rpc.switchServers.cloudSessionOperation).toHaveBeenCalledOnce();
  await render(
    <CreateSessionModal
      onSuccess={vi.fn()}
      cloudRequestId="other-launch"
      entryPoint={'sidebar' as never}
      onClose={close}
    />
  );
  expect(container.textContent).not.toContain('Open session');
});

it('shows a failed room refresh and retries instead of claiming there are no memberships', async () => {
  roomError.mockReturnValue('Could not load room membership.');
  await render(
    <CreateSessionModal
      onSuccess={vi.fn()}
      cloudRequestId="launch"
      entryPoint={'sidebar' as never}
      onClose={vi.fn()}
    />
  );
  expect(container.textContent).toContain('Could not load room membership.');
  expect(container.textContent).not.toContain("This agent isn't a member of any rooms yet.");
  fetchAgentRooms.mockClear();
  await click('Retry');
  expect(fetchAgentRooms).toHaveBeenCalledWith('server', 'agent', { force: true });
});

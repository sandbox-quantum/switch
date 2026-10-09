/**
 * The owner's cloud machine is shown above the grid on Your Agents, and its
 * card stops the machine only once the owner confirms.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';

const switchServers = vi.hoisted(() => ({
  cloudMachines: vi.fn(),
  cloudMachineLifecycle: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers },
}));

vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: { agentsOnServer: () => [] },
}));

vi.mock('@renderer/features/sidebar/sidebar-tree-data', () => ({
  refreshSidebarRoomState: async () => {},
  refreshSidebarRoomStateAfterOnboarding: async () => {},
}));

vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: { workspacesNotSignedIn: [], roomNameById: () => null },
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { servers: [], statusFor: () => null, isConnected: () => false },
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate }),
  useParams: () => ({ params: { serverId: 'server' } }),
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: () => () => {},
}));

vi.mock('@renderer/lib/stores/use-remote-agents', () => ({
  useAgentIconUrl: () => null,
}));

import { serverAgentsView } from '@renderer/features/switch-servers/server-agents-view';

function sleepingMachine(): CloudMachine {
  return {
    machine_id: '3f1c2b4a-0000-4000-8000-000000000001',
    state: 'stopped',
    desired_state: 'stopped',
    stop_reason: 'idle',
    sleeping: true,
    revision: 5,
    instance_type: 'c7i.2xlarge',
    error: null,
    error_code: null,
    retain_until: null,
    heartbeat_at: '2026-01-01T00:00:00Z',
    disk: { total_bytes: 214748364800, available_bytes: 204010946560 },
    memory: { total_bytes: 17179869184, available_bytes: 12884901888 },
    agents: ['00000000-0000-4000-8000-000000000001'],
    controller_id: null,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  navigate.mockReset();
  switchServers.cloudMachines.mockReset();
  switchServers.cloudMachineLifecycle.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
}

async function render(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const Panel = serverAgentsView.MainPanel;
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Panel />
      </QueryClientProvider>
    )
  );
  await settle();
  return container;
}

function button(el: HTMLElement, name: RegExp): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

it.each([
  ['stopped', sleepingMachine()],
  ['stopping', { ...sleepingMachine(), state: 'stopping' } satisfies CloudMachine],
])('shows the machine card for a sleeping machine (%s)', async (_state, machine) => {
  switchServers.cloudMachineLifecycle.mockResolvedValue(machine);
  switchServers.cloudMachines.mockResolvedValue([machine]);
  const el = await render();

  expect(el.textContent).toMatch(/Cloud machine/);
  expect(el.textContent).toMatch(/Sleeping · c7i\.2xlarge · 1 agent/);
  expect(el.textContent).toMatch(/190\.0 GB free of 200\.0 GB/);
  expect(button(el, /start machine/i)).toBeDefined();
  expect(button(el, /stop machine/i)).toBeDefined();
});

it('stops a ready machine once confirmed', async () => {
  const machine = {
    ...sleepingMachine(),
    state: 'ready',
    desired_state: 'running',
    stop_reason: null,
    sleeping: false,
  } satisfies CloudMachine;
  switchServers.cloudMachineLifecycle.mockResolvedValue(machine);
  switchServers.cloudMachines.mockResolvedValue([machine]);
  const el = await render();

  expect(el.textContent).toMatch(/Ready · c7i\.2xlarge · 1 agent/);
  expect(button(el, /start machine/i)).toBeUndefined();

  await act(async () => button(el, /stop machine/i)!.click());
  expect(el.textContent).toMatch(/mentions will not wake it/);
  expect(switchServers.cloudMachineLifecycle).not.toHaveBeenCalled();
  await act(async () => button(el, /stop machine/i)!.click());
  expect(switchServers.cloudMachineLifecycle).toHaveBeenCalledWith(
    'server',
    machine.machine_id,
    'stop',
    5
  );
});

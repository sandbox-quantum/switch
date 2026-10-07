/**
 * A cloud agent is a managed agent placed on its cloud machine's controller, so
 * Your Agents shows it once, as its managed agent card. The machine card above
 * the grid stops the machine only once the owner confirms.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CloudAgent, CloudMachine } from '@shared/core/cloud-agents/cloud-agents';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';

const sdkHost = vi.hoisted(() => ({
  cloudAgents: vi.fn(),
  cloudMachines: vi.fn(),
}));
const switchServers = vi.hoisted(() => ({
  cloudMachineLifecycle: vi.fn(),
}));
const managedAgents = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { sdkHost, switchServers, managedAgents },
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
  switchServersStore: { servers: [], statusFor: () => null, isConnected: () => true },
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: () => {} }),
  useParams: () => ({ params: { serverId: 'server' } }),
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: () => () => {},
}));

vi.mock('@renderer/lib/stores/use-remote-agents', () => ({
  useAgentIconUrl: () => null,
}));

import { runInAction } from 'mobx';
import { serverAgentsView } from '@renderer/features/switch-servers/server-agents-view';
import { switchCloudFeature } from '@renderer/features/switch-servers/switch-cloud-feature';

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
    controller_id: 'cloud-controller',
    disk: { total_bytes: 214748364800, available_bytes: 204010946560 },
    memory: { total_bytes: 17179869184, available_bytes: 12884901888 },
    agents: ['agent'],
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function setCloudEnabled(enabled: boolean): void {
  runInAction(() => {
    switchCloudFeature.enabled = enabled;
  });
}

beforeEach(() => {
  setCloudEnabled(true);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  sdkHost.cloudAgents.mockReset();
  sdkHost.cloudAgents.mockResolvedValue([]);
  sdkHost.cloudMachines.mockReset();
  sdkHost.cloudMachines.mockResolvedValue(null);
  switchServers.cloudMachineLifecycle.mockReset();
  managedAgents.list.mockReset();
  managedAgents.list.mockResolvedValue(null);
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

function cloudAgentOn(machine: CloudMachine): CloudAgent {
  return {
    key: 'cloud:server:agent=agent',
    agentId: 'agent',
    name: 'reviewer',
    provider: 'claude',
    machine,
    controller: {
      controllerId: 'cloud-controller',
      desiredState: 'running',
      process: 'running',
      detail: null,
    },
    sessions: null,
    problem: null,
  };
}

function managedCloudAgent(): ManagedAgentView {
  return {
    serverId: 'server',
    workspaceId: 'workspace',
    agentId: 'agent',
    name: 'reviewer',
    displayName: null,
    iconUrl: null,
    description: '',
    machine: { id: 'cloud-controller', name: 'Cloud machine', kind: 'ec2', state: 'online' },
    desiredState: 'running',
    revision: 1,
    definition: {
      provider: 'claude',
      model: null,
      advancedConfig: {},
      instructions: '',
      autoApprove: false,
      directory: null,
      isolation: 'shared',
    },
    status: null,
  };
}

it('shows a cloud agent once, as its managed agent', async () => {
  const machine = sleepingMachine();
  sdkHost.cloudAgents.mockResolvedValue([cloudAgentOn(machine)]);
  sdkHost.cloudMachines.mockResolvedValue([machine]);
  managedAgents.list.mockResolvedValue([managedCloudAgent()]);
  const el = await render();

  expect(el.querySelectorAll('[aria-label="Open reviewer"]')).toHaveLength(1);
  expect(el.querySelector('[aria-label="reviewer actions"]')).toBeNull();
  expect(button(el, /new session/i)).toBeUndefined();
});

it('shows no cloud agent, machine card or Connections while Switch Cloud is turned off', async () => {
  setCloudEnabled(false);
  const machine = sleepingMachine();
  sdkHost.cloudAgents.mockResolvedValue([cloudAgentOn(machine)]);
  sdkHost.cloudMachines.mockResolvedValue([machine]);
  managedAgents.list.mockResolvedValue([managedCloudAgent()]);
  const el = await render();

  expect(el.querySelector('[aria-label="Open reviewer"]')).toBeNull();
  expect(el.textContent).not.toMatch(/Cloud machine/);
  expect(button(el, /connections/i)).toBeUndefined();
  expect(button(el, /start machine/i)).toBeUndefined();
  expect(sdkHost.cloudAgents).not.toHaveBeenCalled();
  expect(sdkHost.cloudMachines).not.toHaveBeenCalled();
});

it.each([
  ['stopped', sleepingMachine()],
  ['stopping', { ...sleepingMachine(), state: 'stopping' } satisfies CloudMachine],
])('shows the machine card for a sleeping machine (%s)', async (_state, machine) => {
  switchServers.cloudMachineLifecycle.mockResolvedValue(machine);
  sdkHost.cloudMachines.mockResolvedValue([machine]);
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
  sdkHost.cloudMachines.mockResolvedValue([machine]);
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

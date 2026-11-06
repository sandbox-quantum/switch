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
  sharedCloudAgents: vi.fn(),
}));
const flags = vi.hoisted(() => ({
  service_connections: true,
  hosted_agents: false,
  hosted_v2: false,
}));
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: {
    switchServers,
    userChanges: { watch: async () => false, unwatch: async () => {} },
    featureFlags: {
      get: async () => ({ success: true, data: { flags: { ...flags } } }),
    },
  },
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
    room: null,
    awake: null,
    ai_calls_today: null,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  navigate.mockReset();
  switchServers.cloudMachines.mockReset();
  switchServers.cloudMachineLifecycle.mockReset();
  switchServers.sharedCloudAgents.mockReset();
  switchServers.sharedCloudAgents.mockResolvedValue(null);
  flags.hosted_agents = false;
  flags.hosted_v2 = false;
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

it("shows a shared-cloud user's own box as Your cloud, with Repair and no machine controls", async () => {
  // A real v2 server: Core says hosted_v2, the box's backend is `box`, and the shared-cloud list answers.
  flags.hosted_agents = true;
  flags.hosted_v2 = true;
  switchServers.sharedCloudAgents.mockResolvedValue([]);
  const box = {
    ...sleepingMachine(),
    state: 'ready',
    desired_state: 'running',
    stop_reason: null,
    sleeping: false,
    instance_type: null,
    controller_id: 'c-box',
    room: { used_bytes: 2 * 1024 ** 3, total_bytes: 8 * 1024 ** 3 },
    awake: { running: 1, max: 4 },
    repair_available: true,
    backend: 'box',
  } satisfies CloudMachine;
  switchServers.cloudMachines.mockResolvedValue([box]);
  const el = await render();
  await settle();

  expect(switchServers.sharedCloudAgents).toHaveBeenCalled();
  expect(el.textContent).toMatch(/Your cloud/);
  expect(el.textContent).not.toMatch(/Cloud machine/);
  // Your cloud's rows: memory from `room`, awake out of the limit, and the disk only
  // once the box marks it as the workspace disk (this one doesn't).
  expect(el.textContent).toMatch(/1 hosted agent/);
  expect(el.textContent).toMatch(/Memory: 2\.0 GB of 8\.0 GB/);
  expect(el.textContent).toMatch(/Agents awake: 1 of 4/);
  expect(el.textContent).toMatch(/Disk: not available/);
  expect(el.textContent).not.toMatch(/free of/);
  expect(el.textContent).not.toMatch(/Room to work/);
  expect(button(el, /Repair my cloud/)).toBeDefined();
  expect(button(el, /start machine/i)).toBeUndefined();
  expect(button(el, /stop machine/i)).toBeUndefined();
});

it('a box with no agent yet says how to start, in the PM’s words; with v2 off it says nothing new', async () => {
  flags.hosted_agents = true;
  flags.hosted_v2 = true;
  switchServers.sharedCloudAgents.mockResolvedValue([]);
  const empty = {
    ...sleepingMachine(),
    state: 'ready',
    desired_state: 'running',
    stop_reason: null,
    sleeping: false,
    instance_type: null,
    controller_id: 'c-box',
    agents: [],
    backend: 'box',
  } satisfies CloudMachine;
  switchServers.cloudMachines.mockResolvedValue([empty]);
  let el = await render();
  await settle();
  expect(el.textContent).toContain('Add your first agent on Switch cloud');
  await act(async () => root!.unmount());
  container?.remove();

  flags.hosted_v2 = false;
  el = await render();
  await settle();
  expect(el.textContent).not.toContain('Add your first agent on Switch cloud');
});

it('says a paused box is paused by Switch, and offers no start', async () => {
  flags.hosted_agents = true;
  flags.hosted_v2 = true;
  const paused = {
    ...sleepingMachine(),
    stop_reason: 'paused',
    sleeping: false,
    backend: 'box',
  } satisfies CloudMachine;
  switchServers.cloudMachineLifecycle.mockResolvedValue(paused);
  switchServers.cloudMachines.mockResolvedValue([paused]);
  const el = await render();

  expect(el.textContent).toMatch(/Paused by Switch · Contact your admin/);
  expect(el.textContent).not.toMatch(/Your cloud: Ready/);
  expect(button(el, /start machine/i)).toBeUndefined();
});

// The v1/v2 switch: the v2 card shows only with Core's hosted_v2 on and a box backend.
function v2Box(): CloudMachine {
  return {
    ...sleepingMachine(),
    state: 'ready',
    desired_state: 'running',
    stop_reason: null,
    sleeping: false,
    instance_type: null,
    controller_id: 'c-box',
    room: { used_bytes: 2 * 1024 ** 3, total_bytes: 8 * 1024 ** 3 },
    awake: { running: 1, max: 4 },
    repair_available: true,
    backend: 'box',
  };
}

it('with hosted_v2 off, shows every cloud machine as upstream: no Your cloud, figures or Repair', async () => {
  flags.hosted_agents = true;
  flags.hosted_v2 = false;
  switchServers.sharedCloudAgents.mockResolvedValue([]);
  switchServers.cloudMachines.mockResolvedValue([v2Box()]);
  const el = await render();
  await settle();

  // Off: the shared-cloud service isn't even asked.
  expect(switchServers.sharedCloudAgents).not.toHaveBeenCalled();
  expect(el.textContent).toMatch(/Cloud machine/);
  expect(el.textContent).not.toMatch(/Your cloud/);
  expect(el.textContent).not.toMatch(/Room to work/);
  expect(el.textContent).not.toMatch(/awake/);
  expect(button(el, /Repair my cloud/)).toBeUndefined();
  expect(button(el, /stop machine/i)).toBeDefined();
});

it('with hosted_v2 off, a sleeping or paused machine shows no v2 wording', async () => {
  flags.hosted_agents = true;
  switchServers.cloudMachines.mockResolvedValue([
    { ...sleepingMachine(), stop_reason: 'paused', sleeping: false, backend: 'box' },
  ]);
  const el = await render();

  expect(el.textContent).not.toMatch(/Paused by Switch/);
  expect(el.textContent).not.toMatch(/Resting/);
  expect(el.textContent).toMatch(/Cloud machine/);
});

it("with hosted_v2 on, a v1 machine (Core's backend vm) stays a cloud machine", async () => {
  flags.hosted_agents = true;
  flags.hosted_v2 = true;
  switchServers.sharedCloudAgents.mockResolvedValue([]);
  switchServers.cloudMachines.mockResolvedValue([{ ...v2Box(), backend: 'vm' }]);
  const el = await render();
  await settle();

  expect(el.textContent).toMatch(/Cloud machine/);
  expect(el.textContent).not.toMatch(/Your cloud/);
  expect(button(el, /Repair my cloud/)).toBeUndefined();
});

it('with hosted_v2 on but no backend from Core, shows the v1 card: no fallback to a guess', async () => {
  flags.hosted_agents = true;
  flags.hosted_v2 = true;
  switchServers.sharedCloudAgents.mockResolvedValue([]);
  const { backend: _omit, ...noBackend } = v2Box();
  switchServers.cloudMachines.mockResolvedValue([noBackend]);
  const el = await render();
  await settle();

  expect(el.textContent).toMatch(/Cloud machine/);
  expect(el.textContent).not.toMatch(/Your cloud/);
  expect(el.textContent).not.toMatch(/Room to work/);
  expect(button(el, /Repair my cloud/)).toBeUndefined();
});

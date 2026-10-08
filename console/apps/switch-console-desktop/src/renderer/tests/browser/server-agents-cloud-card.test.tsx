/**
 * A cloud agent's card on Your Agents reads the same start attempt as the
 * sidebar: while a new session is being started the card says so, and a start
 * whose reply was lost is shown as not yet known, with Check again (the same
 * session, never a second one) or, once the session exists, Open.
 *
 * The card reads the machine before the launch, and the machine card above the
 * grid stops the machine only once the owner confirms.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CloudAgent, CloudMachine } from '@shared/core/cloud-agents/cloud-agents';
import { RpcError, serializeRpcError } from '@shared/lib/ipc/rpc-error';

const sdkHost = vi.hoisted(() => ({
  cloudAgents: vi.fn(),
  cloudMachines: vi.fn(),
  cloudSessions: vi.fn(),
  cloudSessionOperation: vi.fn(),
}));
const switchServers = vi.hoisted(() => ({
  cloudLifecycle: vi.fn(),
  cloudMachineLifecycle: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { sdkHost, switchServers },
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

import {
  cloudOperationAttempts,
  startAttemptKey,
} from '@renderer/features/cloud-agents/cloud-operation-attempts';
import { serverAgentsView } from '@renderer/features/switch-servers/server-agents-view';

const agentKey = 'cloud:server:00000000-0000-4000-8000-000000000001';

function agent(): CloudAgent {
  return {
    key: agentKey,
    launch: {
      request_id: '00000000-0000-4000-8000-000000000001',
      name: 'reviewer',
      provider: 'claude',
      state: 'ready',
      desired_state: 'running',
      revision: 4,
      agent_id: 'agent',
      error: null,
      error_code: null,
      sleeping: false,
      machine_id: null,
      process_state: null,
      process_restarts: 0,
      oom_kills: 0,
    },
    machine: null,
    sessions: null,
    problem: null,
  };
}

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
    runtime: 'worker',
    controller_id: null,
  };
}

function sessions(sessionIds: string[]) {
  return {
    sessions: sessionIds.map(
      (sessionId) => ({ sessionId, status: 'ready', connectivity: 'online' }) as never
    ),
    problem: null,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  navigate.mockReset();
  sdkHost.cloudAgents.mockReset();
  sdkHost.cloudMachines.mockReset();
  sdkHost.cloudMachines.mockResolvedValue(null);
  switchServers.cloudLifecycle.mockReset();
  switchServers.cloudMachineLifecycle.mockReset();
  sdkHost.cloudSessions.mockReset();
  sdkHost.cloudSessionOperation.mockReset();
  cloudOperationAttempts.settle(startAttemptKey(agentKey));
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

it('shows a start in progress and does not offer a second one', async () => {
  let reply: (outcome: unknown) => void = () => {};
  sdkHost.cloudSessionOperation.mockImplementation(
    () => new Promise((resolve) => (reply = resolve))
  );
  sdkHost.cloudAgents.mockResolvedValue([agent()]);
  const el = await render();
  await act(async () => button(el, /new session/i)!.click());

  const starting = button(el, /starting session/i);
  expect(starting?.disabled).toBe(true);
  expect(button(el, /new session/i)).toBeUndefined();

  await act(async () => reply({ state: 'applied' }));
  expect(navigate).toHaveBeenCalledWith('cloudSession', expect.objectContaining({ agentKey }));
});

it('shows a lost reply as not yet known, and asks again for the same session', async () => {
  sdkHost.cloudSessionOperation.mockResolvedValueOnce({ state: 'unknown', message: 'lost' });
  sdkHost.cloudSessionOperation.mockResolvedValueOnce({ state: 'applied' });
  sdkHost.cloudAgents.mockResolvedValue([agent()]);
  sdkHost.cloudSessions.mockResolvedValue(sessions([]));
  const el = await render();
  await act(async () => button(el, /new session/i)!.click());
  await settle();

  expect(el.querySelector('[role="status"]')?.textContent).toMatch(/not yet known/i);
  expect(el.querySelector('[role="alert"]')).toBeNull();
  await act(async () => button(el, /check again/i)!.click());
  const [first, second] = sdkHost.cloudSessionOperation.mock.calls;
  expect(second).toEqual(first);
  expect(navigate).toHaveBeenCalledWith(
    'cloudSession',
    expect.objectContaining({ agentKey, sessionId: first[1] })
  );
});

it('offers Open once the unconfirmed session exists', async () => {
  let started = '';
  sdkHost.cloudSessionOperation.mockImplementation(async (_key: string, sessionId: string) => {
    started = sessionId;
    return { state: 'unknown', message: 'lost' };
  });
  sdkHost.cloudAgents.mockResolvedValue([agent()]);
  sdkHost.cloudSessions.mockResolvedValue(sessions([]));
  const el = await render();
  await act(async () => button(el, /new session/i)!.click());
  await settle();

  sdkHost.cloudSessions.mockResolvedValue(sessions([started]));
  await act(async () => root!.unmount());
  const remounted = await render();
  const open = button(remounted, /^open$/i);
  expect(open).toBeDefined();
  await act(async () => open!.click());
  expect(navigate).toHaveBeenCalledWith(
    'cloudSession',
    expect.objectContaining({ agentKey, sessionId: started })
  );
  expect(sdkHost.cloudSessionOperation).toHaveBeenCalledTimes(1);
});

it('reads a sleeping machine before the launch and offers no session on it', async () => {
  const machine = sleepingMachine();
  sdkHost.cloudAgents.mockResolvedValue([
    { ...agent(), launch: { ...agent().launch, machine_id: machine.machine_id }, machine },
  ]);
  sdkHost.cloudMachines.mockResolvedValue([machine]);
  const el = await render();

  expect(el.textContent).toMatch(/Cloud · Sleeping/);
  expect(button(el, /new session/i)).toBeUndefined();
  expect(button(el, /^remove$/i)).toBeDefined();
});

it('shows a crashed agent with its out-of-memory restarts and offers Retry', async () => {
  const base = agent();
  sdkHost.cloudAgents.mockResolvedValue([
    {
      ...base,
      launch: {
        ...base.launch,
        state: 'error',
        error: 'crashed',
        error_code: 'agent_crashed',
        process_state: 'crashed',
        oom_kills: 2,
      },
    },
  ]);
  const el = await render();

  expect(el.textContent).toMatch(/Restarted after running out of memory 2×/);
  expect(el.textContent).toMatch(/Crashed/);
  expect(el.querySelector('[role="alert"]')?.textContent).toMatch(/keeps crashing/);
  expect(button(el, /^retry$/i)).toBeDefined();
  expect(button(el, /stop agent/i)).toBeUndefined();
  await openMenu(el);
  expect(menuItem('Stop agent')).toBeDefined();
});

async function openMenu(el: HTMLElement): Promise<void> {
  await act(async () => el.querySelector<HTMLElement>('[aria-label="reviewer actions"]')!.click());
}

function menuItem(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
    item.textContent?.startsWith(label)
  );
}

it('stops a running agent from its menu, not from the card', async () => {
  switchServers.cloudLifecycle.mockResolvedValue({});
  sdkHost.cloudAgents.mockResolvedValue([agent()]);
  const el = await render();

  expect(button(el, /stop agent/i)).toBeUndefined();
  await openMenu(el);
  const stop = menuItem('Stop agent');
  expect(stop?.textContent).toMatch(/Stops replies and frees the machine/);
  await act(async () => stop!.click());
  expect(switchServers.cloudLifecycle).toHaveBeenCalledWith(
    'server',
    agent().launch.request_id,
    'stop',
    4
  );
});

it.each([
  ['asleep', sleepingMachine(), false],
  [
    'stopped by its owner',
    { ...sleepingMachine(), stop_reason: 'owner', sleeping: false } satisfies CloudMachine,
    false,
  ],
  [
    'ready',
    {
      ...sleepingMachine(),
      state: 'ready',
      desired_state: 'running',
      stop_reason: null,
      sleeping: false,
    } satisfies CloudMachine,
    true,
  ],
])('offers Stop agent only while its machine is awake: %s', async (_, machine, offered) => {
  const base = agent();
  sdkHost.cloudAgents.mockResolvedValue([
    { ...base, launch: { ...base.launch, machine_id: machine.machine_id }, machine },
  ]);
  sdkHost.cloudMachines.mockResolvedValue([machine]);
  const el = await render();

  await openMenu(el);
  expect(menuItem('Stop agent') !== undefined).toBe(offered);
});

it('offers no Add to rooms on a usable agent', async () => {
  sdkHost.cloudAgents.mockResolvedValue([agent()]);
  const el = await render();

  expect(button(el, /new session/i)).toBeDefined();
  expect(button(el, /add to rooms/i)).toBeUndefined();
});

function actions(el: HTMLElement): string[] {
  return [...el.querySelectorAll('button')]
    .filter((b) => !b.closest('header'))
    .map((b) => b.textContent ?? '')
    .filter(Boolean);
}

it('offers only Retry and Remove for an agent Switch could not register', async () => {
  const base = agent();
  sdkHost.cloudAgents.mockResolvedValue([
    {
      ...base,
      launch: {
        ...base.launch,
        agent_id: null,
        state: 'error',
        error: 'registration failed',
        error_code: 'identity_failed',
      },
      problem: { code: 'worker_not_attached', message: 'error', wakeAvailable: false },
    },
  ]);
  const el = await render();

  expect(el.querySelector('[role="alert"]')?.textContent).toMatch(/could not register/);
  expect(actions(el)).toEqual(['Retry', 'Remove']);
});

it.each([
  [
    'agent_key_missing',
    /lost this agent’s credential.*Remove the agent and create it again/,
    false,
  ],
  ['agent_identity_missing', /lost this agent’s identity\. Retry/, true],
  ['worker_attach_timeout', /did not connect to Switch/, true],
  ['agent_stop_timeout', /did not stop in time/, true],
])('explains a launch in error with %s', async (code, text, retry) => {
  const base = agent();
  sdkHost.cloudAgents.mockResolvedValue([
    {
      ...base,
      launch: { ...base.launch, state: 'error', error: 'from the server', error_code: code },
      problem: { code: 'worker_not_attached', message: 'error', wakeAvailable: false },
    },
  ]);
  const el = await render();

  expect(el.querySelector('[role="alert"]')?.textContent).toMatch(text);
  expect(button(el, /^retry$/i) !== undefined).toBe(retry);
});

it('says to start the machine when a retry is refused because its owner stopped it', async () => {
  const machine = {
    ...sleepingMachine(),
    stop_reason: 'owner',
    sleeping: false,
  } satisfies CloudMachine;
  const base = agent();
  sdkHost.cloudAgents.mockResolvedValue([
    {
      ...base,
      launch: {
        ...base.launch,
        machine_id: machine.machine_id,
        state: 'error',
        error: 'from the server',
        error_code: 'worker_attach_timeout',
      },
      machine,
    },
  ]);
  sdkHost.cloudMachines.mockResolvedValue([machine]);
  switchServers.cloudLifecycle.mockRejectedValue(
    new RpcError(
      serializeRpcError(
        Object.assign(new Error('Switch gateway returned 409'), {
          name: 'GatewayError',
          kind: 'http',
          status: 409,
          detail: 'The owner stopped the cloud machine. Start it in Switch Console.',
          code: 'machine_stopped',
        })
      )
    )
  );
  const el = await render();

  await act(async () => button(el, /^retry$/i)!.click());
  await settle();
  expect(el.textContent).toMatch(
    /The owner stopped the cloud machine\. Start the machine, then try again\./
  );
});

it('offers only Remove for a removal left halfway', async () => {
  const base = agent();
  sdkHost.cloudAgents.mockResolvedValue([
    {
      ...base,
      launch: { ...base.launch, state: 'deleting', desired_state: 'deleted' },
      problem: { code: 'worker_not_attached', message: 'removing', wakeAvailable: false },
    },
  ]);
  const el = await render();

  expect(el.textContent).toMatch(/Cloud · Removing…/);
  expect(actions(el)).toEqual(['Remove']);
});

it('shows a stopped agent on a sleeping machine as stopped', async () => {
  const machine = sleepingMachine();
  const base = agent();
  sdkHost.cloudAgents.mockResolvedValue([
    {
      ...base,
      launch: {
        ...base.launch,
        machine_id: machine.machine_id,
        desired_state: 'stopped',
        state: 'stopped',
        sleeping: true,
      },
      machine,
    },
  ]);
  const el = await render();

  expect(el.textContent).toMatch(/Cloud · Stopped/);
  expect(button(el, /start agent/i)).toBeDefined();
  await openMenu(el);
  expect(menuItem('Stop agent')).toBeUndefined();
});

it('removes a running agent once confirmed', async () => {
  switchServers.cloudLifecycle.mockResolvedValue({});
  sdkHost.cloudAgents.mockResolvedValue([agent()]);
  const el = await render();

  await act(async () => button(el, /^remove$/i)!.click());
  expect(el.textContent).toMatch(/Its working copy on the cloud machine is\s+deleted right away/);
  expect(el.textContent).toMatch(/the machine shuts down and its disk is kept/);
  expect(switchServers.cloudLifecycle).not.toHaveBeenCalled();
  await act(async () => button(el, /remove agent/i)!.click());
  expect(switchServers.cloudLifecycle).toHaveBeenCalledWith(
    'server',
    agent().launch.request_id,
    'remove',
    4
  );
});

it.each([
  ['stopped', sleepingMachine()],
  ['stopping', { ...sleepingMachine(), state: 'stopping' } satisfies CloudMachine],
])('shows the machine card for a sleeping machine (%s)', async (_state, machine) => {
  switchServers.cloudMachineLifecycle.mockResolvedValue(machine);
  sdkHost.cloudAgents.mockResolvedValue([]);
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
  sdkHost.cloudAgents.mockResolvedValue([]);
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

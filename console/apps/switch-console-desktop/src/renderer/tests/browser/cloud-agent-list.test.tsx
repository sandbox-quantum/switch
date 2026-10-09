/**
 * A new cloud session whose start was never confirmed is not shown as a
 * failure: once the session appears, the row offers to open it, and until
 * then it asks again for the same session rather than a new one. A worker is
 * asked for its sessions only while its row is expanded.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CloudAgent, CloudLaunch, CloudMachine } from '@shared/core/cloud-agents/cloud-agents';

const sdkHost = vi.hoisted(() => ({
  cloudAgents: vi.fn(),
  cloudSessions: vi.fn(),
  cloudSessionOperation: vi.fn(),
  cloudWake: vi.fn(),
}));
const expandedCloudGroups = await vi.hoisted(async () => {
  const { observable } = await import('mobx');
  return observable.set<string>();
});
const navigate = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { sdkHost, switchServers: { cloudMachineLifecycle: vi.fn() } },
}));

vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: { workspacesNotSignedIn: [], roomNameById: () => null },
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { activeServerId: 'server', statusFor: () => null },
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate }),
  useParams: () => ({ params: {} }),
}));

vi.mock('@renderer/lib/layout/workspace-slots', () => ({
  useWorkspaceSlots: () => ({ currentView: 'home' }),
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: {
    isCloudGroupExpanded: (key: string) => expandedCloudGroups.has(key),
    toggleCloudGroupExpanded: (key: string) =>
      expandedCloudGroups.has(key) ? expandedCloudGroups.delete(key) : expandedCloudGroups.add(key),
    hideProviderMark: true,
  },
}));

import { CloudAgentList } from '@renderer/features/cloud-agents/cloud-agent-list';
import {
  cloudOperationAttempts,
  startAttemptKey,
} from '@renderer/features/cloud-agents/cloud-operation-attempts';

const agentKey = 'cloud:server:launch';

function agent(key = agentKey, name = 'reviewer'): CloudAgent {
  return {
    key,
    launch: {
      request_id: '00000000-0000-4000-8000-000000000001',
      name,
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
  navigate.mockReset();
  sdkHost.cloudSessionOperation.mockReset();
  sdkHost.cloudSessions.mockReset();
  sdkHost.cloudWake.mockReset();
  expandedCloudGroups.clear();
  cloudOperationAttempts.settle(startAttemptKey(agentKey));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

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
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)));
  return container;
}

function button(el: HTMLElement, name: RegExp): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find(
    (b) => name.test(b.textContent ?? '') || name.test(b.getAttribute('aria-label') ?? '')
  );
}

it('offers Open for an unconfirmed start whose session exists, not an error', async () => {
  let started = '';
  sdkHost.cloudSessionOperation.mockImplementation(async (_key: string, sessionId: string) => {
    started = sessionId;
    return { state: 'unknown', message: 'The server did not confirm the session start.' };
  });
  sdkHost.cloudAgents.mockResolvedValue([agent()]);
  sdkHost.cloudSessions.mockResolvedValue(sessions([]));
  const el = await render();
  await act(async () => button(el, /new session/i)!.click());
  expect(el.querySelector('[role="alert"]')).toBeNull();
  expect(button(el, /check again/i)).toBeDefined();

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

it('asks again for the same session from Check again', async () => {
  sdkHost.cloudSessionOperation.mockResolvedValueOnce({ state: 'unknown', message: 'lost' });
  sdkHost.cloudSessionOperation.mockResolvedValueOnce({ state: 'applied' });
  sdkHost.cloudAgents.mockResolvedValue([agent()]);
  sdkHost.cloudSessions.mockResolvedValue(sessions([]));
  const el = await render();
  await act(async () => button(el, /new session/i)!.click());
  await act(async () => button(el, /check again/i)!.click());
  const [first, second] = sdkHost.cloudSessionOperation.mock.calls;
  expect(second).toEqual(first);
  expect(navigate).toHaveBeenCalledWith(
    'cloudSession',
    expect.objectContaining({ sessionId: first[1] })
  );
});

it('asks no worker while its row is collapsed, and one when that row is expanded', async () => {
  const other = 'cloud:server:other';
  sdkHost.cloudAgents.mockResolvedValue([agent(), agent(other, 'writer')]);
  sdkHost.cloudSessions.mockResolvedValue(sessions(['s1']));
  const el = await render();
  expect(sdkHost.cloudAgents).toHaveBeenCalled();
  expect(sdkHost.cloudSessions).not.toHaveBeenCalled();

  const row = [...el.querySelectorAll('button[aria-expanded]')].find((b) =>
    b.textContent?.includes('writer')
  ) as HTMLButtonElement;
  await act(async () => row.click());
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)));
  expect(sdkHost.cloudSessions).toHaveBeenCalledTimes(1);
  expect(sdkHost.cloudSessions).toHaveBeenCalledWith(other);
  expect(el.textContent).toContain('Session s1');
});

it('keeps a cloud row expanded after remount', async () => {
  const other = 'cloud:server:other';
  sdkHost.cloudAgents.mockResolvedValue([agent(), agent(other, 'writer')]);
  sdkHost.cloudSessions.mockResolvedValue(sessions(['s1']));
  const el = await render();

  const row = [...el.querySelectorAll('button[aria-expanded]')].find((b) =>
    b.textContent?.includes('writer')
  ) as HTMLButtonElement;
  await act(async () => row.click());
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)));

  await act(async () => root!.unmount());
  const remounted = await render();
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)));
  expect(sdkHost.cloudSessions).toHaveBeenCalled();
  expect(remounted.textContent).toContain('Session s1');
});

it('labels no session the next message restarts, but still a stopped or working one', async () => {
  sdkHost.cloudAgents.mockResolvedValue([agent()]);
  sdkHost.cloudSessions.mockResolvedValue({
    sessions: [
      { sessionId: 'down', status: 'ready', connectivity: 'offline' },
      { sessionId: 'done', status: 'stopped', connectivity: 'offline' },
      { sessionId: 'busy', status: 'running', connectivity: 'online' },
    ] as never,
    problem: null,
  });
  const el = await render();
  await act(async () => button(el, /reviewer/i)!.click());
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)));
  expect(button(el, /Session down/)!.textContent).toBe('Session down');
  expect(button(el, /Session done/)!.textContent).toBe('Session donestopped');
  expect(button(el, /Session busy/)!.textContent).toBe('Session busyrunning');
  expect(el.textContent).not.toMatch(/offline/i);
});

function asleep(overrides: Partial<CloudAgent['launch']>, wakeAvailable: boolean): CloudAgent {
  return {
    ...agent(),
    launch: { ...agent().launch, ...overrides },
    problem: { code: 'worker_sleeping', message: 'The cloud machine is asleep.', wakeAvailable },
  };
}

it('wakes a sleeping agent’s machine from the list', async () => {
  sdkHost.cloudAgents.mockResolvedValue([asleep({}, true)]);
  sdkHost.cloudWake.mockResolvedValue(undefined);
  const el = await render();
  expect(el.textContent).not.toContain('Send a message to wake it.');
  await act(async () => button(el, /^wake$/i)!.click());
  expect(sdkHost.cloudWake).toHaveBeenCalledWith(agentKey);
});

it('says once that the machine its agents share is asleep, not under each agent', async () => {
  const other = 'cloud:server:other';
  sdkHost.cloudAgents.mockResolvedValue([
    { ...asleep({ desired_state: 'stopped', state: 'stopped' }, false), key: other },
    asleep({}, true),
  ]);
  sdkHost.cloudWake.mockResolvedValue(undefined);
  expandedCloudGroups.add(`cloud:${agentKey}`);
  expandedCloudGroups.add(`cloud:${other}`);
  const el = await render();
  expect(
    [...el.querySelectorAll('button')].filter((b) => /^wake$/i.test(b.textContent ?? ''))
  ).toHaveLength(1);
  await act(async () => button(el, /^wake$/i)!.click());
  expect(sdkHost.cloudWake).toHaveBeenCalledWith(agentKey);
});

it('still says under the agent why only that agent cannot be asked', async () => {
  sdkHost.cloudAgents.mockResolvedValue([
    {
      ...onMachine({}, { process_state: 'crashed', error_code: 'agent_crashed' }),
      problem: { code: 'agent_crashed', message: 'The agent crashed.', wakeAvailable: false },
    },
  ]);
  const el = await render();
  expect(el.textContent).not.toContain('(agent_crashed)');
  expandedCloudGroups.add(`cloud:${agentKey}`);
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)));
  expect(el.textContent).toContain('crashed');
  expect(el.textContent).not.toContain('(agent_crashed)');
});

it('offers no wake for a stopped agent on a sleeping machine', async () => {
  sdkHost.cloudAgents.mockResolvedValue([
    asleep({ desired_state: 'stopped', state: 'stopped' }, false),
  ]);
  expandedCloudGroups.add(`cloud:${agentKey}`);
  const el = await render();
  expect(el.textContent).toContain('asleep');
  expect(el.textContent).not.toContain('wake it');
  expect(button(el, /^wake$/i)).toBeUndefined();
});

function onMachine(machine: Partial<CloudMachine>, launch: Partial<CloudLaunch> = {}): CloudAgent {
  return {
    ...agent(),
    launch: { ...agent().launch, machine_id: 'machine', ...launch },
    machine: {
      machine_id: 'machine',
      state: 'ready',
      desired_state: 'running',
      stop_reason: null,
      sleeping: false,
      revision: 2,
      instance_type: null,
      error: null,
      error_code: null,
      retain_until: null,
      heartbeat_at: null,
      disk: null,
      memory: null,
      agents: [],
      runtime: 'worker',
      controller_id: null,
      ...machine,
    },
  };
}

it.each([
  [
    'stopped by its owner',
    {
      ...onMachine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'owner' }),
      problem: {
        code: 'machine_stopped',
        message: 'The owner stopped the cloud machine.',
        wakeAvailable: false,
      },
    },
  ],
  [
    'asleep',
    {
      ...onMachine({
        state: 'stopped',
        desired_state: 'stopped',
        stop_reason: 'idle',
        sleeping: true,
      }),
      problem: {
        code: 'worker_sleeping',
        message: 'The cloud machine is asleep.',
        wakeAvailable: true,
      },
    },
  ],
])(
  'lists the stored sessions on a cold start while the machine is %s, with nothing cached',
  async (_name, down) => {
    sdkHost.cloudAgents.mockResolvedValue([
      { ...down, sessions: sessions(['b4105d35-0000']).sessions },
    ]);
    expandedCloudGroups.add(`cloud:${agentKey}`);
    const el = await render();
    expect(sdkHost.cloudSessions).not.toHaveBeenCalled();
    const session = button(el, /Session b4105d35/);
    expect(session).toBeDefined();
    await act(async () => session!.click());
    expect(navigate).toHaveBeenCalledWith(
      'cloudSession',
      expect.objectContaining({ agentKey, sessionId: 'b4105d35-0000' })
    );
  }
);

it('says the agent is starting when only its launch starts on a running machine', async () => {
  sdkHost.cloudAgents.mockResolvedValue([
    {
      ...onMachine({}, { state: 'provisioning', process_state: 'starting' }),
      problem: {
        code: 'worker_waking',
        message: 'The cloud machine is starting.',
        wakeAvailable: false,
      },
    },
  ]);
  expandedCloudGroups.add(`cloud:${agentKey}`);
  const el = await render();
  expect(el.textContent).toContain('starting…');
  expect(el.textContent).toContain('The agent is starting.');
  expect(el.textContent).not.toContain('waking…');
  expect(el.textContent).not.toContain('The cloud machine is starting.');
});

it('says the machine is starting while the machine itself wakes', async () => {
  sdkHost.cloudAgents.mockResolvedValue([
    {
      ...onMachine({ state: 'provisioning' }),
      problem: {
        code: 'worker_waking',
        message: 'The cloud machine is starting.',
        wakeAvailable: false,
      },
    },
  ]);
  expandedCloudGroups.add(`cloud:${agentKey}`);
  const el = await render();
  expect(el.textContent).toContain('waking…');
  expect(el.textContent).toContain('The cloud machine is starting.');
  expect(el.textContent).not.toContain('The agent is starting.');
});

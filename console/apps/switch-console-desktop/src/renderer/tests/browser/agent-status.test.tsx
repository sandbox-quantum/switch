import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';

const flags = vi.hoisted(() => ({ hosted_v2: false }));
const box = vi.hoisted(() => ({ onSharedBox: false, calls: 0 }));
const actions = vi.hoisted(() => ({ setDesiredState: vi.fn(), calls: 0 }));

vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({ useFeatureFlags: () => flags }));
vi.mock('@renderer/features/managed-agents/use-managed-agents', () => ({
  useOnSharedCloudBox: () => {
    box.calls += 1;
    return box.onSharedBox;
  },
}));
vi.mock('@renderer/features/managed-agents/use-managed-agent-actions', () => ({
  useManagedAgentActions: () => {
    actions.calls += 1;
    return { busy: false, setDesiredState: actions.setDesiredState };
  },
}));

import '@renderer/index.css';
import { AgentStatus } from '@renderer/features/managed-agents/agent-status';

const STOPPED_ON_CLOUD: ManagedAgentView = {
  serverId: 'server-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  name: 'pm-agent',
  displayName: null,
  iconUrl: null,
  description: '',
  machine: { id: 'machine-1', name: 'Switch cloud', kind: 'ec2', state: 'online' },
  desiredState: 'running',
  revision: 1,
  definition: {
    provider: 'claude',
    model: null,
    advancedConfig: {},
    instructions: '',
    autoApprove: false,
    autoMode: false,
    directory: null,
    isolation: 'shared',
  },
  status: null,
  stopReason: { code: 'login_needed', since: '2026-11-02T08:00:00Z', resetAt: null },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  flags.hosted_v2 = false;
  box.onSharedBox = false;
  box.calls = 0;
  actions.calls = 0;
  actions.setDesiredState.mockReset();
  actions.setDesiredState.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const panel = () => container.querySelector('section[aria-label="Status"]');

it('draws nothing and looks nothing up with hosted_v2 off, even for a stopped agent on a box', async () => {
  box.onSharedBox = true;
  await act(async () => root.render(<AgentStatus agent={STOPPED_ON_CLOUD} />));
  expect(panel()).toBeNull();
  expect(box.calls).toBe(0);
  expect(actions.calls).toBe(0);
});

it('shows the Status panel for a stopped agent on a v2 box', async () => {
  flags.hosted_v2 = true;
  box.onSharedBox = true;
  await act(async () => root.render(<AgentStatus agent={STOPPED_ON_CLOUD} />));
  expect(panel()).not.toBeNull();
});

it('leaves the Status panel out with hosted_v2 on when the machine is not a v2 box', async () => {
  flags.hosted_v2 = true;
  box.onSharedBox = false;
  await act(async () => root.render(<AgentStatus agent={STOPPED_ON_CLOUD} />));
  expect(panel()).toBeNull();
});

it('leaves the Status panel out on a v2 box when the agent has no stop reason', async () => {
  flags.hosted_v2 = true;
  box.onSharedBox = true;
  await act(async () =>
    root.render(<AgentStatus agent={{ ...STOPPED_ON_CLOUD, stopReason: undefined }} />)
  );
  expect(panel()).toBeNull();
});

it('restarts the agent by turning it off and on again, where a restart helps', async () => {
  flags.hosted_v2 = true;
  box.onSharedBox = true;
  const unreachable: ManagedAgentView = {
    ...STOPPED_ON_CLOUD,
    stopReason: { code: 'cant_reach', since: '2026-11-02T08:00:00Z', resetAt: null },
  };
  await act(async () => root.render(<AgentStatus agent={unreachable} />));
  const restart = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Restart agent'
  );
  expect(restart).toBeDefined();
  await act(async () => restart!.click());
  expect(actions.setDesiredState.mock.calls).toEqual([['stopped'], ['running']]);
});

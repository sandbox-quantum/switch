import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';

// The agent's page with hosted agents v2 on (the v1/v2 switch): AgentChats draws the Status panel for a
// stopped agent on a v2 box. Upstream's agent-chats-sections test covers the same page with the switch off.

const flags = vi.hoisted(() => ({ agent_chats: true, service_connections: true, hosted_v2: true }));

/** Stands in for the app's navigation, as upstream's agent-chats-sections test does. */
const navigation = vi.hoisted(() => {
  let params: Record<string, string | undefined> = {};
  const listeners = new Set<() => void>();
  return {
    params: () => params,
    setParams: (update: Record<string, string | undefined>) => {
      params = { ...params, ...update };
      for (const listener of listeners) listener();
    },
    reset: (next: Record<string, string | undefined>) => {
      params = next;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock('@renderer/lib/layout/navigation-provider', async (importOriginal) => {
  const { useSyncExternalStore } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({
      params: useSyncExternalStore(navigation.subscribe, navigation.params),
      setParams: navigation.setParams,
    }),
  };
});
vi.mock('@renderer/lib/hooks/useFeatureFlags', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useFeatureFlags: () => flags,
}));
vi.mock('@renderer/lib/ipc', () => ({ events: { on: () => () => {} }, rpc: {} }));
vi.mock('@renderer/lib/modal/modal-provider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showModal: vi.fn(),
}));
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    watchMembership: () => () => {},
    roomsFor: () => [],
    errorFor: () => null,
    roomNameById: () => undefined,
    roomBridgeTypeById: () => null,
    roomSummaryById: () => undefined,
  },
}));
vi.mock('@renderer/features/managed-agents/use-managed-agents', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRunsOnThisComputer: () => false,
  useOnSharedCloudBox: () => true,
}));
vi.mock('@renderer/features/managed-agents/use-managed-agent-actions', () => ({
  useManagedAgentActions: () => ({ busy: false, setDesiredState: vi.fn() }),
}));
vi.mock('@renderer/features/managed-agents/agent-connections-tab', () => ({
  useAgentServiceGrants: () => ({ data: { grants: [], addressing_open: false } }),
  AgentConnectionsTab: () => null,
}));
vi.mock('@renderer/features/managed-agents/managed-agent-page', () => ({
  ManagedAgentPage: () => null,
}));
vi.mock('@renderer/lib/stores/use-avatar-settings', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAvatarSettings: () => ({ thirdPartyAvatarsEnabled: null, error: null, retry: () => {} }),
}));
vi.mock('@renderer/features/chats/components/chat-panel', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ChatPanel: () => null,
}));

import '@renderer/index.css';
import { AgentChats } from '@renderer/features/managed-agents/agent-chats';

const STOPPED_ON_BOX: ManagedAgentView = {
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
  flags.hosted_v2 = true;
  navigation.reset({ serverId: 'server-1', agentId: 'agent-1', name: 'pm-agent' });
  container = document.createElement('div');
  container.style.width = '1100px';
  container.style.height = '700px';
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const panel = () => container.querySelector('section[aria-label="Status"]');

it('shows the Status panel on the page of a stopped agent on a v2 box, with hosted_v2 on', async () => {
  await act(async () => root.render(<AgentChats agent={STOPPED_ON_BOX} />));
  expect(panel()).not.toBeNull();
});

it('leaves the Status panel off the same page with hosted_v2 off', async () => {
  flags.hosted_v2 = false;
  await act(async () => root.render(<AgentChats agent={STOPPED_ON_BOX} />));
  expect(panel()).toBeNull();
});

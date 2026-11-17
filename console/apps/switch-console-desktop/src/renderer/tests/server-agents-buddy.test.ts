// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { serverAgentsView } from '@renderer/features/switch-servers/server-agents-view';

const state = vi.hoisted(() => ({
  offered: true,
  agents: [] as unknown[] | null | undefined,
  navigate: vi.fn(),
}));
vi.mock('@renderer/lib/ipc', () => ({ events: { on: () => () => {} }, rpc: {} }));
vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ switch_buddy: state.offered, agent_management: true }),
}));
vi.mock('@renderer/features/managed-agents/use-managed-agents', () => ({
  useManagedAgents: () => ({ data: state.agents }),
  withoutManaged: () => [],
  useMachineLabel: () => null,
}));
vi.mock('@renderer/features/cloud-agents/use-cloud-agents', () => ({
  useCloudMachines: () => ({ data: [] }),
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: { agentsOnServer: () => [] },
}));
vi.mock('@renderer/features/sidebar/sidebar-tree-data', () => ({
  refreshSidebarRoomState: () => {},
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { servers: [], statusFor: () => ({ user: { name: 'Viewer' } }) },
}));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: state.navigate }),
  useParams: () => ({ params: { serverId: 's' } }),
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => vi.fn() }));

function view() {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    createElement(serverAgentsView.MainPanel)
  );
}

function render() {
  return renderToStaticMarkup(view());
}

describe('buddy setup on Your Agents', () => {
  it('shows the setup entry after the buddy is deleted', () => {
    state.offered = true;
    state.agents = [];
    const html = render();
    expect(html).toContain('Set up switch-buddy-viewer');
    expect(html).toContain('Not set up');
    expect(html).toContain('Connect an AI provider');
    expect(html).not.toContain('Running');
  });

  it('opens buddy setup from the Set up button', async () => {
    state.offered = true;
    state.agents = [];
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(view()));
      const button = container.querySelector('button[aria-label="Set up switch-buddy-viewer"]');
      expect(button?.parentElement?.closest('button')).toBeNull();
      await act(async () => {
        button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(state.navigate).toHaveBeenCalledWith('switchBuddy', { serverId: 's' });
    } finally {
      act(() => root.unmount());
    }
  });

  it('replaces setup with the real buddy after it is created', () => {
    state.offered = true;
    state.agents = [
      {
        serverId: 's',
        workspaceId: 'w',
        agentId: 'buddy',
        name: 'switch-buddy-viewer',
        displayName: null,
        iconUrl: null,
        description: '',
        machine: null,
        desiredState: 'running',
        revision: 1,
        status: null,
        definition: {
          provider: 'codex',
          model: null,
          advancedConfig: {},
          instructions: '',
          autoMode: true,
          autoApprove: false,
          directory: null,
          isolation: 'shared',
        },
      },
    ];
    const html = render();
    expect(html).toContain('Open switch-buddy-viewer');
    expect(html).not.toContain('Set up switch-buddy');
    expect(html).not.toContain('Connect an AI provider');
  });

  it.each([null, undefined])('waits until agents are known: %s', (agents) => {
    state.offered = true;
    state.agents = agents;
    expect(render()).not.toContain('Set up switch-buddy');
  });

  it('hides the setup entry when the server does not offer buddy', () => {
    state.offered = false;
    state.agents = [];
    expect(render()).not.toContain('Set up switch-buddy');
  });
});

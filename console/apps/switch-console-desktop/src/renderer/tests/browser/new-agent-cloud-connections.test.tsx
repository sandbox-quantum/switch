/**
 * A new Switch cloud agent is created with the connections it was granted, and
 * no repository. GitHub not connected does not stand in the way: the agent is
 * created with no grant, and Connect opens the Connections page in the form.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { runInAction } from 'mobx';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';

const rpc = vi.hoisted(() => ({
  remoteHosts: { listHosts: vi.fn() },
  managedAgents: { machines: vi.fn() },
  agentMigration: { addManagedAgent: vi.fn(), newAgentMachine: vi.fn() },
  switchServers: {
    getConnectionCatalog: vi.fn(),
    getGitHubConnection: vi.fn(),
    ensureCloudMachine: vi.fn(),
  },
  workspaces: { updateAddressingPolicy: vi.fn(), updateCanManageAgents: vi.fn() },
}));
const navigate = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({ events: { on: () => () => {} }, rpc }));
vi.mock('@renderer/lib/components/agent-icon', () => ({ AgentIcon: () => null }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useNavigate: () => ({ navigate }) }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useModalContext: () => ({ setCloseGuard: () => {} }),
  useShowModal: () => () => {},
}));
vi.mock('@renderer/lib/stores/use-workspace-agents', () => ({
  useWorkspaceAgents: () => ({ data: [] }),
}));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: 'claude' }),
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    init: () => Promise.resolve(),
    activeServerId: 'server-1',
    servers: [
      {
        id: 'server-1',
        gatewayUrl: 'https://switch.example',
        apiUrl: 'https://switch.example',
        managed: false,
        managementKind: null,
        sshHost: null,
      },
    ],
  },
}));
vi.mock('@renderer/features/switch-servers/switch-cloud-origin', () => ({
  isSwitchCloudServer: () => false,
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: (id: string | null) => (id ? 'workspace-1' : null) },
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: { load: vi.fn() },
}));
vi.mock('@renderer/features/locations/stores/location-selectors', () => ({
  getLocationManagerStore: vi.fn(),
}));
vi.mock('@renderer/features/remote-hosts/host-reachability-notice', () => ({
  HostReachabilityNotice: () => null,
}));
vi.mock('@renderer/features/remote-hosts/host-readiness-notice', () => ({
  HostReadinessNotice: () => null,
  useRemoteHostReadiness: () => ({ blocked: false, checking: false }),
}));
vi.mock('@renderer/features/switch-servers/ConnectionsModal', () => ({
  ConnectionsModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="connections-page">
      <button type="button" onClick={onClose}>
        Close connections
      </button>
    </div>
  ),
}));
vi.mock('@renderer/features/switch-servers/managed-provider-connection-step', () => ({
  ManagedProviderConnectionStep: () => null,
}));
vi.mock('@renderer/lib/components/provider-connection-status', () => ({
  ProviderConnectionStatus: () => null,
}));
// The name and description, filled in as the user would.
vi.mock('@renderer/features/locations/components/add-agent-modal/configure-agent-panel', () => ({
  AgentIdentityFields: ({
    form,
  }: {
    form: { setAgentName: (v: string) => void; setDescription: (v: string) => void };
  }) => {
    const { setAgentName, setDescription } = form;
    useEffect(() => {
      setAgentName('helper');
      setDescription('Helps');
    }, [setAgentName, setDescription]);
    return null;
  },
  AgentSettingsSection: () => null,
}));
vi.mock('@renderer/features/locations/components/add-agent-modal/machine-provider-picker', () => ({
  MachineProviderPicker: ({
    value,
    onChange,
  }: {
    value: string | null;
    onChange: (v: string) => void;
  }) => {
    useEffect(() => {
      if (value === null) onChange('claude');
    }, [value, onChange]);
    return null;
  },
}));
vi.mock(
  '@renderer/features/locations/components/add-agent-modal/managed-run-location-notice',
  () => ({
    CanManageAgentsField: () => null,
    ManagedAdvancedConfig: () => null,
    ManagedRunLocationNotice: () => null,
  })
);
vi.mock('@renderer/features/locations/components/add-agent-modal/managed-directory-field', () => ({
  ManagedDirectoryField: () => null,
  useSuggestedManagedDirectory: () => ({ path: null }),
}));

import { NewAgentForm } from '@renderer/features/locations/components/add-agent-modal/new-agent-form';
import { switchCloudFeature } from '@renderer/features/switch-servers/switch-cloud-feature';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';

const CLOUD_MACHINE: OwnedMachine = {
  id: 'cloud-controller',
  name: 'Cloud machine',
  kind: 'ec2',
  state: 'online',
  local: null,
  workspacesDir: null,
  providers: [{ provider: 'claude', ready: true, problem: null }],
};

function github(status: ConnectionCatalogEntry['status']): ConnectionCatalogEntry {
  return {
    slug: 'github',
    name: 'GitHub',
    category: 'Development',
    description: 'GitHub access',
    enabled: true,
    auth_type: 'oauth',
    status,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let wasEnabled = false;

beforeEach(() => {
  wasEnabled = switchCloudFeature.enabled;
  runInAction(() => {
    switchCloudFeature.enabled = true;
  });
  rpc.remoteHosts.listHosts.mockReset().mockResolvedValue([]);
  rpc.managedAgents.machines.mockReset().mockResolvedValue([CLOUD_MACHINE]);
  rpc.agentMigration.addManagedAgent.mockReset().mockResolvedValue({
    kind: 'created',
    serverId: 'server-1',
    workspaceId: 'workspace-1',
    switchAgentId: 'agent-1',
  });
  rpc.switchServers.getConnectionCatalog.mockReset();
  rpc.switchServers.getGitHubConnection.mockReset();
  rpc.workspaces.updateAddressingPolicy.mockReset().mockResolvedValue(undefined);
  rpc.workspaces.updateCanManageAgents.mockReset().mockResolvedValue(undefined);
  navigate.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  runInAction(() => {
    switchCloudFeature.enabled = wasEnabled;
  });
});

/** The dialog renders in a portal, so the page is looked at, not the container. */
async function render(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Dialog open>
          <DialogContent>
            <NewAgentForm
              onClose={() => {}}
              onBack={null}
              entryPoint="sidebar"
              serverId="server-1"
              initialRunLocation="cloud"
            />
          </DialogContent>
        </Dialog>
      </QueryClientProvider>
    )
  );
  return document.body;
}

function button(el: ParentNode, text: RegExp): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''));
}

async function addAgentEnabled(el: HTMLElement): Promise<HTMLButtonElement> {
  return vi.waitFor(() => {
    const add = button(el, /^Add agent/);
    expect(add?.disabled).toBe(false);
    return add!;
  });
}

describe('a new Switch cloud agent’s connections', () => {
  it('is created without GitHub, with no grant and no repository', async () => {
    rpc.switchServers.getConnectionCatalog.mockResolvedValue([github('not_connected')]);
    const el = await render();
    await vi.waitFor(() => expect(el.textContent).toMatch(/Not connected/));
    const add = await addAgentEnabled(el);
    await act(async () => add.click());
    await vi.waitFor(() => expect(rpc.agentMigration.addManagedAgent).toHaveBeenCalledTimes(1));
    const params = rpc.agentMigration.addManagedAgent.mock.calls[0][0];
    expect(params).toMatchObject({
      name: 'helper',
      machineId: 'cloud-controller',
      dir: null,
      connections: [],
    });
    expect(params).not.toHaveProperty('repository');
  });

  it('opens the Connections page in the form, and comes back to it', async () => {
    rpc.switchServers.getConnectionCatalog.mockResolvedValue([github('not_connected')]);
    const el = await render();
    await vi.waitFor(() => expect(button(el, /^Connect$/)).toBeDefined());
    await act(async () => button(el, /^Connect$/)!.click());
    expect(el.querySelector('[data-testid="connections-page"]')).not.toBeNull();
    expect(button(el, /^Add agent/)?.closest('[hidden]')).not.toBeNull();
    await act(async () => button(el, /^Close connections$/)!.click());
    expect(el.querySelector('[data-testid="connections-page"]')).toBeNull();
    expect(rpc.switchServers.getConnectionCatalog).toHaveBeenCalledTimes(2);
  });

  it('is created with the repositories it was granted', async () => {
    rpc.switchServers.getConnectionCatalog.mockResolvedValue([github('connected')]);
    rpc.switchServers.getGitHubConnection.mockResolvedValue({
      status: 'connected',
      login: 'example-user',
      install_url: 'https://github.example/install',
      installations: [
        {
          id: 456,
          account: 'example-user',
          repositories: [
            { id: 111, name: 'example-user/demo' },
            { id: 222, name: 'example-user/docs' },
          ],
        },
      ],
    });
    const el = await render();
    const group = await vi.waitFor(() => {
      const found = el.querySelector<HTMLElement>('[role="group"][aria-label="example-user"]');
      expect(found).not.toBeNull();
      return found!;
    });
    await act(async () =>
      group.querySelector<HTMLElement>('[aria-label="Selected repositories"]')!.click()
    );
    expect(button(el, /^Add agent/)?.disabled).toBe(true);
    await act(async () =>
      el.querySelector<HTMLElement>('[role="checkbox"][aria-label="example-user/docs"]')!.click()
    );
    const add = await addAgentEnabled(el);
    await act(async () => add.click());
    await vi.waitFor(() => expect(rpc.agentMigration.addManagedAgent).toHaveBeenCalledTimes(1));
    const params = rpc.agentMigration.addManagedAgent.mock.calls[0][0];
    expect(params.connections).toEqual([
      { slug: 'github', installations: [{ installation_id: 456, repositories: [222] }] },
    ]);
    expect(params).not.toHaveProperty('repository');
  });
});

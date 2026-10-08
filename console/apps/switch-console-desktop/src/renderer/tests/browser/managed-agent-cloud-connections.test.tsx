/**
 * A cloud agent's owner changes what the agent can reach on its page, with the
 * same editor the create form uses, and saves it with the rest of the
 * definition. The whole grant list is sent, as the server replaces it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { runInAction } from 'mobx';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ManagedAgentView, OwnedMachine } from '@shared/core/managed-agents/managed-agents';

const managedAgents = vi.hoisted(() => ({
  machines: vi.fn(),
  update: vi.fn(),
  advancedConfigSchema: vi.fn(),
}));
const workspaces = vi.hoisted(() => ({
  updateAgentDisplayName: vi.fn(),
  updateAgentDescription: vi.fn(),
  updateAgentIcon: vi.fn(),
}));
const modelCatalogue = vi.hoisted(() => vi.fn());
const switchServers = vi.hoisted(() => ({
  getConnectionCatalog: vi.fn(),
  getGitHubConnection: vi.fn(),
}));

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { managedAgents, workspaces, switchServers, agents: { modelCatalogue } },
}));
vi.mock(
  '@renderer/features/locations/components/settings-view/sections/addressing-policy-settings-section',
  () => ({ AddressingPolicyRow: () => <div>Who can talk to your agent</div> })
);
vi.mock(
  '@renderer/features/locations/components/settings-view/sections/can-manage-agents-settings-section',
  () => ({ CanManageAgentsRow: () => <div>Can manage agents</div> })
);
vi.mock('@renderer/lib/components/agent-icon-picker', () => ({ AgentIconPicker: () => null }));
vi.mock('@renderer/features/agent-migration/managed-agent-section', () => ({
  ManagedAgentSection: () => null,
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: { agentsOnServer: () => [] },
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: () => vi.fn(),
  useModalContext: () => ({ setCloseGuard: vi.fn(), hasActiveCloseGuard: false }),
}));

import { ManagedAgentPage } from '@renderer/features/managed-agents/managed-agent-page';
import { switchCloudFeature } from '@renderer/features/switch-servers/switch-cloud-feature';

const AGENT: ManagedAgentView = {
  serverId: 'server-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  name: 'cloud-agent',
  displayName: null,
  iconUrl: null,
  description: 'Fixes bugs',
  machine: { id: 'cloud-controller', name: 'Cloud machine', kind: 'ec2', state: 'online' },
  desiredState: 'running',
  revision: 1,
  definition: {
    provider: 'claude',
    model: null,
    advancedConfig: {},
    instructions: '',
    autoApprove: true,
    directory: null,
    isolation: 'shared',
    connections: [
      { slug: 'github', installations: [{ installation_id: 123, repositories: 'all' }] },
    ],
  },
  status: { process: 'running', attached: true, reason: null, detail: null, directory: null },
};

const CLOUD_MACHINE: OwnedMachine = {
  ...AGENT.machine!,
  local: null,
  providers: [{ provider: 'claude', ready: true, problem: null }],
  workspacesDir: null,
};

let container: HTMLDivElement;
let root: Root;
let wasEnabled = false;

beforeEach(async () => {
  wasEnabled = switchCloudFeature.enabled;
  runInAction(() => {
    switchCloudFeature.enabled = true;
  });
  managedAgents.machines.mockReset().mockResolvedValue([CLOUD_MACHINE]);
  managedAgents.update.mockReset().mockResolvedValue(undefined);
  managedAgents.advancedConfigSchema.mockReset().mockResolvedValue({ claude: [] });
  for (const fn of Object.values(workspaces)) fn.mockReset().mockResolvedValue(undefined);
  modelCatalogue.mockReset().mockResolvedValue({ kind: 'available', models: [] });
  switchServers.getConnectionCatalog.mockReset().mockResolvedValue([
    {
      slug: 'github',
      name: 'GitHub',
      category: 'Development',
      description: 'GitHub access',
      enabled: true,
      auth_type: 'oauth',
      status: 'connected',
    },
  ]);
  switchServers.getGitHubConnection.mockReset().mockResolvedValue({
    status: 'connected',
    login: 'example-user',
    install_url: 'https://github.example/install',
    installations: [
      { id: 123, account: 'acme', repositories: [{ id: 1, name: 'acme/api' }] },
      {
        id: 456,
        account: 'example-user',
        repositories: [{ id: 111, name: 'example-user/demo' }],
      },
    ],
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ManagedAgentPage agent={AGENT} />
      </QueryClientProvider>
    );
  });
  await vi.waitFor(() =>
    expect(container.querySelector('[role="group"][aria-label="acme"]')).not.toBeNull()
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  runInAction(() => {
    switchCloudFeature.enabled = wasEnabled;
  });
});

function button(name: RegExp): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) =>
    name.test(b.textContent?.trim() ?? '')
  );
}

function choice(account: string, label: string): HTMLElement {
  return container.querySelector<HTMLElement>(
    `[role="group"][aria-label="${account}"] [aria-label="${label}"]`
  )!;
}

it('shows the access the agent has', () => {
  expect(choice('acme', 'All repositories').getAttribute('aria-pressed')).toBe('true');
  expect(choice('example-user', 'No access').getAttribute('aria-pressed')).toBe('true');
  expect(container.textContent).not.toContain('Unsaved changes');
});

it('saves the whole grant list through the definition update', async () => {
  await act(async () => choice('example-user', 'Selected repositories').click());
  await act(async () =>
    container
      .querySelector<HTMLElement>('[role="checkbox"][aria-label="example-user/demo"]')!
      .click()
  );
  await act(async () => choice('acme', 'No access').click());
  expect(container.textContent).toContain('Unsaved changes');
  await act(async () => button(/^Save/)!.click());
  expect(managedAgents.update).toHaveBeenCalledWith({
    serverId: 'server-1',
    agentId: 'agent-1',
    changes: {
      definition: {
        connections: [
          { slug: 'github', installations: [{ installation_id: 456, repositories: [111] }] },
        ],
      },
    },
  });
});

it('refuses to save a selection with no repository in it', async () => {
  await act(async () => choice('example-user', 'Selected repositories').click());
  await act(async () => button(/^Save/)!.click());
  expect(managedAgents.update).not.toHaveBeenCalled();
  expect(container.textContent).toMatch(/Choose at least one repository/);
});

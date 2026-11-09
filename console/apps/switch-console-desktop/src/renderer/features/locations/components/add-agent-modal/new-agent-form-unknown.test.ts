import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const machine = {
    id: 'hermes',
    name: 'Hermes',
    kind: 'daemon',
    state: 'online',
    acceptsLogins: false,
    cloud: false,
    local: null,
    os: null,
    workspacesDir: '/tmp/workspaces',
    providers: [
      {
        provider: 'deepseek-harness',
        ready: false,
        canAttempt: true,
        problem: 'login could not be checked',
        detail: 'Configure and select an OpenRouter model.',
        loginHelps: true,
      },
    ],
  };
  return {
    machine,
    create: vi.fn(async () => ({
      kind: 'created',
      workspaceId: 'workspace',
      switchAgentId: 'agent',
      serverId: 'server',
    })),
    updatePolicy: vi.fn(async () => {}),
    onClose: vi.fn(),
    navigate: vi.fn(),
  };
});

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    remoteHosts: { listHosts: async () => [] },
    managedAgents: { machines: async () => [state.machine] },
    agentMigration: { addManagedAgent: state.create },
    workspaces: { updateAddressingPolicy: state.updatePolicy },
  },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    activeServerId: 'server',
    servers: [{ id: 'server', managed: false }],
    init: async () => {},
  },
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {
    idOnServerInScope: () => 'workspace',
  },
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: { load: async () => {} },
}));
vi.mock('@renderer/features/locations/stores/location-selectors', () => ({
  getLocationManagerStore: () => ({}),
}));
vi.mock('@renderer/features/managed-agents/use-managed-agents', () => ({
  MANAGED_AGENTS_KEY: 'managed-agents',
  refreshEvery: () => false,
}));
vi.mock('@renderer/features/managed-agents/use-user-changes', () => ({
  useUserChangesLive: () => false,
}));
vi.mock('@renderer/features/cloud-agents/use-cloud-agents', () => ({
  useCloudMachines: () => ({ data: null }),
}));
vi.mock('@renderer/features/remote-hosts/host-reachability-store', () => ({
  hostReachabilityStore: { isBlocked: () => false },
}));
vi.mock('@renderer/features/remote-hosts/host-reachability-notice', () => ({
  HostReachabilityNotice: () => null,
}));
vi.mock('@renderer/features/remote-hosts/host-readiness-notice', () => ({
  HostReadinessNotice: () => null,
  useRemoteHostReadiness: () => ({ checking: false, blocked: false }),
}));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: undefined }),
}));
vi.mock('@renderer/features/switch-servers/addressing-policy-editor', () => ({
  policyHasDeadRule: () => false,
}));
vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({ useFeatureFlags: () => ({}) }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: state.navigate }),
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useModalContext: () => ({ setCloseGuard: () => {} }),
  useShowModal: () => () => {},
}));
vi.mock('@renderer/lib/stores/use-workspace-agents', () => ({
  useWorkspaceAgents: () => ({ data: [] }),
}));
vi.mock('@renderer/lib/components/provider-connection-status', () => ({
  ProviderConnectionStatus: () => null,
}));
vi.mock('@renderer/lib/components/agent-icon', () => ({ AgentIcon: () => null }));
vi.mock('@shared/core/providers/agent-provider-registry', () => ({
  agentProviders: () => [{ id: 'deepseek-harness', name: 'DeepSeek Harness' }],
}));

vi.mock('./modes', () => ({
  usePickMode: () => {
    const [serverId, setServerId] = React.useState<string | null>(null);
    const [providerId, setProviderId] = React.useState<string | null>(null);
    return {
      serverId,
      setServerId,
      providerId,
      setProviderId,
      path: '',
      handlePathChange: () => {},
    };
  },
  useConfigureAgentForm: () => ({
    agentName: 'demo-agent',
    nameIsValid: true,
    isValid: true,
    description: 'Synthetic demo',
    displayName: '',
    instructions: '',
    iconUrl: null,
    autoApprove: false,
    autoMode: false,
    addressingPolicy: {},
  }),
}));
vi.mock('./configure-agent-panel', () => ({
  AgentIdentityFields: () => null,
  AgentSettingsSection: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));
vi.mock('./managed-directory-field', () => ({
  ManagedDirectoryField: () => null,
  useSuggestedManagedDirectory: () => ({ path: '/tmp/workspaces/demo-agent' }),
}));
vi.mock('./managed-run-location-notice', () => ({
  CanManageAgentsField: () => null,
  ManagedAdvancedConfig: () => null,
  ManagedRunLocationNotice: () => null,
}));
vi.mock('./agent-advanced-config', () => ({ AgentAdvancedConfig: () => null }));
vi.mock('./agent-type-picker', () => ({ AgentTypePicker: () => null }));
vi.mock('./launch-profile-config', () => ({ LaunchProfileConfig: () => null }));
vi.mock('./local-directory-selector', () => ({ LocalDirectorySelector: () => null }));
vi.mock('./give-machine-login', () => ({ GiveMachineLogin: () => null }));

const wrap = ({ children }: { children?: React.ReactNode }) =>
  React.createElement('div', null, children);
vi.mock('@renderer/lib/ui/dialog', () => ({
  DialogContentArea: wrap,
  DialogFooter: wrap,
  DialogHeader: wrap,
  DialogTitle: wrap,
}));
vi.mock('@renderer/lib/ui/field', () => ({ Field: wrap, FieldLabel: wrap }));
vi.mock('@renderer/lib/ui/select', () => ({
  Select: wrap,
  SelectContent: wrap,
  SelectItem: wrap,
  SelectTrigger: wrap,
  SelectValue: wrap,
}));
vi.mock('@renderer/lib/ui/tooltip', () => ({
  Tooltip: wrap,
  TooltipContent: wrap,
  TooltipProvider: wrap,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => render,
}));
vi.mock('@renderer/lib/ui/modal-layout', () => ({
  ModalLayout: ({
    header,
    footer,
    children,
  }: {
    header: React.ReactNode;
    footer: React.ReactNode;
    children: React.ReactNode;
  }) => React.createElement('div', null, header, children, footer),
}));
vi.mock('@renderer/lib/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement('button', props, children),
}));
vi.mock('@renderer/lib/ui/confirm-button', () => ({
  ConfirmButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement('button', props, children),
}));

const { NewAgentForm } = await import('./new-agent-form');
let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('creating an agent with an unverified provider', () => {
  it('requires an explicit choice, enables Add agent, and calls managed creation', async () => {
    state.create.mockClear();
    state.updatePolicy.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    await act(async () =>
      root!.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(NewAgentForm, {
            onClose: state.onClose,
            onBack: null,
            entryPoint: 'unknown',
            serverId: 'server',
            initialRunLocation: 'machine:hermes',
          })
        )
      )
    );
    await vi.waitFor(() => expect(container!.textContent).toContain('DeepSeek Harness'));
    const button = (text: string) =>
      [...container!.querySelectorAll('button')].find((item) => item.textContent?.includes(text));
    expect(button('Add agent')?.disabled).toBe(true);
    expect(button('DeepSeek Harness')?.disabled).toBe(false);
    await act(async () => button('DeepSeek Harness')!.click());
    expect(container!.textContent).toContain('Sign-in could not be verified');
    expect(button('Add agent')?.disabled).toBe(false);
    await act(async () => button('Add agent')!.click());
    await vi.waitFor(() =>
      expect(state.create).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'deepseek-harness',
          machineId: 'hermes',
          serverId: 'server',
        })
      )
    );
  });
});

/**
 * "Set up agent providers" is done when a provider can run an agent — signed in
 * on this computer, or connected on Switch Cloud — and not merely because a CLI
 * is installed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  cloudServerId: null as string | null,
  cloudSignedIn: false,
  installed: [] as string[],
  readiness: { installed: true, status: 'unauthenticated' } as {
    installed: boolean;
    status: string;
  },
  cloudConnections: {} as Record<string, unknown>,
}));

const providerReadiness = vi.hoisted(() => vi.fn(async () => state.readiness));
const getCloudProviderConnection = vi.hoisted(() =>
  vi.fn(async (_serverId: string, provider: string) => {
    return state.cloudConnections[provider] ?? { status: 'not_connected' };
  })
);

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: {
    agentTypes: {
      listAvailability: async () =>
        state.installed.map((agentId) => ({
          agentId,
          available: true,
          blockedReason: null,
          blockedKind: null,
        })),
    },
    agents: { providerReadiness },
    switchServers: { getCloudProviderConnection },
  },
}));
vi.mock('@renderer/features/switch-servers/switch-cloud-origin', () => ({
  managedCloudServerId: () => state.cloudServerId,
}));
vi.mock('@renderer/features/cloud-agents/use-cloud-agents', () => ({
  useCloudAgents: () => ({ data: [] }),
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { servers: [], isConnected: () => state.cloudSignedIn },
}));
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: { listedRoomsInAllWorkspaces: [] },
}));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { locations: { locations: new Map() } },
}));
vi.mock('@renderer/lib/telemetry/report', () => ({ report: vi.fn() }));

import { useOnboardingProgress } from '@renderer/features/onboarding/use-onboarding-checklist';
import { AGENT_PROVIDERS } from '@shared/core/providers/agent-provider-registry';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let agentProviders: boolean | null = null;

beforeEach(() => {
  Object.assign(state, {
    cloudServerId: null,
    cloudSignedIn: false,
    installed: [],
    readiness: { installed: true, status: 'unauthenticated' },
    cloudConnections: {},
  });
  providerReadiness.mockClear();
  getCloudProviderConnection.mockClear();
  agentProviders = null;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

function Probe() {
  agentProviders = useOnboardingProgress().agentProviders;
  return null;
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>
    )
  );
}

/** Let answers already asked for land and render. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('the agent providers step', () => {
  it('is not done by an installed CLI nobody has signed in to', async () => {
    state.installed = ['claude'];
    await mount();

    await vi.waitFor(() => expect(providerReadiness).toHaveBeenCalled());
    await settle();
    expect(agentProviders).toBe(false);
  });

  it('is done once a provider is signed in on this computer', async () => {
    state.installed = ['claude'];
    state.readiness = { installed: true, status: 'authenticated' };
    await mount();

    await vi.waitFor(() => expect(agentProviders).toBe(true));
    expect(providerReadiness).toHaveBeenCalledWith({
      providerId: 'claude',
      sshHost: null,
      dir: '',
    });
  });

  it('is not done on Switch Cloud with no provider connected', async () => {
    state.cloudServerId = 'cloud-1';
    state.cloudSignedIn = true;
    await mount();

    await vi.waitFor(() =>
      expect(getCloudProviderConnection).toHaveBeenCalledTimes(AGENT_PROVIDERS.length)
    );
    await settle();
    expect(agentProviders).toBe(false);
  });

  it('is done once a provider is connected on Switch Cloud', async () => {
    state.cloudServerId = 'cloud-1';
    state.cloudSignedIn = true;
    state.cloudConnections = {
      codex: { status: 'connected', kind: 'api-key', verified_at: '2026-01-01T00:00:00Z' },
    };
    await mount();

    await vi.waitFor(() => expect(agentProviders).toBe(true));
    expect(getCloudProviderConnection).toHaveBeenCalledWith('cloud-1', 'codex');
  });

  it('does not ask Switch Cloud while signed out of it', async () => {
    state.cloudServerId = 'cloud-1';
    await mount();

    expect(getCloudProviderConnection).not.toHaveBeenCalled();
    expect(agentProviders).toBe(false);
  });
});

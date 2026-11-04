// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
  allFeatureFlagsOff,
  type ServerFeatureFlags,
} from '@shared/core/feature-flags/feature-flags';

// B38 on a first sign-in, end to end through the hook: a fresh Console's flags
// read is refused before sign-in, and that refusal must not enrol this computer.

const listeners = new Set<(state: ServerFeatureFlags) => void>();
const flagsState = new Map<string, ServerFeatureFlags>();
const refresh = vi.fn(async () => ({ success: true as const, data: undefined }));
const getOverview = vi.fn(async () => ({ unsupportedReason: null, enrollment: null }));
const enable = vi.fn(async () => {});

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: (_channel: unknown, listener: (state: ServerFeatureFlags) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
  rpc: {
    featureFlags: {
      get: async (serverId: string) => ({ success: true, data: flagsState.get(serverId) }),
      refresh,
    },
    embeddedController: {
      getOverview,
      enable,
      precheckProviders: vi.fn(async () => {}),
      precheckedProviders: vi.fn(async () => null),
      recheckProviders: vi.fn(async () => {}),
    },
    managedAgents: { machines: vi.fn(async () => []) },
  },
}));
vi.mock('@renderer/features/cloud-agents/use-cloud-agents', () => ({
  useCloudMachines: () => ({ data: undefined }),
}));
vi.mock('@renderer/features/locations/components/add-agent-modal/server-run-locations', () => ({
  boxBackends: () => new Map(),
  hasSharedCloudBox: () => false,
}));
vi.mock('@renderer/features/managed-agents/use-managed-agents', () => ({
  MANAGED_AGENTS_KEY: 'managed-agents',
}));

const { useThisComputer } = await import('./use-this-computer');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOT_SIGNED_IN = 'Not signed in to this Switch server.';
const state = (
  serverId: string,
  over: Partial<ServerFeatureFlags> & { hostedV2?: boolean } = {}
): ServerFeatureFlags => ({
  serverId,
  flags: { ...allFeatureFlagsOff(), hosted_v2: over.hostedV2 ?? false },
  fetchedAt: over.fetchedAt ?? null,
  error: over.error === undefined ? null : over.error,
});
const emit = (next: ServerFeatureFlags) => {
  flagsState.set(next.serverId, next);
  for (const listener of [...listeners]) listener(next);
};

async function open(serverId: string) {
  const root = createRoot(document.createElement('div'));
  function Page() {
    useThisComputer(serverId, 'w1');
    return null;
  }
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Page))
    );
  });
  return root;
}

describe('useThisComputer on a first sign-in (B38)', () => {
  it('on a v2 server: waits through the not-signed-in refusal, reads again, then only asks', async () => {
    vi.clearAllMocks();
    flagsState.set('v2', state('v2', { error: NOT_SIGNED_IN }));
    const root = await open('v2');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(getOverview).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();

    // The read after signing in: hosted agents v2 is on.
    await act(async () => emit(state('v2', { hostedV2: true, fetchedAt: 1 })));
    expect(getOverview).toHaveBeenCalledTimes(1);
    expect(enable).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('on a v1 server: the read after signing in enrols straight away, as upstream', async () => {
    vi.clearAllMocks();
    flagsState.set('v1', state('v1', { error: NOT_SIGNED_IN }));
    const root = await open('v1');
    expect(enable).not.toHaveBeenCalled();

    await act(async () => emit(state('v1', { hostedV2: false, fetchedAt: 1 })));
    expect(enable).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('a read that fails while signed in never enrols: it only reads and asks, with no refresh', async () => {
    vi.clearAllMocks();
    flagsState.set('down', state('down', { error: 'The server did not answer in time.' }));
    const root = await open('down');
    expect(refresh).not.toHaveBeenCalled();
    expect(getOverview).toHaveBeenCalledTimes(1);
    expect(enable).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('a good read with v2 off, then a failed read: enrolled once by the good read, never again by the failed one', async () => {
    vi.clearAllMocks();
    flagsState.set('flaky', state('flaky', { fetchedAt: 1 }));
    const root = await open('flaky');
    expect(enable).toHaveBeenCalledTimes(1);
    await act(async () =>
      emit(state('flaky', { fetchedAt: 1, error: 'The server did not answer in time.' }))
    );
    expect(enable).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('read flags answer straight away: no refresh, and with hosted_v2 on it only asks', async () => {
    vi.clearAllMocks();
    flagsState.set('read', state('read', { hostedV2: true, fetchedAt: 1 }));
    const root = await open('read');
    expect(refresh).not.toHaveBeenCalled();
    expect(getOverview).toHaveBeenCalledTimes(1);
    expect(enable).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('reads again once per page opening, never in a loop, while the refusal repeats', async () => {
    vi.clearAllMocks();
    flagsState.set('loop', state('loop', { error: NOT_SIGNED_IN }));
    const root = await open('loop');
    expect(refresh).toHaveBeenCalledTimes(1);
    // The refreshed read is refused again (still not signed in): it waits, and asks for nothing more.
    await act(async () => emit(state('loop', { error: NOT_SIGNED_IN })));
    await act(async () => emit(state('loop', { error: NOT_SIGNED_IN })));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(getOverview).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});

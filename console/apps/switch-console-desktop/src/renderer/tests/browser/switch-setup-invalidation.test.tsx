import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Installing a connector has to reach the onboarding checklist.
 *
 * The checklist decides the agent-providers step from the roster of agent types
 * that can be onboarded, which is cached under its own key — not under the
 * agent's. Invalidating only the agent's key left the roster stale, so a
 * successful install did not tick the step, and the checklist locks every later
 * step behind the first unfinished one. The whole rest of onboarding went grey
 * with nothing on screen saying why.
 */

const install = vi.hoisted(() => vi.fn(() => Promise.resolve({ success: true })));
const getStatus = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({
      agentId: 'claude',
      supported: true,
      installed: false,
      installedVersion: null,
      latestVersion: null,
      updateAvailable: false,
      refreshError: null,
    })
  )
);

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    switchSetup: {
      getStatus,
      install,
      update: vi.fn(),
      uninstall: vi.fn(),
      checkForUpdates: vi.fn(),
      listAgentTypeAvailability: vi.fn(() => Promise.resolve([])),
      listAgentTypeAvailabilityRemote: vi.fn(() => Promise.resolve([])),
    },
  },
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));

import { useSwitchSetup } from '@renderer/lib/stores/use-switch-setup';

const AVAILABILITY_KEY = ['switch-setup', 'agent-type-availability', 'local'];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

/** Renders the hook and hands back its `install`, plus the shared client. */
async function mountSwitchSetup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seeded as fresh so nothing refetches it except an invalidation.
  queryClient.setQueryData(AVAILABILITY_KEY, []);

  let installConnector: () => void = () => {};
  function Probe() {
    installConnector = useSwitchSetup('claude').install;
    return null;
  }

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>
    )
  );

  return { queryClient, installConnector: () => installConnector() };
}

describe('installing a Switch connector', () => {
  it('marks the onboardable agent types stale, so the checklist re-reads them', async () => {
    const { queryClient, installConnector } = await mountSwitchSetup();

    expect(queryClient.getQueryState(AVAILABILITY_KEY)?.isInvalidated).toBe(false);

    await act(async () => {
      installConnector();
      await vi.waitFor(() =>
        expect(queryClient.getQueryState(AVAILABILITY_KEY)?.isInvalidated).toBe(true)
      );
    });

    expect(install).toHaveBeenCalled();
  });
});

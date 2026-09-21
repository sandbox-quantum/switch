import { expect, it, vi } from 'vitest';
import type { SwitchSetupStatus } from './connector-run';

const mocks = vi.hoisted(() => ({ probe: vi.fn(), listAgentTypeStatuses: vi.fn() }));
vi.mock('@main/core/dependencies/remote-dependency-manager', () => ({
  getRemoteDependencyManager: async () => ({ probe: mocks.probe }),
}));
vi.mock('@main/core/agent-runtime/impl/provider-adapter-registry', () => ({
  providerAdapterRegistry: { supports: () => true },
}));
vi.mock('@main/core/remote-hosts/production-host-reachability', () => ({
  hostReachabilityService: { isBlocked: () => false },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./switch-setup-service', () => ({ switchSetupService: {} }));
vi.mock('./remote-switch-setup', () => ({
  getRemoteSwitchSetupService: async () => ({
    listAgentTypeStatuses: mocks.listAgentTypeStatuses,
  }),
}));
const { switchSetupController } = await import('./controller');

/**
 * A whole status row, because the field that matters here is the one a partial
 * fixture leaves `undefined` — and a status that could not be read is exactly
 * what `refreshError` carries.
 */
function status(overrides: Partial<SwitchSetupStatus>): SwitchSetupStatus {
  return {
    agentId: 'claude',
    supported: true,
    installed: true,
    installedVersion: '0.1.0',
    latestVersion: '0.1.0',
    updateAvailable: false,
    refreshError: null,
    ...overrides,
  };
}

it('offers installed remote ACP providers without requiring connector plugins', async () => {
  mocks.listAgentTypeStatuses.mockResolvedValue([status({})]);
  mocks.probe.mockImplementation(async (id) => ({
    status: id === 'cursor' ? 'available' : 'missing',
  }));
  const statuses = await switchSetupController.listAgentTypeAvailabilityRemote('example-host');
  expect(statuses).toContainEqual({ agentId: 'cursor', available: true, blockedReason: null });
  expect(statuses).toContainEqual({
    agentId: 'antigravity',
    available: false,
    blockedReason: 'Install Antigravity ACP on example-host.',
  });
  expect(statuses).toContainEqual({ agentId: 'claude', available: true, blockedReason: null });
});

it('does not call a failed remote probe an installed CLI', async () => {
  mocks.listAgentTypeStatuses.mockResolvedValue([status({})]);
  mocks.probe.mockResolvedValue({ status: 'error' });
  const statuses = await switchSetupController.listAgentTypeAvailabilityRemote('example-host');
  expect(statuses.find((s) => s.agentId === 'cursor')).toMatchObject({
    available: false,
    blockedReason: 'Could not verify this CLI on example-host. Recheck the host setup.',
  });
});

/**
 * The driver keeps going when one agent type's status cannot be read, so the
 * row it produces reaches here with every field at its empty value and the
 * reason in `refreshError`. Branching on `installed` alone reads that as "the
 * connector is not installed", which is a statement of fact about the one thing
 * the read failed to establish — and it offers to install something that may
 * already be there.
 */
it('says a remote status could not be read rather than calling it not installed', async () => {
  mocks.listAgentTypeStatuses.mockResolvedValue([
    status({ installed: false, installedVersion: null, refreshError: 'ssh channel closed' }),
  ]);
  mocks.probe.mockResolvedValue({ status: 'missing' });
  const statuses = await switchSetupController.listAgentTypeAvailabilityRemote('example-host');
  expect(statuses.find((s) => s.agentId === 'claude')).toEqual({
    agentId: 'claude',
    available: false,
    blockedReason:
      'Its Switch connector status could not be read on example-host: ssh channel closed',
  });
});

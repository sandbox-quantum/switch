import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ probe: vi.fn() }));
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
    listAgentTypeStatuses: async () => [{ agentId: 'claude', supported: true, installed: true }],
  }),
}));
const { switchSetupController } = await import('./controller');
it('offers installed remote ACP providers without requiring connector plugins', async () => {
  mocks.probe.mockImplementation(async (id) => ({
    status: id === 'cursor' ? 'available' : 'missing',
  }));
  const statuses = await switchSetupController.listAgentTypeAvailabilityRemote('example-host');
  expect(statuses).toContainEqual({
    agentId: 'cursor',
    available: true,
    blockedReason: null,
    blockedKind: null,
  });
  expect(statuses).toContainEqual({
    agentId: 'antigravity',
    available: false,
    blockedReason: 'Install Antigravity ACP on example-host.',
    blockedKind: 'not-installed',
  });
  expect(statuses).toContainEqual({
    agentId: 'claude',
    available: true,
    blockedReason: null,
    blockedKind: null,
  });
});
it('does not call a failed remote probe an installed CLI', async () => {
  mocks.probe.mockResolvedValue({ status: 'error' });
  const statuses = await switchSetupController.listAgentTypeAvailabilityRemote('example-host');
  expect(statuses.find((status) => status.agentId === 'cursor')).toMatchObject({
    available: false,
    blockedReason: 'Could not verify this CLI on example-host. Recheck the host setup.',
    // Not 'not-installed': the host never answered, so nothing here says the
    // CLI is missing, and the tile must not send anyone off to install it.
    blockedKind: 'unknown',
  });
});

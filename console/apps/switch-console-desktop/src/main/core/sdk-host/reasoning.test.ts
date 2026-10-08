import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  local: { reasoning: vi.fn() },
  sidecar: { reasoning: vi.fn() },
  sidecarControl: vi.fn(),
  sshHost: null as string | null,
  linked: true,
}));
vi.mock('@switch-console/agent-providers', () => ({
  sharedSessionRoot: (id: string) => `/roots/${id}`,
}));
vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: async () => (mocks.linked ? { switchAgentId: 'switch-agent' } : null),
}));
vi.mock('@main/core/agents/agent-location', () => ({
  getAgentLocation: async () => ({ sshHost: mocks.sshHost }),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./local-host', () => ({ localSessionLinks: mocks.local }));
vi.mock('./controller-control', () => ({
  isRelayedAgent: (agentId: string) =>
    agentId.startsWith('cloud:') || agentId.startsWith('controller:'),
}));
vi.mock('./sidecar-control', () => ({ sidecarControl: mocks.sidecarControl }));

const { listReasoning } = await import('./reasoning');

const list = {
  epoch: 'epoch',
  turns: [
    {
      turnId: 'turn',
      text: 'Look first.',
      startedAt: '2026-10-08T12:00:00.000Z',
      completedAt: '2026-10-08T12:00:04.000Z',
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sshHost = null;
  mocks.linked = true;
  mocks.sidecarControl.mockResolvedValue(mocks.sidecar);
});

it('reads a local session’s reasoning from its host', async () => {
  mocks.local.reasoning.mockResolvedValue(list);
  expect(await listReasoning('agent', 'session', ['turn'])).toEqual(list);
  expect(mocks.local.reasoning).toHaveBeenCalledWith('/roots/session', ['turn']);
});

it('reads a remote session’s reasoning through its sidecar', async () => {
  mocks.sshHost = 'host';
  mocks.sidecar.reasoning.mockResolvedValue(list);
  expect(await listReasoning('agent', 'session', null)).toEqual(list);
  expect(mocks.sidecar.reasoning).toHaveBeenCalledWith('session', null);
  expect(mocks.local.reasoning).not.toHaveBeenCalled();
});

it('shows none when the host or sidecar predates reasoning, without raising', async () => {
  // A local host that never answered the request.
  mocks.local.reasoning.mockResolvedValue(null);
  expect(await listReasoning('agent', 'session', null)).toBeNull();
  // An older sidecar reads the ask as a health ask and answers with its health.
  mocks.sshHost = 'host';
  mocks.sidecar.reasoning.mockResolvedValue({ state: 'connected', detail: null, placements: {} });
  expect(await listReasoning('agent', 'session', null)).toBeNull();
  // One that refuses it outright, or cannot be reached.
  mocks.sidecar.reasoning.mockRejectedValue(new Error('The sidecar refused the request.'));
  expect(await listReasoning('agent', 'session', null)).toBeNull();
  mocks.sidecarControl.mockRejectedValue(new Error('The agent’s sidecar is not running.'));
  expect(await listReasoning('agent', 'session', null)).toBeNull();
});

it('asks nothing for a cloud or controller-run session, or an unlinked agent', async () => {
  expect(await listReasoning('cloud:server:agent', 'session', null)).toBeNull();
  expect(await listReasoning('controller:server:agent=a', 'session', null)).toBeNull();
  mocks.linked = false;
  expect(await listReasoning('agent', 'session', null)).toBeNull();
  expect(mocks.local.reasoning).not.toHaveBeenCalled();
  expect(mocks.sidecarControl).not.toHaveBeenCalled();
});

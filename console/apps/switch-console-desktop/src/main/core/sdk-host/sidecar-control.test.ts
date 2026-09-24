import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ clients: [] as { isClosed: boolean }[], exec: vi.fn() }));
vi.mock('@switch-console/agent-providers', () => ({
  CONTROL_FILE: 'control.json',
  ControlClient: class {
    isClosed = false;
    ready = Promise.resolve();
    constructor() {
      state.clients.push(this);
    }
  },
}));
vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: async () => ({ switchAgentId: 'switch-agent' }),
}));
vi.mock('@main/core/agents/connect-remote-agent', () => ({
  connectRemoteAgent: async () => ({
    ctx: { exec: state.exec },
    proxy: { forwardOut: async () => ({}) },
  }),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));

const { withSidecar } = await import('./sidecar-control');

beforeEach(() => {
  state.clients.length = 0;
  state.exec.mockResolvedValue({ stdout: JSON.stringify({ port: 4000, token: 'secret' }) });
});

it('tries again on a fresh connection when the sidecar drops mid-call', async () => {
  const call = vi.fn(async (client: { isClosed: boolean }) => {
    if (state.clients.length === 1) {
      client.isClosed = true;
      throw new Error('The connection to the agent sidecar closed.');
    }
    return 'answered';
  });
  expect(await withSidecar('agent', call as never)).toBe('answered');
  expect(call).toHaveBeenCalledTimes(2);
  expect(state.clients).toHaveLength(2);
});

it('does not repeat a call the sidecar refused on a live connection', async () => {
  const call = vi.fn(async () => {
    throw new Error('The sidecar refused the request.');
  });
  await expect(withSidecar('agent', call as never)).rejects.toThrow('refused');
  expect(call).toHaveBeenCalledTimes(1);
});

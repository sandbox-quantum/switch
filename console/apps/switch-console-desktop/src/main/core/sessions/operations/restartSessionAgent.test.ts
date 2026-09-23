import { expect, it, vi } from 'vitest';
import { restartSessionAgent } from './restartSessionAgent';
const restart = vi.hoisted(() => vi.fn());
vi.mock('../../locations/utils', () => ({ resolveSessionAgent: () => ({ restart }) }));
vi.mock('../session-join', () => ({
  loadSessionWithAgent: async () => ({
    row: { agentId: 'agent' },
    providerId: 'codex',
    name: 'agent',
  }),
}));
vi.mock('../utils/utils', () => ({ mapSessionRowToSession: () => ({ id: 'session' }) }));
vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: async () => ({ id: 'agent', locationId: 'loc' }),
}));
vi.mock('@main/core/agents/observed-guard', () => ({
  // Every agent in these cases is one this Console runs (CHOO-2893).
  locationWhereAgentRuns: async () => ({ sshHost: 'host', dir: '/work', observed: false }),
}));
it('requests host recovery using the saved session rather than a permanent stop', async () => {
  await restartSessionAgent('session');
  expect(restart).toHaveBeenCalledWith({ id: 'session' });
});
it('surfaces fencing failures', async () => {
  restart.mockRejectedValueOnce(new Error('Competing owner'));
  await expect(restartSessionAgent('session')).rejects.toThrow('Competing owner');
});

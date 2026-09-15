import { expect, it, vi } from 'vitest';
import { hydrateSession } from './hydrateSession';
const start = vi.hoisted(() => vi.fn());
vi.mock('../../locations/utils', () => ({ resolveSessionAgent: () => ({ start }) }));
vi.mock('../session-join', () => ({
  loadSessionWithAgent: async () => ({
    row: { config: { initialPrompt: 'uncertain opening message' } },
    providerId: 'codex',
    name: 'agent',
  }),
}));
vi.mock('../utils/utils', () => ({ mapSessionRowToSession: () => ({ id: 'session' }) }));
it('reopens saved execution without replaying the initial prompt', async () => {
  await hydrateSession('session');
  expect(start).toHaveBeenCalledWith({ id: 'session' }, undefined, true);
});

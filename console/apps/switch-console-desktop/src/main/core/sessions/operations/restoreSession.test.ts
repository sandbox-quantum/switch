import { beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreSession } from './restoreSession';

const mocks = vi.hoisted(() => ({
  returning: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  selectLimit: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  db: {
    update: () => ({
      set: mocks.updateSet,
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: mocks.selectLimit,
        }),
      }),
    }),
  },
}));

describe('restoreSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
    mocks.updateWhere.mockReturnValue({ returning: mocks.returning });
    mocks.selectLimit.mockResolvedValue([{ providerId: 'claude' }]);
  });

  it('restores by clearing archivedAt without changing lifecycle status', async () => {
    mocks.returning.mockResolvedValueOnce([
      {
        id: 'session-1',
        agentId: 'agent-1',
        title: 'Session 1',
        config: null,
        shellId: 'system',
        status: 'done',
        agentSessionId: null,
        agentStatus: null,
        agentStatusSeen: 1,
        isInitialSession: null,
        isPinned: 0,
        archivedAt: null,
        lastInteractedAt: null,
        statusChangedAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);

    const session = await restoreSession('session-1');

    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        archivedAt: null,
        updatedAt: expect.anything(),
      })
    );
    const updatePayload = mocks.updateSet.mock.calls[0]?.[0];
    expect(updatePayload).not.toHaveProperty('status');
    expect(updatePayload).not.toHaveProperty('statusChangedAt');
    expect(session?.status).toBe('done');
    expect(session?.archivedAt).toBeUndefined();
  });
});

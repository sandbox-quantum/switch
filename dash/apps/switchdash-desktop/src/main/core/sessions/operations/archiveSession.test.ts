import { beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveSession } from './archiveSession';

const mocks = vi.hoisted(() => ({
  selectLimit: vi.fn(),
  teardownSession: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: mocks.selectLimit,
        }),
      }),
    }),
    update: () => ({
      set: mocks.updateSet,
    }),
  },
}));

vi.mock('@main/core/sessions/session-runtime-manager', () => ({
  sessionRuntimeManager: {
    teardownSession: mocks.teardownSession,
  },
}));

describe('archiveSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
    mocks.updateWhere.mockResolvedValue(undefined);
  });

  it('archives by detaching runtime without deleting workspace assets', async () => {
    mocks.selectLimit.mockResolvedValueOnce([
      {
        id: 'session-1',
        locationId: 'workspace-1',
        status: 'done',
      },
    ]);
    mocks.teardownSession.mockResolvedValue({ success: true });

    await archiveSession('session-1');

    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        archivedAt: expect.anything(),
        updatedAt: expect.anything(),
      })
    );
    const updatePayload = mocks.updateSet.mock.calls[0]?.[0];
    expect(updatePayload).not.toHaveProperty('status');
    expect(updatePayload).not.toHaveProperty('statusChangedAt');

    expect(mocks.teardownSession).toHaveBeenCalledWith('session-1', 'detach');
    expect(mocks.selectLimit).toHaveBeenCalledTimes(1);
  });
});

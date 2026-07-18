import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteSession } from './deleteSession';

const mocks = vi.hoisted(() => ({
  deleteWhere: vi.fn(),
  selectLimit: vi.fn(),
  teardownSession: vi.fn(),
  viewStateDel: vi.fn(),
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
    delete: () => ({
      where: mocks.deleteWhere,
    }),
  },
}));

vi.mock('@main/core/sessions/session-runtime-manager', () => ({
  sessionRuntimeManager: {
    teardownSession: mocks.teardownSession,
  },
}));

vi.mock('@main/core/view-state/view-state-service', () => ({
  viewStateService: {
    del: mocks.viewStateDel,
  },
}));

describe('deleteSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteWhere.mockResolvedValue(undefined);
    mocks.viewStateDel.mockResolvedValue(undefined);
  });

  it('does nothing when the session does not exist', async () => {
    mocks.selectLimit.mockResolvedValueOnce([]);
    await deleteSession('missing');
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
  });

  it('deletes the session row when it exists', async () => {
    mocks.selectLimit.mockResolvedValueOnce([{ id: 'session-1', agentId: 'agent-1' }]);
    mocks.teardownSession.mockResolvedValueOnce({ success: true });
    await deleteSession('session-1');
    expect(mocks.teardownSession).toHaveBeenCalledWith('session-1', 'terminate');
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
  });
});

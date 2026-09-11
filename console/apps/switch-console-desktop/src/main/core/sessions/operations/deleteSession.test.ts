import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteSession } from './deleteSession';

const mocks = vi.hoisted(() => ({
  deleteWhere: vi.fn(),
  selectLimit: vi.fn(),
  stopSaved: vi.fn(),
  teardownSession: vi.fn(),
  viewStateDel: vi.fn(),
}));

vi.mock('@main/core/sdk-host/stop-saved-session', () => ({ stopSavedSession: mocks.stopSaved }));
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
    mocks.stopSaved.mockResolvedValue(undefined);
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
    expect(mocks.teardownSession).toHaveBeenCalledWith('session-1', 'detach');
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
  });
});

it('retains the session when execution cannot be confirmed stopped', async () => {
  vi.clearAllMocks();
  mocks.selectLimit.mockResolvedValueOnce([{ id: 'session-1', agentId: 'agent-1' }]);
  mocks.stopSaved.mockRejectedValueOnce(new Error('Stop outcome unknown'));
  await expect(deleteSession('session-1')).rejects.toThrow('Stop outcome unknown');
  expect(mocks.teardownSession).not.toHaveBeenCalled();
});

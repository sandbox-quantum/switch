import { beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveSession } from './archiveSession';

const mocks = vi.hoisted(() => ({
  selectLimit: vi.fn(),
  stopSaved: vi.fn(),
  teardownSession: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
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
    mocks.stopSaved.mockResolvedValue(undefined);
    mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
    mocks.updateWhere.mockResolvedValue(undefined);
  });

  it('archives by detaching runtime without deleting location assets', async () => {
    mocks.selectLimit.mockResolvedValueOnce([
      {
        id: 'session-1',
        locationId: 'location-1',
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

it('retains the session when execution cannot be confirmed stopped', async () => {
  vi.clearAllMocks();
  mocks.selectLimit.mockResolvedValueOnce([{ id: 'session-1', agentId: 'agent-1' }]);
  mocks.stopSaved.mockRejectedValueOnce(new Error('Stop outcome unknown'));
  await expect(archiveSession('session-1')).rejects.toThrow('Stop outcome unknown');
  expect(mocks.teardownSession).not.toHaveBeenCalled();
});

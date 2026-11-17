import { beforeEach, describe, expect, it, vi } from 'vitest';

const clearStorageData = vi.hoisted(() => vi.fn(async () => {}));
const fromPartition = vi.hoisted(() => vi.fn(() => ({ clearStorageData })));
const listServers = vi.hoisted(() => vi.fn());
const dashboardWindowSessionsCleared = vi.hoisted(() => vi.fn());
const markDashboardWindowSessionsCleared = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({ session: { fromPartition } }));
vi.mock('./servers-store', () => ({ listServers }));
vi.mock('./dashboard-window-marker', () => ({
  dashboardWindowSessionsCleared,
  markDashboardWindowSessionsCleared,
}));
vi.mock('@main/lib/logger', () => ({ log: { warn, info: vi.fn(), error: vi.fn() } }));

const { clearDashboardWindowSessions } = await import('./dashboard-window-sessions');

describe('clearing what the old dashboard windows kept', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dashboardWindowSessionsCleared.mockResolvedValue(false);
    listServers.mockResolvedValue([{ id: 'srv-1' }, { id: 'srv-2' }]);
  });

  it('clears each stored server’s window session, then never again', async () => {
    await clearDashboardWindowSessions();

    expect(fromPartition.mock.calls).toEqual([
      ['persist:switch-gateway:srv-1'],
      ['persist:switch-gateway:srv-2'],
    ]);
    expect(clearStorageData).toHaveBeenCalledTimes(2);
    expect(markDashboardWindowSessionsCleared).toHaveBeenCalledOnce();

    dashboardWindowSessionsCleared.mockResolvedValue(true);
    vi.clearAllMocks();
    await clearDashboardWindowSessions();
    expect(fromPartition).not.toHaveBeenCalled();
  });

  it('says which could not be cleared, and tries again next time', async () => {
    clearStorageData.mockRejectedValueOnce(new Error('locked'));

    await clearDashboardWindowSessions();

    expect(clearStorageData).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      'switch-servers: could not clear the session an old dashboard window kept',
      { server: 'srv-1', error: 'Error: locked' }
    );
    expect(markDashboardWindowSessionsCleared).not.toHaveBeenCalled();
  });
});

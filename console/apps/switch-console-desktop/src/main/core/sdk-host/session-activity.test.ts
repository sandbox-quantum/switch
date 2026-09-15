import type { Session } from '@switch-console/shared/session-v1';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ returning: vi.fn(), emit: vi.fn() }));
vi.mock('@main/db/client', () => ({
  db: { update: () => ({ set: () => ({ where: () => ({ returning: mocks.returning }) }) }) },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));
import { sdkActivityStatus, syncSdkSessionActivity } from './session-activity';

describe('SDK sidebar activity', () => {
  it('stops working when execution returns to ready, without requiring a process exit', () => {
    expect(sdkActivityStatus({ status: 'running', pendingRequestIds: [] })).toBe('working');
    expect(sdkActivityStatus({ status: 'ready', pendingRequestIds: [] })).toBe('idle');
    expect(sdkActivityStatus({ status: 'stopped', pendingRequestIds: [] })).toBe('idle');
    expect(sdkActivityStatus({ status: 'error', pendingRequestIds: [] })).toBe('error');
  });
  it('shows requests as awaiting input instead of running', () => {
    expect(sdkActivityStatus({ status: 'running', pendingRequestIds: ['request'] })).toBe(
      'awaiting-input'
    );
  });
  it('notifies the sidebar on a changed row and avoids duplicate notifications', async () => {
    mocks.emit.mockClear();
    const session = {
      sessionId: 'session',
      status: 'ready',
      pendingRequestIds: [],
    } as unknown as Session;
    mocks.returning.mockResolvedValueOnce([{ id: 'session' }]).mockResolvedValueOnce([]);
    await syncSdkSessionActivity(session);
    await syncSdkSessionActivity(session);
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith(expect.anything(), {
      sessionId: 'session',
      status: 'idle',
      seen: true,
    });
  });
});

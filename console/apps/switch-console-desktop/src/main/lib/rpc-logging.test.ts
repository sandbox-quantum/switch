import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ManagedServerStoppedError,
  ServerBusyError,
} from '@shared/core/managed-switch-server/managed-switch-server';

const log = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.mock('./logger', () => ({ log }));
vi.mock('./log-context', () => ({
  runWithLogContext: (_context: unknown, run: () => unknown) => run(),
}));

const { withRPCLogContext } = await import('./rpc-logging');

beforeEach(() => vi.clearAllMocks());

async function fail(error: unknown): Promise<void> {
  await expect(
    withRPCLogContext('remoteSwitchServer.stop', ['vm-1'], () => Promise.reject(error))
  ).rejects.toBe(error);
}

describe('logging a failed call', () => {
  it('logs a real failure as an error, and still fails the call', async () => {
    await fail(new Error('compose down failed'));

    expect(log.error).toHaveBeenCalledWith(
      'RPC handler failed',
      expect.objectContaining({ component: 'rpc:remoteSwitchServer.stop' })
    );
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('keeps a refusal because another Console is changing the server out of the error log', async () => {
    await fail(
      new ServerBusyError(
        {
          name: 'bob@desk',
          hostAccount: 'bob',
          action: 'starting',
          heldForSeconds: 30,
          expiresInSeconds: 90,
        },
        'vm-1'
      )
    );

    expect(log.debug).toHaveBeenCalledWith('RPC handler failed', expect.anything());
    expect(log.error).not.toHaveBeenCalled();
  });

  it('keeps a call to a stopped server out of the error log', async () => {
    await fail(new ManagedServerStoppedError({ id: 'srv-1', name: 'Team server' }, 'stopped'));

    expect(log.debug).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});

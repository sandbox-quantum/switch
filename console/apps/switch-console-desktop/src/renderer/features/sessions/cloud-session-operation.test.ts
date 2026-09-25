import { expect, it, vi, afterEach } from 'vitest';
import { rpc } from '@renderer/lib/ipc';
import {
  CloudSessionOperationFailed,
  CloudSessionOperationUnknown,
  runCloudSessionOperation,
} from './cloud-session-operation';

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    sdkHost: { sharedList: vi.fn() },
    switchServers: {
      cloudSessionOperation: vi.fn(),
      cloudOperationStatus: vi.fn(),
    },
  },
}));
afterEach(() => vi.resetAllMocks());

it('reuses the start operation after a lost response', async () => {
  vi.mocked(rpc.switchServers.cloudSessionOperation)
    .mockRejectedValueOnce(new Error('Response lost'))
    .mockResolvedValueOnce({ state: 'applied' } as never);
  await expect(runCloudSessionOperation('server', 'launch', 'session', 'start')).rejects.toThrow(
    'Response lost'
  );
  await runCloudSessionOperation('server', 'launch', 'session', 'start');
  const calls = vi.mocked(rpc.switchServers.cloudSessionOperation).mock.calls;
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0]![2]).toEqual({ id: 'session', session_id: 'session', action: 'start' });
});

it('distinguishes a failed operation from an unknown outcome', async () => {
  vi.mocked(rpc.switchServers.cloudSessionOperation).mockResolvedValueOnce({
    state: 'failed',
    error: 'Start failed',
  } as never);
  await expect(
    runCloudSessionOperation('server', 'launch', 'session', 'start')
  ).rejects.toBeInstanceOf(CloudSessionOperationFailed);
});

it('inspects the original session after an unknown outcome', async () => {
  vi.mocked(rpc.sdkHost.sharedList).mockResolvedValue([]);
  vi.mocked(rpc.switchServers.cloudSessionOperation).mockResolvedValue({
    state: 'unknown',
    error: 'The outcome is unknown',
  } as never);
  await expect(
    runCloudSessionOperation('server', 'launch', 'session', 'start')
  ).rejects.toBeInstanceOf(CloudSessionOperationUnknown);
  expect(rpc.sdkHost.sharedList).toHaveBeenCalledWith('server');
  await expect(runCloudSessionOperation('server', 'launch', 'session', 'start')).rejects.toThrow(
    'unknown'
  );
  const calls = vi.mocked(rpc.switchServers.cloudSessionOperation).mock.calls;
  expect(calls[0]).toEqual(calls[1]);
});

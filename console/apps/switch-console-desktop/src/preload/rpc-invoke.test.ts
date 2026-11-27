import { expect, it, vi } from 'vitest';
import { RPC_CHANNELS_CHANNEL } from '@shared/lib/ipc/rpc';
import { createRpcInvoke } from './rpc-invoke';

function fakeMain(channels: string[]) {
  return vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === RPC_CHANNELS_CHANNEL) return channels;
    return { channel, args };
  });
}

it('passes a registered RPC channel through, asking main for the list once', async () => {
  const main = fakeMain(['agents.list', 'fs.watch.watchSetPaths']);
  const invoke = createRpcInvoke(main);

  expect(await invoke('agents.list', 1)).toEqual({ channel: 'agents.list', args: [1] });
  expect(await invoke('fs.watch.watchSetPaths')).toEqual({
    channel: 'fs.watch.watchSetPaths',
    args: [],
  });
  expect(main.mock.calls.filter(([channel]) => channel === RPC_CHANNELS_CHANNEL)).toHaveLength(1);
});

it('refuses any other channel without sending it', async () => {
  const main = fakeMain(['agents.list']);
  const invoke = createRpcInvoke(main);

  for (const channel of ['agents', 'agents.list.x', RPC_CHANNELS_CHANNEL, 'some-library:handle'])
    await expect(invoke(channel)).rejects.toThrow('is not an RPC channel');
  expect(main.mock.calls.map(([channel]) => channel)).toEqual([RPC_CHANNELS_CHANNEL]);
});

it('asks again after main could not answer', async () => {
  const main = vi
    .fn<(channel: string, ...args: unknown[]) => Promise<unknown>>()
    .mockRejectedValueOnce(new Error('No handler registered'))
    .mockResolvedValueOnce(['agents.list'])
    .mockResolvedValueOnce('ok');
  const invoke = createRpcInvoke(main);

  await expect(invoke('agents.list')).rejects.toThrow('No handler registered');
  expect(await invoke('agents.list')).toBe('ok');
});

import { RPC_CHANNELS_CHANNEL } from '@shared/lib/ipc/rpc';

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

/**
 * The renderer's `invoke`, held to the channels the main process registered
 * for its RPC router: it asks main for that list once (`rpcChannels`, the same
 * walk that registers them, so the two cannot drift) and refuses any other
 * channel before it leaves the preload. A failed ask is not kept, so the next
 * call asks again.
 */
export function createRpcInvoke(invoke: Invoke): Invoke {
  let allowed: Promise<ReadonlySet<string>> | null = null;
  const allowedChannels = () => {
    allowed ??= invoke(RPC_CHANNELS_CHANNEL).then(
      (channels) => new Set(channels as string[]),
      (error: unknown) => {
        allowed = null;
        throw error;
      }
    );
    return allowed;
  };
  return async (channel, ...args) => {
    if (!(await allowedChannels()).has(channel))
      throw new Error(`"${channel}" is not an RPC channel this app registered.`);
    return invoke(channel, ...args);
  };
}

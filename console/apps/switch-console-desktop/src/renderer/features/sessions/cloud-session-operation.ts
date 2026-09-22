import { rpc } from '@renderer/lib/ipc';

export async function runCloudSessionOperation(
  serverId: string,
  requestId: string,
  sessionId: string,
  action: 'start' | 'restart'
): Promise<void> {
  const id = crypto.randomUUID();
  let result = await rpc.switchServers.cloudSessionOperation(serverId, requestId, {
    id,
    session_id: sessionId,
    action,
  });
  const deadline = Date.now() + 180000;
  while (result.state === 'queued' || result.state === 'claimed') {
    if (Date.now() >= deadline)
      throw new Error(
        'The worker has not confirmed this operation. Check the session before trying again.'
      );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    result = await rpc.switchServers.cloudOperationStatus(serverId, requestId, id);
  }
  if (result.state !== 'applied')
    throw new Error(result.error ?? `Session operation ${result.state}.`);
}

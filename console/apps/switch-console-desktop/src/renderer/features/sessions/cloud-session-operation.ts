import { sessionSchema } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { rpc } from '@renderer/lib/ipc';

export class CloudSessionOperationFailed extends Error {}
export class CloudSessionOperationUnknown extends Error {}

async function inspectUnknownSession(serverId: string, sessionId: string): Promise<never> {
  let found: boolean;
  try {
    const sessions = z.array(z.unknown()).parse(await rpc.sdkHost.sharedList(serverId));
    found = sessions.some((row) => {
      const parsed = sessionSchema.safeParse(row);
      return parsed.success && parsed.data.sessionId === sessionId;
    });
  } catch (cause) {
    throw new CloudSessionOperationUnknown(
      'The start outcome is unknown and the session list could not be checked. Open session to inspect this same request.',
      { cause }
    );
  }
  throw new CloudSessionOperationUnknown(
    found
      ? 'The session exists, but its start was not confirmed. Open session to inspect it.'
      : 'The start outcome is unknown. No session is visible yet. Open session to inspect this same request.'
  );
}

export async function runCloudSessionOperation(
  serverId: string,
  requestId: string,
  sessionId: string,
  action: 'start' | 'restart'
): Promise<void> {
  const id = action === 'start' ? sessionId : crypto.randomUUID();
  let result = await rpc.switchServers.cloudSessionOperation(serverId, requestId, {
    id,
    session_id: sessionId,
    action,
  });
  const deadline = Date.now() + 180000;
  while (result.state === 'queued' || result.state === 'claimed') {
    if (Date.now() >= deadline) return inspectUnknownSession(serverId, sessionId);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    result = await rpc.switchServers.cloudOperationStatus(serverId, requestId, id);
  }
  if (result.state === 'failed')
    throw new CloudSessionOperationFailed(result.error ?? 'Session operation failed.');
  if (result.state !== 'applied') return inspectUnknownSession(serverId, sessionId);
}

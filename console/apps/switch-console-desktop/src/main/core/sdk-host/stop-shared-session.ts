import { setTimeout as delay } from 'node:timers/promises';
import { commandStatusSchema, snapshotSchema } from '@switch-console/shared/session-v1';
import {
  fetchSdkCommandStatus,
  fetchSdkSnapshot,
  retireSdkSession,
  submitSdkCommand,
} from '@main/core/switch-servers/gateway-client';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

export async function stopSharedSession(server: SwitchServer, sessionId: string): Promise<void> {
  const snapshot = snapshotSchema.parse(await fetchSdkSnapshot(server, sessionId));
  if (snapshot.session.status === 'stopped' || snapshot.session.retired) return;
  // Only a host applies `session.stop`, so a session whose host is gone — one
  // discovered from the server and never opened, or one whose host exited —
  // would wait out the poll below and then refuse to be deleted. Retiring is
  // the server-side route for exactly that case, and it refuses while a host
  // still holds the lease, which is what the command path is for.
  if (snapshot.session.connectivity !== 'online') {
    await retireSdkSession(server, sessionId, snapshot.session.epoch);
    return;
  }
  const commandId = `stop-${snapshot.session.epoch}`;
  await submitSdkCommand(server, {
    contractVersion: 1,
    sessionId: sessionId,
    epoch: snapshot.session.epoch,
    commandId,
    body: { type: 'session.stop' },
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    const receipt = commandStatusSchema.parse(
      await fetchSdkCommandStatus(server, sessionId, commandId)
    );
    if (receipt.commandId !== commandId) throw new Error('Stop receipt identity mismatch.');
    if (receipt.status === 'applied') return;
    if (receipt.status === 'unknown' || receipt.status === 'rejected')
      throw new Error(receipt.message ?? `Stop ${receipt.status}.`);
    await delay(500);
  }
  throw new Error('Stop delivery has not been confirmed. Check the session before retrying.');
}

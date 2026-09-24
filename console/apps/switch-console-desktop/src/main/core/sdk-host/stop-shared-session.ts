import { setTimeout as delay } from 'node:timers/promises';
import { GatewayError } from '@main/core/switch-servers/gateway-client';
import { log } from '@main/lib/logger';
import { hostJournals, JournalUnavailableError } from './host-journal';
import {
  CommandNotRecordedError,
  sessionCommandStatus,
  submitSessionCommand,
} from './session-commands';

/**
 * Ask a session's host to stop, and wait until it says it has.
 *
 * A host that is not running has nothing to stop, and a session whose journal
 * is not on the agent's host is not one this Console can reach: both return
 * without sending anything. With no watcher connected Switch cannot relay the
 * stop at all, which is refused rather than waited out.
 */
export async function stopSharedSession(agentId: string, sessionId: string): Promise<void> {
  let snapshot;
  try {
    snapshot = (await hostJournals.tail(agentId, sessionId)).snapshot();
  } catch (error) {
    if (error instanceof JournalUnavailableError) return;
    throw error;
  }
  if (snapshot.session.status === 'stopped' || snapshot.session.connectivity !== 'online') return;
  const commandId = `stop-${snapshot.session.epoch}`;
  try {
    await submitSessionCommand(agentId, {
      contractVersion: 1,
      sessionId,
      epoch: snapshot.session.epoch,
      commandId,
      body: { type: 'session.stop' },
    });
  } catch (error) {
    if (error instanceof GatewayError && error.status === 409)
      log.warn('The session could not be stopped: its agent’s watcher is not connected', {
        sessionId,
        error: String(error),
      });
    throw error;
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const receipt = await sessionCommandStatus(agentId, sessionId, commandId);
      if (receipt.status === 'applied') return;
      if (receipt.status === 'unknown' || receipt.status === 'rejected')
        throw new Error(receipt.message ?? `Stop ${receipt.status}.`);
    } catch (error) {
      if (!(error instanceof CommandNotRecordedError)) throw error;
    }
    await delay(500);
  }
  throw new Error('Stop delivery has not been confirmed. Check the session before retrying.');
}

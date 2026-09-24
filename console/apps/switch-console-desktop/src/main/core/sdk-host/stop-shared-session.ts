import { setTimeout as delay } from 'node:timers/promises';
import { JournalUnavailableError } from './host-journal';
import {
  CommandNotRecordedError,
  sessionCommandStatus,
  submitSessionCommand,
} from './session-commands';
import { currentSnapshot } from './transcripts';

/**
 * Ask a session's host to stop, and wait until it says it has.
 *
 * The stop goes straight to the host (Console's child, or the agent sidecar's
 * over SSH). A session no host is running, or whose host is offline or already
 * stopped, has nothing to stop and returns without sending anything.
 */
export async function stopSharedSession(agentId: string, sessionId: string): Promise<void> {
  let snapshot;
  try {
    snapshot = await currentSnapshot(agentId, sessionId);
  } catch (error) {
    if (error instanceof JournalUnavailableError) return;
    throw error;
  }
  if (snapshot.session.status === 'stopped' || snapshot.session.connectivity !== 'online') return;
  const commandId = `stop-${snapshot.session.epoch}`;
  await submitSessionCommand(agentId, {
    contractVersion: 1,
    sessionId,
    epoch: snapshot.session.epoch,
    commandId,
    body: { type: 'session.stop' },
  });
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

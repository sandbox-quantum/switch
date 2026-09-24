import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionUnavailableError, sharedSessionRoot } from '@switch-console/agent-providers';
import { snapshotSchema, type ServerEvent, type Snapshot } from '@switch-console/shared/session-v1';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import {
  sessionTranscriptEventChannel,
  sessionTranscriptResetChannel,
} from '@shared/core/sessions/sessionEvents';
import { hostJournals, JournalTail, JournalUnavailableError } from './host-journal';
import { localSessionLinks } from './local-host';
import { syncSdkSessionActivity } from './session-activity';
import { askHost } from './session-commands';
import { withSidecar } from './sidecar-control';

/**
 * A shared session's transcript, pushed to the windows showing it.
 *
 * The session's host is a child of Console (local) or of the agent's sidecar
 * (remote). Its snapshot is asked for over the host's IPC pipe, and every
 * event it records arrives on that pipe and is forwarded as it happens. A
 * session that is not running is read from its journal, and picks up live
 * again when its host starts, since the host goes on numbering the same
 * journal.
 */

type Open = { viewers: number; close: () => void };
const open = new Map<string, Open>();

async function isLocal(agentId: string): Promise<boolean> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error('Agent not found.');
  return !(await getAgentLocation(agent)).sshHost;
}

/** Whether a refusal means nothing is running the session, as either end words it. */
function notRunning(error: unknown): boolean {
  return (
    error instanceof SessionUnavailableError ||
    (error instanceof Error && error.message.includes('session host is not running'))
  );
}

function forward(sessionId: string, event: ServerEvent): void {
  events.emit(sessionTranscriptEventChannel, { sessionId, event }, sessionId);
  if (event.body.type === 'session.upsert')
    void syncSdkSessionActivity(event.body.session).catch((error: unknown) =>
      log.warn('Could not record session activity', { sessionId, error: String(error) })
    );
}

/** Read a local session's journal from disk, for a host that is not running. */
async function localJournalSnapshot(root: string): Promise<Snapshot> {
  const text = await readFile(join(root, 'events.jsonl'), 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new JournalUnavailableError('This session has not recorded anything yet.');
    throw error;
  });
  const tail = new JournalTail();
  tail.take(
    text
      .slice(0, text.lastIndexOf('\n') + 1)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.stringify({ event: JSON.parse(line) }))
      .join('\n') + '\n'
  );
  tail.take(JSON.stringify({ alive: false, lease: null }) + '\n');
  return tail.snapshot();
}

/**
 * The session as its host holds it right now. Raises `JournalUnavailableError`
 * while nothing is running it.
 */
export async function currentSnapshot(agentId: string, sessionId: string): Promise<Snapshot> {
  try {
    return snapshotSchema.parse(await askHost(agentId, sessionId, { type: 'snapshot' }));
  } catch (error) {
    if (notRunning(error)) throw new JournalUnavailableError('The session host is not running.');
    throw error;
  }
}

/** The session as last recorded: from its host if it runs, else its journal. */
async function recordedSnapshot(agentId: string, sessionId: string, local: boolean) {
  try {
    return await currentSnapshot(agentId, sessionId);
  } catch (error) {
    if (!(error instanceof JournalUnavailableError)) throw error;
  }
  return local
    ? localJournalSnapshot(sharedSessionRoot(sessionId))
    : (await hostJournals.tail(agentId, sessionId)).snapshot();
}

/**
 * Start pushing a session's events to the renderer (counted per viewer) and
 * return its snapshot. Events after the snapshot's `throughSequence` follow on
 * `sessionTranscriptEventChannel`.
 */
export async function openTranscript(agentId: string, sessionId: string): Promise<Snapshot> {
  const local = await isLocal(agentId);
  let entry = open.get(sessionId);
  if (!entry) {
    const close = local
      ? localSessionLinks.subscribe(sharedSessionRoot(sessionId), (event) =>
          forward(sessionId, event)
        )
      : await withSidecar(agentId, async (client) => {
          const unsubscribe = await client.subscribe(sessionId, (event) =>
            forward(sessionId, event)
          );
          // Events recorded while the connection is down never arrive, so the
          // windows showing the session reload it rather than carry on with a gap.
          const offClose = client.onClose((error) => {
            if (open.get(sessionId)?.close !== close) return;
            open.delete(sessionId);
            events.emit(
              sessionTranscriptResetChannel,
              { sessionId, reason: error.message },
              sessionId
            );
          });
          const close = () => {
            offClose();
            unsubscribe();
          };
          return close;
        });
    entry = { viewers: 0, close };
    open.set(sessionId, entry);
  }
  entry.viewers += 1;
  const snapshot = await recordedSnapshot(agentId, sessionId, local);
  await syncSdkSessionActivity(snapshot.session);
  return snapshot;
}

/** One viewer fewer; stop pushing once nobody is showing the session. */
export function closeTranscript(sessionId: string): void {
  const entry = open.get(sessionId);
  if (!entry) return;
  entry.viewers -= 1;
  if (entry.viewers > 0) return;
  entry.close();
  open.delete(sessionId);
}

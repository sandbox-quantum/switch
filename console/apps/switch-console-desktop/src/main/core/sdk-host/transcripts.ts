import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sharedSessionRoot } from '@switch-console/agent-providers';
import { snapshotSchema, type ServerEvent, type Snapshot } from '@switch-console/shared/session-v1';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { sessionTranscriptEventChannel } from '@shared/core/sessions/sessionEvents';
import { hostJournals, JournalTail, JournalUnavailableError } from './host-journal';
import { localSessionLinks } from './local-host';
import { syncSdkSessionActivity } from './session-activity';

/**
 * A shared session's transcript, pushed to the windows showing it.
 *
 * A local session's host is Console's child: its snapshot is asked for over
 * the IPC pipe, and every event it records arrives on the same pipe and is
 * forwarded as it happens. A local session that is not running is read from
 * its journal, and picks up live again when its host starts, since the host
 * goes on numbering the same journal. A remote session is read from its
 * host's journal over SSH until the sidecar relays it the same way.
 */

type Open = { viewers: number; close: () => void };
const open = new Map<string, Open>();

async function isLocal(agentId: string): Promise<boolean> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error('Agent not found.');
  return !(await getAgentLocation(agent)).sshHost;
}

function forward(sessionId: string, event: ServerEvent): void {
  events.emit(sessionTranscriptEventChannel, { sessionId, event }, sessionId);
  if (event.body.type === 'session.upsert')
    void syncSdkSessionActivity(event.body.session).catch((error: unknown) =>
      log.warn('Could not record session activity', { sessionId, error: String(error) })
    );
}

/** Read a local session's journal from disk, for a host that is not running. */
async function journalSnapshot(root: string): Promise<Snapshot> {
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
 * Start pushing a session's events to the renderer (counted per viewer) and
 * return its snapshot. Events after the snapshot's `throughSequence` follow on
 * `sessionTranscriptEventChannel`.
 */
export async function openTranscript(agentId: string, sessionId: string): Promise<Snapshot> {
  const local = await isLocal(agentId);
  let entry = open.get(sessionId);
  if (!entry) {
    if (local) {
      const unsubscribe = localSessionLinks.subscribe(sharedSessionRoot(sessionId), (event) =>
        forward(sessionId, event)
      );
      entry = { viewers: 0, close: unsubscribe };
    } else {
      let cursor = (await hostJournals.tail(agentId, sessionId)).snapshot().throughSequence;
      const timer = setInterval(() => {
        void hostJournals
          .tail(agentId, sessionId)
          .then((tail) => {
            for (const event of tail.after(cursor)) {
              forward(sessionId, event);
              cursor = event.sequence;
            }
          })
          .catch((error: unknown) =>
            log.warn('Could not read a remote session journal', {
              sessionId,
              error: String(error),
            })
          );
      }, 500);
      entry = { viewers: 0, close: () => clearInterval(timer) };
    }
    open.set(sessionId, entry);
  }
  entry.viewers += 1;
  let snapshot: Snapshot;
  if (!local) snapshot = (await hostJournals.tail(agentId, sessionId)).snapshot();
  else {
    const root = sharedSessionRoot(sessionId);
    snapshot = localSessionLinks.ready(root)
      ? snapshotSchema.parse(await localSessionLinks.request(root, { type: 'snapshot' }, 10000))
      : await journalSnapshot(root);
  }
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

/**
 * The session as its host holds it right now: asked over the IPC pipe for a
 * local host, read from the journal for a remote one. Raises
 * `JournalUnavailableError` while there is no host to ask and nothing
 * recorded.
 */
export async function currentSnapshot(agentId: string, sessionId: string): Promise<Snapshot> {
  if (!(await isLocal(agentId))) return (await hostJournals.tail(agentId, sessionId)).snapshot();
  const root = sharedSessionRoot(sessionId);
  if (!localSessionLinks.ready(root))
    throw new JournalUnavailableError('The session host is not running.');
  return snapshotSchema.parse(await localSessionLinks.request(root, { type: 'snapshot' }, 10000));
}

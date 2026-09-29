import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SessionReplica,
  serverEventSchema,
  snapshotSchema,
  type ServerEvent,
  type Snapshot,
} from '@switch-console/shared/session-v1';
import { liveSupervisor, sharedSessionRoot } from './launch';

/** What the host's state adds to a journal replay: its last lease on the session. */
export type JournalLease = { roomIds: string[] | null; retired: boolean | null } | null;

/** The journal cannot be read as a session (yet). */
export class JournalUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalUnavailableError';
  }
}

/**
 * A session rebuilt from its host's journal (`events.jsonl`), with what only
 * the host's state can add: whether its supervisor is alive and what its last
 * lease said about the session's rooms.
 */
export function replayJournal(
  events: ServerEvent[],
  alive: boolean | null,
  lease: JournalLease
): Snapshot {
  const first = events.find((event) => event.body.type === 'session.upsert');
  if (first?.body.type !== 'session.upsert')
    throw new JournalUnavailableError('The session host has not recorded the session yet.');
  let replica = new SessionReplica({
    contractVersion: 1,
    throughSequence: 0,
    session: first.body.session,
    turns: [],
    items: [],
    requests: [],
    commandStatuses: [],
    nextPageToken: null,
  });
  for (const event of events) {
    // A reset starts a new epoch in the same journal; the host rebuilds its
    // own view the same way.
    if (
      event.body.type === 'session.upsert' &&
      event.body.session.epoch !== replica.snapshot().session.epoch
    ) {
      const prior = replica.snapshot();
      prior.session = event.body.session;
      replica = new SessionReplica(prior);
    }
    replica.apply(event);
  }
  const snapshot = replica.snapshot();
  snapshot.session.connectivity = alive === false ? 'offline' : 'online';
  if (lease?.roomIds) snapshot.session.roomIds = lease.roomIds;
  if (lease?.retired !== null && lease?.retired !== undefined)
    snapshot.session.retired = lease.retired;
  return snapshotSchema.parse(snapshot);
}

async function completeLines(file: string): Promise<string[] | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(Boolean);
}

/** A session on this machine read from its journal, as `JournalTail.snapshot` reads it remotely. */
export async function readJournalSnapshot(sessionId: string): Promise<Snapshot> {
  const root = sharedSessionRoot(sessionId);
  const lines = await completeLines(join(root, 'events.jsonl'));
  if (lines === null)
    throw new JournalUnavailableError('This session’s host journal is not on the agent’s host.');
  const events: ServerEvent[] = [];
  for (const line of lines) {
    const event = serverEventSchema.parse(JSON.parse(line));
    const last = events.at(-1);
    if (last && event.sequence !== last.sequence + 1)
      throw new Error(
        `The session journal skipped from event ${last.sequence} to ${event.sequence}.`
      );
    events.push(event);
  }
  let lease: JournalLease = null;
  for (const line of ((await completeLines(join(root, 'shared-state.jsonl'))) ?? []).reverse()) {
    let record: {
      type?: unknown;
      snapshot?: { session?: { roomIds?: string[]; retired?: boolean } };
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== 'lease') continue;
    const session = record.snapshot?.session;
    lease = { roomIds: session?.roomIds ?? null, retired: session?.retired ?? null };
    break;
  }
  return replayJournal(events, (await liveSupervisor(root)) !== null, lease);
}

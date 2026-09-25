import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ServerEvent, Session } from '@switch-console/shared/session-v1';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JournalUnavailableError, readJournalSnapshot } from './journal-snapshot';
import type * as launch from './launch';
import { hostSessions, LIST_SCRIPT, listSessions, readHostSessions } from './session-list';

const paths = vi.hoisted(() => ({ base: '' }));
vi.mock('./launch', async (original) => ({
  ...(await original<typeof launch>()),
  sharedSessionsBase: () => paths.base,
  sharedSessionRoot: (id: string) =>
    path.join(paths.base, createHash('sha256').update(id).digest('hex')),
}));

const session = (sessionId: string, agentId: string): Session => ({
  sessionId,
  agentId,
  hostId: 'host',
  epoch: 'epoch-1',
  provider: 'claude',
  status: 'ready',
  connectivity: 'online',
  pendingRequestIds: [],
  capabilities: {
    input: 'queue',
    approvals: true,
    questions: true,
    interrupt: true,
    reset: true,
    compact: false,
    modelChange: false,
    attachmentMimeTypes: [],
  },
});

const event = (sessionId: string, sequence: number, body: ServerEvent['body']): ServerEvent => ({
  contractVersion: 1,
  eventId: `event-${sequence}`,
  sessionId,
  sequence,
  occurredAt: '2026-09-24T12:00:00.000Z',
  body,
});

async function record(
  sessionId: string,
  agentId: string,
  events: ServerEvent[],
  extra: Record<string, string>
) {
  const root = path.join(paths.base, createHash('sha256').update(sessionId).digest('hex'));
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, 'config.json'),
    JSON.stringify({ session: session(sessionId, agentId) })
  );
  await writeFile(
    path.join(root, 'events.jsonl'),
    events.map((e) => JSON.stringify(e) + '\n').join('')
  );
  for (const [name, text] of Object.entries(extra)) await writeFile(path.join(root, name), text);
  return root;
}

beforeEach(async () => {
  paths.base = await mkdtemp(path.join(tmpdir(), 'session-list-'));
});
afterEach(async () => {
  await rm(paths.base, { recursive: true, force: true });
});

it('lists the same sessions in-process as LIST_SCRIPT does over a shell', async () => {
  await record(
    'one',
    'agent',
    [
      event('one', 1, {
        type: 'session.upsert',
        session: { ...session('one', 'agent'), status: 'running' },
      }),
    ],
    {
      'handoff.jsonl': JSON.stringify({ roomId: '!room:example' }) + '\n',
    }
  );
  await record('two', 'agent', [], { 'inbox.jsonl': JSON.stringify({ type: 'stopped' }) + '\n' });
  await record('other', 'someone-else', [], {});

  const scripted = JSON.parse(
    execFileSync(process.execPath, ['-e', LIST_SCRIPT, 'agent', paths.base], { encoding: 'utf8' })
  );
  expect(readHostSessions(fs, path, 'agent', paths.base)).toEqual(scripted);
  const listed = listSessions('agent');
  expect(listed).toEqual(hostSessions(scripted));
  expect(
    listed
      .map((s) => [s.sessionId, s.status, s.roomIds, s.connectivity])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  ).toEqual([
    ['one', 'running', ['!room:example'], 'offline'],
    ['two', 'stopped', [], 'offline'],
  ]);
});

it('replays a session from its journal with its last lease', async () => {
  await record(
    'one',
    'agent',
    [
      event('one', 1, { type: 'session.upsert', session: session('one', 'agent') }),
      event('one', 2, {
        type: 'turn.upsert',
        turnId: 'turn',
        status: 'running',
        commandId: 'turn',
      }),
      event('one', 3, {
        type: 'session.upsert',
        session: { ...session('one', 'agent'), epoch: 'epoch-2' },
      }),
    ],
    {
      'shared-state.jsonl':
        JSON.stringify({
          type: 'lease',
          snapshot: { session: { roomIds: ['!room:example'], retired: false } },
        }) + '\n',
    }
  );
  const snapshot = await readJournalSnapshot('one');
  expect(snapshot.throughSequence).toBe(3);
  expect(snapshot.session).toMatchObject({
    epoch: 'epoch-2',
    connectivity: 'offline',
    roomIds: ['!room:example'],
    retired: false,
  });
  expect(snapshot.turns).toHaveLength(1);
});

it('refuses a journal that is not there or skips an event', async () => {
  await expect(readJournalSnapshot('absent')).rejects.toBeInstanceOf(JournalUnavailableError);
  await record(
    'gap',
    'agent',
    [
      event('gap', 1, { type: 'session.upsert', session: session('gap', 'agent') }),
      event('gap', 3, { type: 'session.upsert', session: session('gap', 'agent') }),
    ],
    {}
  );
  await expect(readJournalSnapshot('gap')).rejects.toThrow(/skipped from event 1 to 3/);
});

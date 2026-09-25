import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent, Session } from '@switch-console/shared/session-v1';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { HostJournals, JournalTail, JournalUnavailableError } from './host-journal';

vi.mock('@main/core/agents/connect-remote-agent', () => ({ connectRemoteAgent: vi.fn() }));
vi.mock('@main/core/agents/agent-location', () => ({ getAgentLocation: vi.fn() }));
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));

const session: Session = {
  sessionId: 'session',
  agentId: 'agent',
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
};

function event(sequence: number, body: ServerEvent['body']): ServerEvent {
  return {
    contractVersion: 1,
    eventId: `event-${sequence}`,
    sessionId: 'session',
    sequence,
    occurredAt: '2026-09-24T12:00:00.000Z',
    body,
  };
}

const lines = (...events: ServerEvent[]) =>
  events.map((e) => JSON.stringify({ event: e })).join('\n') + '\n';

const roots: string[] = [];
const journals: HostJournals[] = [];
afterEach(async () => {
  for (const journal of journals.splice(0)) journal.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('rebuilds the session from its journal, across a reset into a new epoch', () => {
  const tail = new JournalTail();
  tail.take(
    lines(
      event(1, { type: 'session.upsert', session }),
      event(2, { type: 'turn.upsert', turnId: 'turn', status: 'running', commandId: 'turn' }),
      event(3, { type: 'session.upsert', session: { ...session, epoch: 'epoch-2' } })
    )
  );
  tail.take(JSON.stringify({ alive: true, lease: { roomIds: ['room'], retired: false } }) + '\n');

  const snapshot = tail.snapshot();
  expect(snapshot.throughSequence).toBe(3);
  expect(snapshot.session).toMatchObject({
    epoch: 'epoch-2',
    connectivity: 'online',
    roomIds: ['room'],
    retired: false,
  });
  expect(snapshot.turns).toHaveLength(1);
  expect(tail.after(1).map((e) => e.sequence)).toEqual([2, 3]);
});

it('says the session is offline when its host is not running', () => {
  const tail = new JournalTail();
  tail.take(lines(event(1, { type: 'session.upsert', session })));
  tail.take(JSON.stringify({ alive: false, lease: null }) + '\n');
  expect(tail.snapshot().session.connectivity).toBe('offline');
});

it('reads a line split across chunks, and refuses a journal with a hole in it', () => {
  const tail = new JournalTail();
  const text = lines(event(1, { type: 'session.upsert', session }));
  tail.take(text.slice(0, 10));
  expect(tail.events).toEqual([]);
  tail.take(text.slice(10));
  expect(tail.events).toHaveLength(1);
  expect(() =>
    tail.take(lines(event(3, { type: 'notice', level: 'info', code: 'X', message: 'Hi' })))
  ).toThrow('skipped from event 1 to 3');
});

it('has no snapshot before the host has recorded the session', () => {
  expect(() => new JournalTail().snapshot()).toThrow(JournalUnavailableError);
});

async function hostRoot(base: string, sessionId: string): Promise<string> {
  const root = join(base, createHash('sha256').update(sessionId).digest('hex'));
  await mkdir(join(root, 'supervisor'), { recursive: true });
  return root;
}

it('tails a real journal as the host appends to it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'host-journal-'));
  roots.push(base);
  const root = await hostRoot(base, 'session');
  await writeFile(join(root, 'supervisor', 'owner.json'), JSON.stringify({ pid: process.pid }));
  await writeFile(
    join(root, 'events.jsonl'),
    JSON.stringify(event(1, { type: 'session.upsert', session })) + '\n'
  );
  const journal = new HostJournals(async () => new LocalExecutionContext(), base);
  journals.push(journal);

  const tail = await journal.tail('agent', 'session');
  expect(tail.snapshot().session.connectivity).toBe('online');

  await appendFile(
    join(root, 'events.jsonl'),
    JSON.stringify(event(2, { type: 'notice', level: 'info', code: 'X', message: 'Still going' })) +
      '\n'
  );
  await vi.waitFor(
    async () => expect((await journal.tail('agent', 'session')).after(1)).toHaveLength(1),
    { timeout: 5000 }
  );
});

it('says so when the session was never hosted there', async () => {
  const base = await mkdtemp(join(tmpdir(), 'host-journal-'));
  roots.push(base);
  const journal = new HostJournals(async () => new LocalExecutionContext(), base);
  journals.push(journal);
  await expect(journal.tail('agent', 'elsewhere')).rejects.toThrow(JournalUnavailableError);
});

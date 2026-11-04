import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { owesRestartReply } from './journal-snapshot';
import { addRestartReplyRound, RESTART_REPLY_ROUNDS } from './restart-rounds';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('./launch', () => ({
  sharedSessionRoot: (id: string) => join(paths.root, id),
  sharedSessionsBase: () => paths.root,
  liveSupervisor: () => Promise.resolve(null),
}));

beforeEach(async () => {
  paths.root = await mkdtemp(join(tmpdir(), 'journal-snapshot-'));
});
afterEach(async () => {
  await rm(paths.root, { recursive: true, force: true });
});

async function journal(sessionId: string, ...records: Record<string, unknown>[]) {
  await mkdir(join(paths.root, sessionId), { recursive: true });
  await writeFile(
    join(paths.root, sessionId, 'inbox.jsonl'),
    records.map((record) => `${JSON.stringify(record)}\n`).join('')
  );
}

it('owes a pending restart line until it is sent or given up on', async () => {
  const pending = { type: 'restart-reply', commandId: 'cut-off', state: 'pending' };
  await journal('s', pending);
  expect(await owesRestartReply('s')).toBe(true);
  for (let round = 1; round < RESTART_REPLY_ROUNDS; round++) {
    await addRestartReplyRound(join(paths.root, 's'), 'cut-off');
    expect(await owesRestartReply('s')).toBe(true);
  }
  await addRestartReplyRound(join(paths.root, 's'), 'cut-off');
  expect(await owesRestartReply('s')).toBe(false);
  await journal('t', pending, { ...pending, state: 'sent' });
  expect(await owesRestartReply('t')).toBe(false);
});

it('counts rounds per turn, so one given-up line does not hide another still owed', async () => {
  await journal(
    's',
    { type: 'restart-reply', commandId: 'old', state: 'pending' },
    { type: 'restart-reply', commandId: 'new', state: 'pending' }
  );
  for (let round = 0; round < RESTART_REPLY_ROUNDS; round++)
    await addRestartReplyRound(join(paths.root, 's'), 'old');
  expect(await owesRestartReply('s')).toBe(true);
});

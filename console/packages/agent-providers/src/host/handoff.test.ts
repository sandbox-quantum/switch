import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  declareHandoffCapability,
  handOff,
  HANDOFF_FILE,
  HANDOFF_PROTOCOL,
  HandoffInbox,
  readsHandoffs,
} from './handoff';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function root() {
  const created = await mkdtemp(join(tmpdir(), 'sdk-handoff-'));
  roots.push(created);
  return created;
}

it('routes to a worker only once it has said it reads what is routed to it', async () => {
  // A worker that does not read the inbox would leave the event unadmitted, and
  // nothing else admits it — so it would be lost rather than refused.
  const session = await root();
  expect(await readsHandoffs(session)).toBe(false);
  await declareHandoffCapability(session);
  expect(await readsHandoffs(session)).toBe(true);
});

it('does not route to a worker still speaking a protocol this controller has left behind', async () => {
  const session = await root();
  await writeFile(join(session, 'worker.json'), JSON.stringify({ handoff: HANDOFF_PROTOCOL - 1 }));
  expect(await readsHandoffs(session)).toBe(false);
});

it('reads a capability it cannot understand as one it cannot route to', async () => {
  const session = await root();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await writeFile(join(session, 'worker.json'), JSON.stringify({ handoff: 'yes' }));
  expect(await readsHandoffs(session)).toBe(false);
  expect(warning).toHaveBeenCalledOnce();
});

it('reads a capability file it cannot parse at all as one it cannot route to', async () => {
  // A marker caught half-written is not a reason to take the controller down
  // with a parse error on the way to routing an event.
  const session = await root();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await writeFile(join(session, 'worker.json'), '{"handoff":');
  expect(await readsHandoffs(session)).toBe(false);
  expect(warning).toHaveBeenCalledOnce();
});

it('hands over only what the worker has not already been given', async () => {
  const session = await root();
  const inbox = new HandoffInbox(session);
  expect(await inbox.drain()).toEqual([]);
  await handOff(session, { sequence: 4, roomId: 'room', messageId: 'four' });
  await handOff(session, { sequence: 6, roomId: 'other', messageId: 'six' });
  expect(await inbox.drain()).toEqual([
    { sequence: 4, roomId: 'room', messageId: 'four' },
    { sequence: 6, roomId: 'other', messageId: 'six' },
  ]);
  expect(await inbox.drain()).toEqual([]);
  await handOff(session, { sequence: 7, roomId: 'room', messageId: 'seven' });
  expect(await inbox.drain()).toMatchObject([{ sequence: 7 }]);
});

it('waits for the rest of a record still being written', async () => {
  // One process appends while another reads. A line that stops halfway is a
  // write in flight; reading it as a record would reject the whole inbox.
  const session = await root();
  const inbox = new HandoffInbox(session);
  const record = JSON.stringify({ sequence: 4, roomId: 'room', messageId: 'four' });
  await writeFile(join(session, HANDOFF_FILE), record.slice(0, 12));
  expect(await inbox.drain()).toEqual([]);
  await appendFile(join(session, HANDOFF_FILE), `${record.slice(12)}\n`);
  expect(await inbox.drain()).toEqual([{ sequence: 4, roomId: 'room', messageId: 'four' }]);
});

it('refuses an inbox that has lost records rather than reading past the loss', async () => {
  const session = await root();
  const inbox = new HandoffInbox(session);
  await handOff(session, { sequence: 4, roomId: 'room', messageId: 'four' });
  await inbox.drain();
  await writeFile(join(session, HANDOFF_FILE), '');
  await expect(inbox.drain()).rejects.toThrow('shrank');
});

it('returns as soon as the controller hands something over, rather than waiting out the poll', async () => {
  const session = await root();
  const inbox = new HandoffInbox(session);
  const stop = new AbortController();
  inbox.listen(stop.signal);
  try {
    const started = performance.now();
    const waiting = inbox.idle(30_000, stop.signal);
    await handOff(session, { sequence: 4, roomId: 'room', messageId: 'four' });
    await waiting;
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(await inbox.drain()).toMatchObject([{ sequence: 4 }]);
  } finally {
    stop.abort();
  }
});

it('does not sleep through a handoff that landed before it started waiting', async () => {
  // The controller appends between the read and the wait. Losing that wake-up
  // costs the message a full poll interval for no reason.
  const session = await root();
  const inbox = new HandoffInbox(session);
  const stop = new AbortController();
  inbox.listen(stop.signal);
  try {
    await inbox.drain();
    await handOff(session, { sequence: 4, roomId: 'room', messageId: 'four' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const outcome = await Promise.race([
      inbox.idle(30_000, stop.signal).then(() => 'woke'),
      new Promise((resolve) => setTimeout(() => resolve('slept'), 1_000)),
    ]);
    expect(outcome).toBe('woke');
  } finally {
    stop.abort();
  }
});

it('stops waiting when the session does', async () => {
  const session = await root();
  const inbox = new HandoffInbox(session);
  const stop = new AbortController();
  inbox.listen(stop.signal);
  const waiting = inbox.idle(30_000, stop.signal);
  stop.abort(new Error('session stopped'));
  await expect(waiting).rejects.toThrow('session stopped');
});

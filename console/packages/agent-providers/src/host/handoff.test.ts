import { appendFile, mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises';
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

it('reads the whole of what is waiting when a read returns short', async () => {
  // A read may return less than it was asked for. Trusting the requested length
  // would leave the rest of the buffer zeroed and step the position past
  // records nothing has read.
  const session = await root();
  const inbox = new HandoffInbox(session);
  await handOff(session, { sequence: 4, roomId: 'room', messageId: 'four' });
  await handOff(session, { sequence: 6, roomId: 'other', messageId: 'six' });
  const sample = await open(join(session, HANDOFF_FILE), 'r');
  const handles = Object.getPrototypeOf(sample);
  await sample.close();
  const whole = handles.read;
  vi.spyOn(handles, 'read').mockImplementation(function (this: FileHandle, ...args: unknown[]) {
    const [buffer, offset, length, position] = args as [Buffer, number, number, number];
    return whole.call(this, buffer, offset, Math.min(length, 7), position);
  });

  expect(await inbox.drain()).toEqual([
    { sequence: 4, roomId: 'room', messageId: 'four' },
    { sequence: 6, roomId: 'other', messageId: 'six' },
  ]);
  expect(await inbox.drain()).toEqual([]);
});

it('holds a character split across two reads as bytes rather than as halves', async () => {
  const session = await root();
  const inbox = new HandoffInbox(session);
  const record = Buffer.from(
    `${JSON.stringify({ sequence: 4, roomId: 'raum-✅', messageId: 'four' })}\n`
  );
  const inside = record.indexOf(Buffer.from('✅')) + 1;
  await writeFile(join(session, HANDOFF_FILE), record.subarray(0, inside));
  expect(await inbox.drain()).toEqual([]);
  await appendFile(join(session, HANDOFF_FILE), record.subarray(inside));
  expect(await inbox.drain()).toEqual([{ sequence: 4, roomId: 'raum-✅', messageId: 'four' }]);
});

it('drops the record a dying controller left unfinished, before writing over it', async () => {
  // The next append would otherwise run onto the end of the abandoned record,
  // and the worker would fail on that line for as long as the session lives.
  const session = await root();
  const inbox = new HandoffInbox(session);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await handOff(session, { sequence: 3, roomId: 'room', messageId: 'three' });
  await inbox.drain();
  await appendFile(join(session, HANDOFF_FILE), '{"sequence":4,"roomId":"room","mess');

  await handOff(session, { sequence: 5, roomId: 'room', messageId: 'five' });
  expect(warning).toHaveBeenCalledOnce();
  expect(await inbox.drain()).toEqual([{ sequence: 5, roomId: 'room', messageId: 'five' }]);
  await handOff(session, { sequence: 6, roomId: 'room', messageId: 'six' });
  expect(await inbox.drain()).toEqual([{ sequence: 6, roomId: 'room', messageId: 'six' }]);
});

it('keeps the records before a torn tail when the scan back reads short', async () => {
  // The scan back decides where to truncate. A read that stops early looks like
  // a file with no record terminator in it at all, and the repair would take
  // every complete record with the tail it was there to drop.
  const session = await root();
  const inbox = new HandoffInbox(session);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await handOff(session, { sequence: 4, roomId: 'room', messageId: 'four' });
  await appendFile(join(session, HANDOFF_FILE), '{"sequence":5,"roomId":"room","mess');
  const sample = await open(join(session, HANDOFF_FILE), 'r');
  const handles = Object.getPrototypeOf(sample);
  await sample.close();
  const whole = handles.read;
  vi.spyOn(handles, 'read').mockImplementation(function (this: FileHandle, ...args: unknown[]) {
    const [buffer, offset, length, position] = args as [Buffer, number, number, number];
    return whole.call(this, buffer, offset, Math.min(length, 7), position);
  });

  await handOff(session, { sequence: 6, roomId: 'room', messageId: 'six' });
  expect(await inbox.drain()).toEqual([
    { sequence: 4, roomId: 'room', messageId: 'four' },
    { sequence: 6, roomId: 'room', messageId: 'six' },
  ]);
});

it('refuses a complete record it cannot read rather than passing over it', async () => {
  // Only the writer knows a tail was abandoned, and it drops those bytes
  // itself. Anything else that will not read is damage, and skipping it would
  // lose the only copy of an event while the controller counts it delivered.
  const session = await root();
  const inbox = new HandoffInbox(session);
  await handOff(session, { sequence: 4, roomId: 'room', messageId: 'four' });
  await appendFile(join(session, HANDOFF_FILE), '{"sequence":5,"roomId":"room"}\n');
  await expect(inbox.drain()).rejects.toThrow();
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

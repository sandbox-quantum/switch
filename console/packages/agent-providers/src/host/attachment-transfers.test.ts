import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  AttachmentTransfers,
  STAGED_UNCONSUMED_MS,
  TRANSFER_IDLE_MS,
  type AttachmentChunk,
} from './attachment-transfers';
import { readStagedAttachment } from './attachments';

const paths = vi.hoisted(() => ({ base: '' }));
vi.mock('./launch', () => ({ sharedSessionRoot: (id: string) => join(paths.base, id) }));

let root: string;
beforeEach(async () => {
  paths.base = await mkdtemp(join(tmpdir(), 'transfers-'));
  root = join(paths.base, 'watcher');
  await mkdir(join(paths.base, 'session'), { recursive: true });
  await writeFile(join(paths.base, 'session', 'config.json'), '{}');
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(paths.base, { recursive: true, force: true });
});

function chunks(data: Buffer, size: number, transferId = 't1'): AttachmentChunk[] {
  const count = Math.ceil(data.byteLength / size);
  return Array.from({ length: count }, (_, index) => ({
    transferId,
    sessionId: 'session',
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: data.byteLength,
    sha256: createHash('sha256').update(data).digest('hex'),
    index,
    count,
    chunk: data.subarray(index * size, (index + 1) * size).toString('base64'),
  }));
}

it('stages a file sent in chunks, re-acknowledging a resent chunk', async () => {
  const transfers = new AttachmentTransfers(root);
  const data = Buffer.from('hello attachment world');
  const [first, second, third] = chunks(data, 8);
  expect(await transfers.receive(first!)).toEqual({ next: 1 });
  expect(await transfers.receive(first!)).toEqual({ next: 1 });
  expect(await transfers.receive(second!)).toEqual({ next: 2 });
  const done = (await transfers.receive(third!)) as { staged: { transferId: string; ref: string } };
  expect(done.staged.transferId).toBe('t1');
  expect(await transfers.receive(third!)).toEqual(done);
  const staged = await readStagedAttachment(join(paths.base, 'session'), {
    attachmentId: done.staged.ref,
    name: 'notes.txt',
    mimeType: 'text/plain',
    bytes: data.byteLength,
    sha256: null,
  });
  expect(Buffer.from(staged!.data).toString()).toBe('hello attachment world');
  expect(await readdir(join(root, 'relay-attachments'))).toEqual([]);
});

it('refuses a chunk ahead of the next expected one with that index', async () => {
  const transfers = new AttachmentTransfers(root);
  const [first, , third] = chunks(Buffer.from('hello attachment world'), 8);
  await transfers.receive(first!);
  await expect(transfers.receive(third!)).rejects.toMatchObject({
    code: 'out_of_order',
    detail: { expected: 1 },
  });
});

it('deletes a transfer whose bytes do not match its digest', async () => {
  const transfers = new AttachmentTransfers(root);
  const [only] = chunks(Buffer.from('hello'), 8);
  await expect(transfers.receive({ ...only!, sha256: '0'.repeat(64) })).rejects.toMatchObject({
    code: 'digest_mismatch',
  });
  expect(await readdir(join(root, 'relay-attachments'))).toEqual([]);
});

it('refuses a fifth transfer while four are staging', async () => {
  const transfers = new AttachmentTransfers(root);
  for (const id of ['a', 'b', 'c', 'd'])
    await transfers.receive(chunks(Buffer.from('hello attachment'), 4, id)[0]!);
  await expect(
    transfers.receive(chunks(Buffer.from('hello attachment'), 4, 'e')[0]!)
  ).rejects.toMatchObject({ code: 'staging_full' });
});

it('drops an idle partial transfer and a staged file nothing consumed', async () => {
  const transfers = new AttachmentTransfers(root);
  const [first] = chunks(Buffer.from('hello attachment world'), 8);
  await transfers.receive(first!);
  await transfers.sweep(Date.now() + TRANSFER_IDLE_MS);
  expect(await readdir(join(root, 'relay-attachments'))).toEqual([]);
  const [only] = chunks(Buffer.from('hello'), 8, 'kept');
  await transfers.receive(only!);
  await transfers.sweep(Date.now() + STAGED_UNCONSUMED_MS);
  expect(await readdir(join(paths.base, 'session', 'attachments'))).toEqual([]);
});

it('lets a command consume a staged ref once', async () => {
  const transfers = new AttachmentTransfers(root);
  const [only] = chunks(Buffer.from('hello'), 8);
  const { staged } = (await transfers.receive(only!)) as { staged: { ref: string } };
  transfers.consume([staged.ref, 'switch-attachment']);
  expect(() => transfers.consume([staged.ref])).toThrow(/already sent/);
  await transfers.sweep(Date.now() + STAGED_UNCONSUMED_MS);
  expect(await readdir(join(paths.base, 'session', 'attachments'))).toHaveLength(1);
});

it('refuses a transfer to a session that is not on this host', async () => {
  const transfers = new AttachmentTransfers(root);
  const [only] = chunks(Buffer.from('hello'), 8);
  await expect(transfers.receive({ ...only!, sessionId: 'absent' })).rejects.toMatchObject({
    code: 'not_found',
  });
});

it('does not remove files outside the relay attachments directory on cancel', async () => {
  const transfers = new AttachmentTransfers(root);
  const externalFile = join(paths.base, 'target.part');
  await writeFile(externalFile, 'important data');
  await transfers.cancel('../target');
  expect(await readFile(externalFile, 'utf8')).toBe('important data');
});

it('deletes partial file when cancelling valid transfer id', async () => {
  const transfers = new AttachmentTransfers(root);
  const [first] = chunks(Buffer.from('hello attachment world'), 8, 't-cancel');
  await transfers.receive(first!);
  const partFile = join(root, 'relay-attachments', 't-cancel.part');
  expect(await readFile(partFile)).toBeTruthy();
  await transfers.cancel('t-cancel');
  await expect(readFile(partFile)).rejects.toMatchObject({ code: 'ENOENT' });
});

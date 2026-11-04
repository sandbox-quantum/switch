import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { compactingPath, Journal } from './journal';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function journalAt(): Promise<{ path: string; journal: Journal<{ n: number }> }> {
  const root = await mkdtemp(join(tmpdir(), 'journal-compact-'));
  roots.push(root);
  const path = join(root, 'state', 'assignments.jsonl');
  const journal = await Journal.load(path, (value) => value as { n: number });
  return { path, journal };
}

const lines = async (path: string) =>
  (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

it('compacts to what it is told to keep, on disk and in memory, and appends after it', async () => {
  const { path, journal } = await journalAt();
  for (let n = 1; n <= 6; n++) await journal.append({ n });
  expect(await journal.compact((records) => records.filter((r) => r.n % 2 === 0))).toBe(3);
  expect(journal.records).toEqual([{ n: 2 }, { n: 4 }, { n: 6 }]);
  expect(await lines(path)).toEqual([{ n: 2 }, { n: 4 }, { n: 6 }]);
  await journal.append({ n: 7 });
  expect(await lines(path)).toEqual([{ n: 2 }, { n: 4 }, { n: 6 }, { n: 7 }]);
  const reloaded = await Journal.load(path, (value) => value as { n: number });
  expect(reloaded.records).toEqual([{ n: 2 }, { n: 4 }, { n: 6 }, { n: 7 }]);
});

it.skipIf(process.platform === 'win32')('keeps the journal 0600 after compacting', async () => {
  const { path, journal } = await journalAt();
  await journal.append({ n: 1 });
  await journal.append({ n: 2 });
  await journal.compact((records) => records.slice(1));
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it('leaves the file alone when nothing would go', async () => {
  const { path, journal } = await journalAt();
  await journal.append({ n: 1 });
  const before = (await stat(path)).mtimeMs;
  expect(await journal.compact((records) => [...records])).toBe(0);
  expect((await stat(path)).mtimeMs).toBe(before);
  await expect(stat(compactingPath(path))).rejects.toThrow();
});

it('queues behind appends already asked for, so none is lost to a compaction', async () => {
  const { path, journal } = await journalAt();
  const writes = [1, 2, 3].map((n) => journal.append({ n }));
  const compacted = journal.compact((records) => records.filter((r) => r.n !== 2));
  const after = journal.append({ n: 4 });
  await Promise.all([...writes, compacted, after]);
  expect(await lines(path)).toEqual([{ n: 1 }, { n: 3 }, { n: 4 }]);
});

it('removes a replacement left by a compaction cut off before its rename, and keeps the journal', async () => {
  const { path, journal } = await journalAt();
  await journal.append({ n: 1 });
  await journal.append({ n: 2 });
  // What a crash between writing the replacement and renaming it leaves.
  await writeFile(compactingPath(path), '{"n":2}\n', { mode: 0o600 });
  const reloaded = await Journal.load(path, (value) => value as { n: number });
  expect(reloaded.records).toEqual([{ n: 1 }, { n: 2 }]);
  await expect(stat(compactingPath(path))).rejects.toThrow();
});

it('keeps the journal whole when the replacement cannot be written', async () => {
  const { path, journal } = await journalAt();
  await journal.append({ n: 1 });
  await journal.append({ n: 2 });
  // A replacement already there that cannot be removed: a folder by that name.
  await mkdir(compactingPath(path));
  await writeFile(join(compactingPath(path), 'blocker'), '');
  await expect(journal.compact((records) => records.slice(1))).rejects.toThrow();
  expect(journal.records).toEqual([{ n: 1 }, { n: 2 }]);
  expect(await lines(path)).toEqual([{ n: 1 }, { n: 2 }]);
  // Not poisoned: a failed compaction leaves appends working.
  await journal.append({ n: 3 });
  expect(await lines(path)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
});

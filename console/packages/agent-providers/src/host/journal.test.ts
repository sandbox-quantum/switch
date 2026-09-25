import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Journal } from './journal';

it('reads complete records without creating or repairing an owned journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-reader-'));
  const path = join(root, 'journal.jsonl');
  try {
    expect(await Journal.read(path, (value) => value)).toEqual([]);
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    const contents = '{"type":"received"}\n{"type":';
    await writeFile(path, contents);
    expect(await Journal.read(path, (value) => value)).toEqual([{ type: 'received' }]);
    expect(await readFile(path, 'utf8')).toBe(contents);
    await expect(Journal.load(path, (value) => value)).rejects.toThrow('incomplete write');
    await writeFile(path, 'broken\n');
    await expect(Journal.read(path, (value) => value)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

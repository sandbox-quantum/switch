import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';

const dir = vi.hoisted(() => ({ path: '' }));
vi.mock('./paths', () => ({ localServerDir: () => dir.path }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { readLocalActivity, recordLocalActivity } = await import('./local-activity');

beforeEach(async () => {
  dir.path = await mkdtemp(join(tmpdir(), 'local-activity-'));
});

it('is empty before anything has happened', async () => {
  await expect(readLocalActivity()).resolves.toEqual([]);
});

it('keeps what happened, most recent first', async () => {
  await recordLocalActivity('started', null);
  await recordLocalActivity('start-failed', 'port in use');

  const entries = await readLocalActivity();
  expect(entries.map((e) => [e.action, e.detail])).toEqual([
    ['start-failed', 'port in use'],
    ['started', null],
  ]);
});

it('keeps only the latest fifty', async () => {
  for (let i = 0; i < 55; i++) await recordLocalActivity('started', null);
  expect(await readLocalActivity()).toHaveLength(50);
});

it('says so when the history cannot be read, rather than showing it as empty', async () => {
  await writeFile(join(dir.path, 'activity.json'), '{not json', 'utf8');
  await expect(readLocalActivity()).rejects.toThrow();
});

it('starts a new history over one it cannot read', async () => {
  await writeFile(join(dir.path, 'activity.json'), '{not json', 'utf8');
  await recordLocalActivity('stopped', null);
  expect((await readLocalActivity()).map((e) => e.action)).toEqual(['stopped']);
});

import { describe, expect, it } from 'vitest';
import type { CloudFileEntry } from '@shared/core/cloud-files/cloud-files';
import {
  childPath,
  entryTitle,
  formatChanged,
  formatChangedFull,
  formatSize,
  parentPath,
  pathCrumbs,
  sortEntries,
  zipLabel,
} from './cloud-files-format';

const folder = (name: string, over: Partial<CloudFileEntry> = {}): CloudFileEntry => ({
  name,
  kind: 'folder',
  size: 0,
  mtime: 0,
  ...over,
});
const file = (name: string): CloudFileEntry => ({ name, kind: 'file', size: 1, mtime: 0 });

describe('paths', () => {
  it('joins, climbs and crumbs box-relative paths', () => {
    expect(childPath('', 'shared')).toBe('shared');
    expect(childPath('shared', 'sample-bakery')).toBe('shared/sample-bakery');
    expect(parentPath('shared/sample-bakery/dist')).toBe('shared/sample-bakery');
    expect(parentPath('shared')).toBe('');
    expect(pathCrumbs('')).toEqual([]);
    expect(pathCrumbs('shared/sample-bakery')).toEqual([
      { name: 'shared', path: 'shared' },
      { name: 'sample-bakery', path: 'shared/sample-bakery' },
    ]);
  });
});

describe('formatSize', () => {
  it('reads in B, KB, MB and GB', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2 KB');
    expect(formatSize(5 * 1024 ** 2 + 1)).toBe('5.0 MB');
    expect(formatSize(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});

describe('formatChanged', () => {
  const now = new Date(2026, 10, 5, 15, 0).getTime();
  const ago = (ms: number) => formatChanged(now - ms, now);

  it('says how long ago, the same way Switch web does, then the date after a week', () => {
    expect(ago(20_000)).toBe('Just now');
    expect(ago(5 * 60_000)).toBe('5 min ago');
    expect(ago(2 * 3_600_000)).toBe('2 hr ago');
    expect(ago(26 * 3_600_000)).toBe('1 day ago');
    expect(ago(7 * 86_400_000)).toBe('7 days ago');
    expect(formatChanged(new Date(2026, 9, 1).getTime(), now)).toBe('2026-10-01');
    expect(formatChanged(now + 60_000, now)).toBe('2026-11-05');
  });

  it('gives the full date and time for the hover', () => {
    expect(formatChangedFull(new Date(2026, 6, 2, 9, 5).getTime())).toBe('2026-07-02 9:05 AM');
    expect(formatChangedFull(new Date(2026, 6, 2, 0, 30).getTime())).toBe('2026-07-02 12:30 AM');
    expect(formatChangedFull(new Date(2026, 6, 2, 13, 30).getTime())).toBe('2026-07-02 1:30 PM');
  });
});

describe('zipLabel', () => {
  it('says all at the top level and folder inside one', () => {
    expect(zipLabel('')).toBe('Download all as zip');
    expect(zipLabel('shared/sample-bakery')).toBe('Download folder as zip');
  });
});

describe('sortEntries', () => {
  it('puts folders before files, and at the top level agent folders before Shared', () => {
    const entries = [
      file('notes.txt'),
      folder('shared', { label: 'Shared' }),
      folder('web-frontend', { label: 'Web Frontend', agent: 'web-frontend' }),
      folder('baker', { label: 'Baker', agent: 'baker' }),
    ];
    expect(sortEntries(entries, true).map((e) => e.name)).toEqual([
      'baker',
      'web-frontend',
      'shared',
      'notes.txt',
    ]);
    expect(sortEntries(entries, false).map((e) => e.name)).toEqual([
      'baker',
      'shared',
      'web-frontend',
      'notes.txt',
    ]);
  });

  it('sorts names as people do, with numbers in order', () => {
    expect(sortEntries([file('img10.png'), file('img2.png')], false).map((e) => e.name)).toEqual([
      'img2.png',
      'img10.png',
    ]);
  });
});

describe('entryTitle', () => {
  it('uses the label where there is one, otherwise the name', () => {
    expect(entryTitle(folder('web', { label: 'Web Frontend' }))).toBe('Web Frontend');
    expect(entryTitle(file('a.txt'))).toBe('a.txt');
  });
});

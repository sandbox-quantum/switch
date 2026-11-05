import { describe, expect, it } from 'vitest';
import type { CloudFileEntry } from '@shared/core/cloud-files/cloud-files';
import {
  childPath,
  entryTitle,
  formatChanged,
  formatSize,
  parentPath,
  pathCrumbs,
  sortEntries,
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
    expect(childPath('shared', 'crumb-and-co')).toBe('shared/crumb-and-co');
    expect(parentPath('shared/crumb-and-co/dist')).toBe('shared/crumb-and-co');
    expect(parentPath('shared')).toBe('');
    expect(pathCrumbs('')).toEqual([]);
    expect(pathCrumbs('shared/crumb-and-co')).toEqual([
      { name: 'shared', path: 'shared' },
      { name: 'crumb-and-co', path: 'shared/crumb-and-co' },
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

  it('shows a time for today, a day and month for this year, a full date before', () => {
    expect(formatChanged(new Date(2026, 10, 5, 9, 30).getTime(), now)).toMatch(/09.?30|9:30/);
    expect(formatChanged(new Date(2026, 2, 1).getTime(), now)).not.toMatch(/2026/);
    expect(formatChanged(new Date(2025, 2, 1).getTime(), now)).toMatch(/2025/);
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

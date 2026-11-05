import { describe, expect, it } from 'vitest';
import {
  FILES_CHUNK_MAX,
  FILES_PAGE_MAX,
  filesPath,
  LAUNCHER_LINE_MAX,
  launcherOrderSchema,
  launcherReportSchema,
  plainName,
} from './launcher-protocol';

describe('a plain name', () => {
  it.each(['a', 'notes.md', '.hidden', 'ünïcode', 'x'.repeat(255)])('accepts %s', (name) => {
    expect(plainName.safeParse(name).success).toBe(true);
  });

  it.each(['', '.', '..', 'a/b', 'a\\b', 'a\u0000b', 'x'.repeat(256), 'é'.repeat(128)])(
    'refuses %j',
    (name) => {
      expect(plainName.safeParse(name).success).toBe(false);
    }
  );
});

describe('a files path', () => {
  it.each(['', 'agent-a', 'shared/sample-bakery/site/index.html'])('accepts %j', (path) => {
    expect(filesPath.safeParse(path).success).toBe(true);
  });

  it.each([
    '/etc/passwd',
    '../agents',
    'a/../b',
    'a//b',
    'a/',
    '/',
    'a/./b',
    'a\\..\\b',
    'a\u0000',
  ])('refuses %j', (path) => {
    expect(filesPath.safeParse(path).success).toBe(false);
  });
});

describe('the path bounds', () => {
  it('takes 64 parts and 4,096 bytes, and refuses one more of either', () => {
    expect(filesPath.safeParse(Array(64).fill('a').join('/')).success).toBe(true);
    expect(filesPath.safeParse(Array(65).fill('a').join('/')).success).toBe(false);
    const exact = Array(17).fill('x'.repeat(240)).join('/');
    expect(Buffer.byteLength(exact)).toBe(4096);
    expect(filesPath.safeParse(exact).success).toBe(true);
    expect(filesPath.safeParse(`${exact}y`).success).toBe(false);
    // Bytes, not characters: 2,057 two-byte letters and 16 slashes are 4,130 bytes.
    expect(filesPath.safeParse(Array(17).fill('é'.repeat(121)).join('/')).success).toBe(false);
  });
});

describe('the orders', () => {
  it('takes each file order in its exact shape', () => {
    for (const order of [
      { kind: 'files_list', id: 1, path: 'a' },
      { kind: 'files_list', id: 1, path: '', cursor: 'last-name' },
      { kind: 'files_read', id: 2, path: 'a/b.txt', offset: 0, length: FILES_CHUNK_MAX },
      { kind: 'files_zip', id: 3, path: 'a', includeCaches: false },
      { kind: 'files_more', id: 3 },
      { kind: 'files_cancel', id: 3 },
    ])
      expect(launcherOrderSchema.safeParse(order).success).toBe(true);
  });

  it.each([
    { kind: 'files_read', id: 2, path: 'a', offset: 0, length: FILES_CHUNK_MAX + 1 },
    { kind: 'files_read', id: 2, path: 'a', offset: 0, length: 0 },
    { kind: 'files_read', id: 2, path: '../x', offset: 0, length: 1 },
    { kind: 'files_list', id: 1, path: 'a', cursor: '../b' },
    { kind: 'files_list', id: 1, path: 'a', root: '/' },
    { kind: 'files_zip', id: 3, path: 'a' },
  ])('refuses %j', (order) => {
    expect(launcherOrderSchema.safeParse(order).success).toBe(false);
  });
});

describe('the reports', () => {
  it('takes a full page that still fits on one line', () => {
    const entries = Array.from({ length: FILES_PAGE_MAX }, (_, i) => ({
      name: `file-${String(i).padStart(4, '0')}.txt`,
      kind: 'file' as const,
      size: 123,
      mtime: 1_762_300_000_000,
    }));
    const reply = { kind: 'reply', id: 1, ok: true, listing: { entries, cursor: 'file-0999.txt' } };
    expect(launcherReportSchema.safeParse(reply).success).toBe(true);
    expect(JSON.stringify(reply).length).toBeLessThan(LAUNCHER_LINE_MAX);
  });

  it('refuses a page with a name that is a path, or too many entries', () => {
    const entry = { name: 'a/b', kind: 'file', size: 1, mtime: 1 };
    expect(
      launcherReportSchema.safeParse({
        kind: 'reply',
        id: 1,
        ok: true,
        listing: { entries: [entry] },
      }).success
    ).toBe(false);
    const many = Array.from({ length: FILES_PAGE_MAX + 1 }, (_, i) => ({
      name: `f${i}`,
      kind: 'file',
      size: 1,
      mtime: 1,
    }));
    expect(
      launcherReportSchema.safeParse({ kind: 'reply', id: 1, ok: true, listing: { entries: many } })
        .success
    ).toBe(false);
  });

  it('takes a full chunk, and its line fits', () => {
    const data = Buffer.alloc(FILES_CHUNK_MAX, 0xff).toString('base64');
    const chunk = { kind: 'files_chunk', id: 3, seq: 0, data, last: false };
    expect(launcherReportSchema.safeParse(chunk).success).toBe(true);
    expect(JSON.stringify(chunk).length).toBeLessThan(LAUNCHER_LINE_MAX);
  });

  it.each([
    ['over the chunk size', Buffer.alloc(FILES_CHUNK_MAX + 3).toString('base64')],
    ['not base64', 'not base64!'],
  ])('refuses a chunk %s', (_name, data) => {
    expect(
      launcherReportSchema.safeParse({ kind: 'files_chunk', id: 3, seq: 0, data, last: true })
        .success
    ).toBe(false);
  });

  it('takes the file refusal codes', () => {
    for (const code of ['outside_root', 'denied', 'not_found', 'too_large', 'not_regular', 'busy'])
      expect(
        launcherReportSchema.safeParse({ kind: 'reply', id: 1, ok: false, code }).success
      ).toBe(true);
  });
});

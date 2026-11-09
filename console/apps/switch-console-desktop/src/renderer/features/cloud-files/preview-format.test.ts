import { describe, expect, it } from 'vitest';
import type { CloudFileEntry } from '@shared/core/cloud-files/cloud-files';
import { neighbourFiles, parseCsv, prettyJson } from './preview-format';

describe('parseCsv', () => {
  it('reads quotes, doubled quotes, delimiters and line breaks inside quotes', () => {
    const table = parseCsv('item,note\r\n"rye, dark","says ""hi"""\n"two\nlines",plain\n');
    expect(table.header).toEqual(['item', 'note']);
    expect(table.rows).toEqual([
      ['rye, dark', 'says "hi"'],
      ['two\nlines', 'plain'],
    ]);
    expect(table.totalRows).toBe(2);
    expect(table.moreColumns).toBe(false);
  });

  it('reads tab-separated files, and drops a byte-order mark', () => {
    expect(parseCsv('\uFEFFa\tb\n1\t2', '\t')).toMatchObject({
      header: ['a', 'b'],
      rows: [['1', '2']],
    });
  });

  it('shows at most the row and column caps, and counts every row', () => {
    const wide = Array.from({ length: 60 }, (_, i) => `c${i}`).join(',');
    const text = [wide, ...Array.from({ length: 1500 }, (_, i) => `${i},x`)].join('\n');
    const table = parseCsv(text);
    expect(table.header).toHaveLength(50);
    expect(table.rows).toHaveLength(1000);
    expect(table.totalRows).toBe(1500);
    expect(table.moreColumns).toBe(true);
  });

  it('keeps markup in a cell as plain text', () => {
    expect(parseCsv('a\n<img src=x onerror=alert(1)>').rows).toEqual([
      ['<img src=x onerror=alert(1)>'],
    ]);
  });
});

describe('prettyJson', () => {
  it('lays valid JSON out two spaces deep, and gives null for anything else', () => {
    expect(prettyJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(prettyJson('{a:1}')).toBeNull();
    expect(prettyJson('alert(1)')).toBeNull();
  });
});

describe('neighbourFiles', () => {
  const entry = (name: string, kind: 'file' | 'folder' = 'file'): CloudFileEntry => ({
    name,
    kind,
    size: 1,
    mtime: 0,
  });
  const entries = [entry('dist', 'folder'), entry('a.txt'), entry('src', 'folder'), entry('b.md')];

  it('skips folders and stops at the ends', () => {
    expect(neighbourFiles(entries, 'a.txt')).toEqual({ previous: null, next: entries[3] });
    expect(neighbourFiles(entries, 'b.md')).toEqual({ previous: entries[1], next: null });
    expect(neighbourFiles(entries, 'gone.txt')).toEqual({ previous: null, next: null });
  });
});

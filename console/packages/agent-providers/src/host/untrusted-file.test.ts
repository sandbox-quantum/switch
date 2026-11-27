import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { parseUntrustedJson, readUntrusted } from './untrusted-file';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'untrusted-file-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('reads a small regular file, and answers null for one that is not there', async () => {
  writeFileSync(join(dir, 'a.json'), '{"x":1}');
  expect(await readUntrusted(join(dir, 'a.json'), { maxBytes: 64 })).toBe('{"x":1}');
  expect(await readUntrusted(join(dir, 'missing.json'), { maxBytes: 64 })).toBeNull();
});

it('refuses a link, an oversized file and a FIFO, quoting none of them', async () => {
  writeFileSync(join(dir, 'target'), 'SECRET');
  symlinkSync(join(dir, 'target'), join(dir, 'link'));
  await expect(readUntrusted(join(dir, 'link'), { maxBytes: 64 })).rejects.toThrow('is a link');
  writeFileSync(join(dir, 'big'), 'x'.repeat(65));
  await expect(readUntrusted(join(dir, 'big'), { maxBytes: 64 })).rejects.toThrow('larger than');
  if (process.platform !== 'win32') {
    execFileSync('mkfifo', [join(dir, 'fifo')]);
    await expect(readUntrusted(join(dir, 'fifo'), { maxBytes: 64 })).rejects.toThrow(
      'not a regular file'
    );
  }
});

it('refuses a file reached through a linked directory when it must be within a root', async () => {
  const root = join(dir, 'root');
  const outside = join(dir, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, 'record.json'), 'SECRET');
  symlinkSync(outside, join(root, 'sub'));
  const error = await readUntrusted(join(root, 'sub', 'record.json'), {
    maxBytes: 64,
    within: root,
  }).catch((e: Error) => e);
  expect((error as Error).message).toContain('is not inside');
  expect((error as Error).message).not.toContain('SECRET');
});

it('names where JSON went wrong without quoting it', () => {
  const schema = z.object({ port: z.number() });
  expect(() => parseUntrustedJson('SECRET', schema, 'f.json')).toThrow('f.json is not JSON.');
  expect(() => parseUntrustedJson('{"port":"SECRET"}', schema, 'f.json')).toThrow(
    'f.json is not in the expected shape (at port).'
  );
  expect(parseUntrustedJson('{"port":1}', schema, 'f.json')).toEqual({ port: 1 });
});

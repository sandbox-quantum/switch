import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { markDownloaded, quarantineValue, saveToDisk } from './save';

// Saving a cloud file: streamed to disk, marked as downloaded, and nothing left
// behind when it's cancelled or fails.

function folder(): string {
  return mkdtempSync(join(tmpdir(), 'cloud-save-'));
}

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part);
}

describe('saveToDisk', () => {
  it('a cancelled save fetches nothing and writes nothing', async () => {
    const dir = folder();
    const open = vi.fn(async () => chunks('x'));
    expect(
      await saveToDisk('a.txt', open, { chooseTarget: async () => null, mark: vi.fn() })
    ).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes the file whole, marks it downloaded, and leaves no partial file', async () => {
    const dir = folder();
    const target = join(dir, 'site.zip');
    const mark = vi.fn(async (path: string) => {
      expect(readFileSync(path, 'utf8')).toBe('hello world');
    });
    expect(
      await saveToDisk('site.zip', async () => chunks('hello ', 'world'), {
        chooseTarget: async () => target,
        mark,
      })
    ).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('hello world');
    expect(mark).toHaveBeenCalledTimes(1);
    expect(readdirSync(dir)).toEqual(['site.zip']);
  });

  it('a failure part way removes the partial file and leaves what was already there', async () => {
    const dir = folder();
    const target = join(dir, 'a.txt');
    writeFileSync(target, 'old');
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('part');
      throw new Error('cut off');
    }
    await expect(
      saveToDisk('a.txt', async () => broken(), { chooseTarget: async () => target, mark: vi.fn() })
    ).rejects.toThrow('cut off');
    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['a.txt']);
  });

  it('a file that cannot be marked as downloaded is removed, and the person is told', async () => {
    const dir = folder();
    const target = join(dir, 'run.command');
    await expect(
      saveToDisk('run.command', async () => chunks('#!/bin/sh'), {
        chooseTarget: async () => target,
        mark: async () => {
          throw new Error('xattr failed');
        },
      })
    ).rejects.toThrow('xattr failed');
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('streams a web ReadableStream (a zip body) as well', async () => {
    const dir = folder();
    const target = join(dir, 'f.zip');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('PK'));
        controller.close();
      },
    });
    await saveToDisk('f.zip', async () => body, {
      chooseTarget: async () => target,
      mark: vi.fn(),
    });
    expect(readFileSync(target, 'utf8')).toBe('PK');
  });
});

describe('markDownloaded', () => {
  it('on macOS writes com.apple.quarantine as a browser does', async () => {
    const exec = vi.fn(async () => {});
    await markDownloaded('/tmp/x', 'darwin', exec);
    expect(exec).toHaveBeenCalledWith('/usr/bin/xattr', [
      '-w',
      'com.apple.quarantine',
      expect.stringMatching(/^0083;[0-9a-f]+;Switch Console;[0-9A-F-]{36}$/),
      '/tmp/x',
    ]);
  });

  it('elsewhere does nothing', async () => {
    const exec = vi.fn(async () => {});
    await markDownloaded('/tmp/x', 'linux', exec);
    expect(exec).not.toHaveBeenCalled();
  });

  it('the value carries the time in hex seconds', () => {
    expect(quarantineValue(0x65000000 * 1000, 'ID')).toBe('0083;65000000;Switch Console;ID');
  });
});

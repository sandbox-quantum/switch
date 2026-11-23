import { describe, expect, it } from 'vitest';
import {
  bytesReply,
  errorReply,
  FILES_CHUNK_BYTES,
  filesCancelSchema,
  filesMoreSchema,
  filesRequestSchema,
  pathShapeProblem,
} from './files-frames';

const ok = (over: Record<string, unknown> = {}) =>
  filesRequestSchema.safeParse({ id: 'r-1', op: 'list', path: 'writer/src', ...over }).success;

describe('files.request', () => {
  it('takes a list, read or zip with a box-relative path', () => {
    expect(ok()).toBe(true);
    expect(ok({ path: '' })).toBe(true);
    expect(ok({ op: 'read', offset: 0, length: FILES_CHUNK_BYTES })).toBe(true);
    expect(ok({ op: 'zip', caches: false })).toBe(true);
  });

  it('refuses unknown operations, extra fields and bad ids', () => {
    expect(ok({ op: 'write' })).toBe(false);
    expect(ok({ extra: 1 })).toBe(false);
    expect(ok({ id: '' })).toBe(false);
    expect(ok({ id: 'x'.repeat(65) })).toBe(false);
    expect(ok({ id: 'has space' })).toBe(false);
  });

  it('refuses a read longer than one chunk, or a negative offset', () => {
    expect(ok({ op: 'read', length: FILES_CHUNK_BYTES + 1 })).toBe(false);
    expect(ok({ op: 'read', offset: -1 })).toBe(false);
  });

  it.each([
    ['/etc/passwd', 'absolute'],
    ['writer/../controller', 'bad_part'],
    ['./writer', 'bad_part'],
    ['writer//src', 'bad_part'],
    ['writer/', 'bad_part'],
    ['a\\b', 'bad_part'],
    ['a\0b', 'nul'],
    ['a/'.repeat(64) + 'z', 'too_many_parts'],
    ['é'.repeat(2049), 'too_long'],
  ])('refuses the path shape %#: %s', (path, why) => {
    expect(pathShapeProblem(path)).toBe(why);
    expect(ok({ path })).toBe(false);
  });

  it('accepts 64 parts and 4,096 bytes exactly', () => {
    expect(pathShapeProblem(Array.from({ length: 64 }, () => 'a').join('/'))).toBeNull();
    // 17 names of 240 bytes and 16 slashes: 4,096 bytes, each name within 255.
    expect(
      pathShapeProblem(Array.from({ length: 17 }, () => 'a'.repeat(240)).join('/'))
    ).toBeNull();
    expect(pathShapeProblem('a'.repeat(256))).toBe('bad_part');
  });

  it('never echoes the path in its refusal', () => {
    const result = filesRequestSchema.safeParse({ id: 'r', op: 'list', path: '/secret-name' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain('secret-name');
  });
});

describe('files.more and files.cancel', () => {
  it('take only an id', () => {
    expect(filesMoreSchema.safeParse({ id: 'r-1' }).success).toBe(true);
    expect(filesCancelSchema.safeParse({ id: 'r-1', path: 'x' }).success).toBe(false);
  });
});

describe('files.reply', () => {
  it('carries a chunk as base64, with the total size when given', () => {
    const reply = bytesReply('r-1', 0, Buffer.from('hello'), true, 5);
    expect(reply).toEqual({
      type: 'files.reply',
      id: 'r-1',
      seq: 0,
      last: true,
      data: 'aGVsbG8=',
      size: 5,
    });
  });

  it('refuses a chunk over 128 KiB', () => {
    expect(() => bytesReply('r', 0, Buffer.alloc(FILES_CHUNK_BYTES + 1), true)).toThrow();
    expect(() => bytesReply('r', 0, Buffer.alloc(FILES_CHUNK_BYTES), true)).not.toThrow();
  });

  it('ends a request with only a fixed code on error', () => {
    expect(errorReply('r-1', 3, 'timeout')).toEqual({
      type: 'files.reply',
      id: 'r-1',
      seq: 3,
      last: true,
      error: 'timeout',
    });
  });
});

import { mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { macEquals, PUSH_KEY_BYTES, readPushKey, takenMac, ticketMac } from './push-key';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'push-key-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fdWith(bytes: Buffer): number {
  const path = join(dir, `k-${bytes.length}`);
  writeFileSync(path, bytes);
  return openSync(path, 'r');
}

it('reads exactly one whole key and closes what it read it from', () => {
  const key = Buffer.alloc(PUSH_KEY_BYTES, 9);
  expect(readPushKey(fdWith(key))).toEqual(key);
  // Short, long, or no pipe at all: no key.
  expect(readPushKey(fdWith(Buffer.alloc(PUSH_KEY_BYTES - 1, 9)))).toBeNull();
  expect(readPushKey(fdWith(Buffer.alloc(PUSH_KEY_BYTES + 1, 9)))).toBeNull();
  expect(readPushKey(987)).toBeNull();
});

it('binds a ticket and its confirmation to the key, and compares in constant time', () => {
  const key = Buffer.alloc(32, 1);
  const other = Buffer.alloc(32, 2);
  const ticket = 'a'.repeat(32);
  expect(macEquals(ticketMac(key, ticket), ticketMac(key, ticket))).toBe(true);
  expect(macEquals(ticketMac(key, ticket), ticketMac(other, ticket))).toBe(false);
  expect(macEquals(ticketMac(key, ticket), takenMac(key, ticket))).toBe(false);
  expect(macEquals(ticketMac(key, ticket), 'zz')).toBe(false);
});

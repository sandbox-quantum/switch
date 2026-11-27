import { createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, readSync } from 'node:fs';

/**
 * On a split box, the launcher's per-launch push key. The launcher
 * writes a fresh random key into a pipe it hands the host at spawn (fd 3); the
 * host reads it before anything else and closes the pipe, and its supervisor
 * passes it on to its worker the same way. Every hub ticket the launcher then
 * pushes over the control port carries an HMAC under that key, and the host
 * ignores one that doesn't verify: a tool that can reach the control port, but
 * never saw the pipe, can't plant a ticket. The host answers a good push with
 * a second HMAC, which is how the launcher knows the host it spawned got its key.
 */

export const PUSH_KEY_BYTES = 32;
/** The inherited pipe the key arrives on. */
export const PUSH_KEY_FD = 3;

/** Reads the key from `fd` and closes it; null unless exactly a whole key arrived. */
export function readPushKey(fd: number = PUSH_KEY_FD): Buffer | null {
  const key = Buffer.alloc(PUSH_KEY_BYTES);
  let got = 0;
  try {
    while (got < PUSH_KEY_BYTES) {
      const read = readSync(fd, key, got, PUSH_KEY_BYTES - got, null);
      if (read === 0) break;
      got += read;
    }
    // Anything more than a key is not a key.
    if (got === PUSH_KEY_BYTES && readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) return null;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  }
  return got === PUSH_KEY_BYTES ? key : null;
}

/** What the launcher sends with a ticket. */
export function ticketMac(key: Buffer, ticket: string): string {
  return createHmac('sha256', key).update(`switch-hub-ticket:${ticket}`).digest('hex');
}

/** What the host answers a verified ticket with: its confirmation that it holds this launch's key. */
export function takenMac(key: Buffer, ticket: string): string {
  return createHmac('sha256', key).update(`switch-hub-ticket-taken:${ticket}`).digest('hex');
}

/** Constant-time comparison of two hex HMACs. */
export function macEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}

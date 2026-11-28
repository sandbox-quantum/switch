import { type BigIntStats, constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { z } from 'zod';

/**
 * Opens without following a link at the last component, where the OS can (see
 * `readUntrusted` for Windows, which cannot), and without waiting on a FIFO for
 * a writer. The flags Windows lacks are 0 there.
 */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * The text of a file someone else can write (an agent, the agent host it
 * runs): never through a link at its name, only a regular file, at most
 * `maxBytes`. With `within`, the file as opened must also be inside that
 * directory once every link above it is resolved, so a directory on the way
 * swapped for a link cannot hand over a file elsewhere.
 *
 * A file that is not there is null. Every other refusal names the path and
 * why, and never carries any of the file’s content.
 */
export async function readUntrusted(
  path: string,
  options: { maxBytes: number; within?: string }
): Promise<string | null> {
  let file;
  try {
    file = await open(path, READ_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new Error(`${path} is a link, which is not followed.`);
    throw error;
  }
  try {
    const info = await file.stat({ bigint: true });
    // Windows has no O_NOFOLLOW, so the open above follows a link there: the
    // name is checked again, not followed, and must still be the file opened.
    let named;
    try {
      named = await lstat(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(`${path} changed while being opened.`);
      throw error;
    }
    if (named.isSymbolicLink()) throw new Error(`${path} is a link, which is not followed.`);
    if (!sameFile(named, info)) throw new Error(`${path} changed while being opened.`);
    if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
    if (info.size > BigInt(options.maxBytes))
      throw new Error(`${path} is larger than the ${options.maxBytes} bytes allowed.`);
    if (options.within !== undefined) {
      const root = await realpath(options.within);
      const real = await realpath(path);
      const resolved = await stat(real, { bigint: true });
      if (!strictlyInside(root, real) || !sameFile(resolved, info))
        throw new Error(`${path} is not inside ${options.within}, or changed while being opened.`);
    }
    const buffer = Buffer.alloc(options.maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > options.maxBytes)
      throw new Error(`${path} is larger than the ${options.maxBytes} bytes allowed.`);
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await file.close();
  }
}

/**
 * `text` as JSON matching `schema`, or an error saying which file it was and
 * where it went wrong. JSON.parse's own error quotes the text, and a schema's
 * may quote values, so neither is passed on.
 */
export function parseUntrustedJson<T extends z.ZodType>(
  text: string,
  schema: T,
  what: string
): z.infer<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${what} is not JSON.`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const where = parsed.error.issues.map((issue) => issue.path.join('.') || '(top)').join(', ');
    throw new Error(`${what} is not in the expected shape (at ${where}).`);
  }
  return parsed.data;
}

/**
 * Whether two stats name one file: device and inode, read as bigints so a
 * Windows file index (64 bits) is compared whole. A file system that reports
 * no inode (0, as FAT on Windows does) leaves only the device to compare, and
 * the caller's link check stands alone.
 */
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  if (a.dev !== b.dev) return false;
  if (a.ino === 0n && b.ino === 0n) return true;
  return a.ino === b.ino;
}

function strictlyInside(root: string, target: string): boolean {
  const rest = relative(root, target);
  return rest !== '' && rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

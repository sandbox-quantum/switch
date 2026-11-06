import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';

/**
 * Writing a cloud file or folder zip to the person's disk: streamed as it
 * comes, never held whole, and marked as downloaded from the internet
 * (`com.apple.quarantine`) as a browser download is, so Gatekeeper warns
 * before an agent's script, app or `.command` file opens. A save that fails
 * part way, or can't be marked, leaves nothing behind.
 */

const run = promisify(execFile);

/**
 * The quarantine value a browser writes: flags, time (hex seconds), the agent
 * (the app), and an event id. `0083` marks it downloaded and not yet opened.
 */
export function quarantineValue(now: number, id: string): string {
  return `0083;${Math.floor(now / 1000).toString(16)};Switch Console;${id}`;
}

/** Sets `com.apple.quarantine` on a saved file (macOS only; elsewhere nothing to do). */
export async function markDownloaded(
  path: string,
  platform: NodeJS.Platform = process.platform,
  exec: (file: string, args: string[]) => Promise<unknown> = (file, args) => run(file, args)
): Promise<void> {
  if (platform !== 'darwin') return;
  await exec('/usr/bin/xattr', [
    '-w',
    'com.apple.quarantine',
    quarantineValue(Date.now(), randomUUID().toUpperCase()),
    path,
  ]);
}

export type SaveDeps = {
  /** Asks where to save; null when the person cancels. */
  chooseTarget: (suggestedName: string) => Promise<string | null>;
  mark?: (path: string) => Promise<void>;
};

/**
 * Asks where to save, then writes `source` there and marks it downloaded.
 * The dialog comes first, so cancelling fetches nothing. Returns the saved
 * path, or null if the person cancelled. It writes beside the target and
 * renames only once the file is whole and marked, so a failure leaves any
 * file already at the target as it was, and no partial file behind.
 */
export async function saveToDisk(
  suggestedName: string,
  open: () => Promise<AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>>,
  deps: SaveDeps
): Promise<string | null> {
  const target = await deps.chooseTarget(suggestedName);
  if (!target) return null;
  const partial = `${target}.download-${randomUUID().slice(0, 8)}`;
  try {
    const source = await open();
    const readable =
      source instanceof ReadableStream
        ? Readable.fromWeb(source as NodeReadableStream<Uint8Array>)
        : Readable.from(source);
    await pipeline(readable, createWriteStream(partial, { mode: 0o644, flags: 'wx' }));
    await (deps.mark ?? markDownloaded)(partial);
    await rename(partial, target);
    return target;
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    throw error;
  }
}

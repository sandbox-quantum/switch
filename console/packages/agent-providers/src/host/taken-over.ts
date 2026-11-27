import { randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { fileMode } from './host-permissions';
import { replaceFile } from './replace-file';
import { parseUntrustedJson, readUntrusted } from './untrusted-file';

/**
 * The record a watcher leaves behind when something else took its connection.
 *
 * At most one controller connection per agent exists globally; exactly one
 * while an active owner exists; zero after a takeover whose winner then
 * disappears, until an explicit restart. This file is that last state made
 * durable. Reopening after a takeover is itself a takeover, so a watcher that
 * came back on its own would not restore the invariant — it would break it
 * again, from the other side. It stands down instead, and stays down across a
 * restart of the supervisor, the app, or the machine.
 *
 * Cleared only by someone asking for this watcher on purpose: the explicit
 * restart action, or turning the watcher off and on again.
 */
const takenOverSchema = z.strictObject({
  at: z.string().min(1),
  reason: z.string().min(1),
  connectionId: z.string().min(1),
});

export type TakenOver = z.infer<typeof takenOverSchema>;

const FILE = 'taken-over.json';
const MAX_BYTES = 64 * 1024;

export async function recordTakenOver(root: string, info: TakenOver): Promise<void> {
  const path = join(root, FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', fileMode(0o600));
  try {
    await file.writeFile(JSON.stringify(takenOverSchema.parse(info)));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await replaceFile(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/** Written by the agent host, so on a machine running agents as users of their own, the agent's. */
export async function readTakenOver(root: string): Promise<TakenOver | null> {
  const path = join(root, FILE);
  const text = await readUntrusted(path, { maxBytes: MAX_BYTES });
  return text === null ? null : parseUntrustedJson(text, takenOverSchema, path);
}

export async function clearTakenOver(root: string): Promise<void> {
  await unlink(join(root, FILE)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

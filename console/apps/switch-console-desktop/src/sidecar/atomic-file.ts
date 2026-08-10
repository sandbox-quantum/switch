import { rename, writeFile } from 'node:fs/promises';

/**
 * Write a file so concurrent readers only ever observe the old bytes or the new
 * ones, never a torn mix. `rename(2)` is atomic within a filesystem, and the
 * temp file is created alongside the target to stay on the same one.
 *
 * The sidecar's endpoint and state files are read by other processes (hooks
 * firing at arbitrary times, other clients polling) while it rewrites them, so
 * a plain truncate-and-write would hand out empty or half-written content.
 */
export async function atomicWriteFile(absPath: string, content: string): Promise<void> {
  const tmp = `${absPath}.${process.pid}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, absPath);
}

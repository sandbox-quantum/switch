import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The hosted worker's capability, written by the bootstrap on every boot and
 * read by the watcher when it attaches. It never enters an environment or a log.
 */
export const WORKER_CAPABILITY_FILE = 'worker-capability';

export async function writeWorkerCapability(root: string, capability: string): Promise<void> {
  if (!/^[\x21-\x7e]{16,4096}$/.test(capability))
    throw new Error('The worker capability is malformed.');
  const target = join(root, WORKER_CAPABILITY_FILE);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(capability);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  await rename(temporary, target);
}

export async function readWorkerCapability(root: string): Promise<string> {
  const capability = (await readFile(join(root, WORKER_CAPABILITY_FILE), 'utf8')).trim();
  if (!capability) throw new Error('The worker capability file is empty.');
  return capability;
}

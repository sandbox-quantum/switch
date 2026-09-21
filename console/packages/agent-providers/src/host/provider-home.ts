import { lstat, readdir, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';

export async function optionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Reference host-owned configuration assets while keeping session state in its own home. */
export async function linkHomeAsset(source: string, destination: string): Promise<void> {
  try {
    await lstat(destination);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await symlink(source, destination, (await lstat(source)).isDirectory() ? 'junction' : 'file');
}

export async function linkSkills(source: string, destination: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry === 'switch') continue;
    await linkHomeAsset(join(source, entry), join(destination, entry));
  }
}

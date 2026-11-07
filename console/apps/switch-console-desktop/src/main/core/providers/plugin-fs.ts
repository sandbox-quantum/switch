import { promises as fs } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { replaceFile } from '@switch-console/agent-providers';
import type {
  PluginFs,
  PluginFsListOptions,
  PluginFsProtectOptions,
  PluginFsWriteOptions,
} from '@switch-console/core/agents/plugins';
import { isSecretTempOf, secretTempPath } from '@main/core/fs/secret-temp';
import {
  restrictWindowsDirectoryToOwner,
  restrictWindowsFileToOwner,
} from '@main/core/fs/windows-owner-acl';
import { log } from '@main/lib/logger';

const isAbsent = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/**
 * `chmod(dir, 0o700)`, or what stands in for it on Windows, where a mode does
 * nothing for a directory. A directory another account owns cannot be changed
 * by this one; it is left as it is with a warning rather than failing the
 * operation, since the secret file in it is private either way.
 */
async function restrictSecretDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return restrictWindowsDirectoryToOwner(dir);
  try {
    await fs.chmod(dir, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    log.warn('plugin-fs: secret directory belongs to another account; left as it is', {
      dir,
    });
  }
}

/**
 * Write `content` to `abs` readable by its owner alone, in a directory only its
 * owner can enter: the `secret` write of {@link PluginFs}, for a file holding a
 * credential. The content goes into a temporary file created `0600` and is
 * renamed over `abs`, so it never sits in a file anyone else can read, and an
 * existing file with wider permissions is replaced rather than kept.
 */
export async function writeSecretFile(abs: string, content: string): Promise<void> {
  const dir = dirname(abs);
  await fs.mkdir(dir, { recursive: true });
  // mkdir's mode reaches only a directory it creates, not one that was already there.
  await restrictSecretDirectory(dir);
  const temporary = secretTempPath(abs);
  const file = await fs.open(temporary, 'wx', 0o600);
  try {
    try {
      if (process.platform === 'win32') await restrictWindowsFileToOwner(temporary);
      await file.writeFile(content, 'utf-8');
      await file.sync();
    } finally {
      await file.close();
    }
    await replaceFile(temporary, abs);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Give an existing file at `abs` the permissions {@link writeSecretFile} would,
 * without touching its content. Resolves false, changing nothing, when there is
 * no file.
 */
export async function protectSecretFile(
  abs: string,
  options?: PluginFsProtectOptions
): Promise<boolean> {
  try {
    await fs.chmod(abs, 0o600);
  } catch (error) {
    if (isAbsent(error)) return false;
    throw error;
  }
  if (!options?.fileOnly) await restrictSecretDirectory(dirname(abs));
  if (process.platform === 'win32') await restrictWindowsFileToOwner(abs);
  return true;
}

/** Remove the temporary copies an interrupted {@link writeSecretFile} of `abs` left beside it. */
async function removeSecretTemps(abs: string): Promise<void> {
  const dir = dirname(abs);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (isAbsent(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (isSecretTempOf(entry, basename(abs))) await fs.rm(join(dir, entry), { force: true });
  }
}

/**
 * Create a CLIAgentPluginFs scoped to a given root directory.
 * All paths are resolved relative to root; path-escape attempts throw.
 */
export function createPluginFs(root: string): PluginFs {
  const absRoot = resolve(root);

  function resolveSafe(path: string): string {
    const abs = resolve(join(absRoot, path));
    const rootWithSep = absRoot.endsWith(sep) ? absRoot : absRoot + sep;
    const absWithSep = abs.endsWith(sep) ? abs : abs + sep;
    if (!absWithSep.startsWith(rootWithSep) && abs !== absRoot) {
      throw new Error(`Plugin fs: path escape attempt: ${path}`);
    }
    return abs;
  }

  return {
    async read(path: string): Promise<string | null> {
      try {
        return await fs.readFile(resolveSafe(path), 'utf-8');
      } catch (error) {
        // Only a missing file maps to null (ENOTDIR: a parent path segment is
        // not a directory, so the file equally does not exist). Other failures
        // must propagate: config writers read-modify-write these files, and
        // treating a failed read as "empty" makes them rewrite the file from
        // scratch, discarding its real content.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return null;
        }
        throw error;
      }
    },

    async write(path: string, content: string, options?: PluginFsWriteOptions): Promise<void> {
      const abs = resolveSafe(path);
      if (options?.secret) return writeSecretFile(abs, content);
      await fs.mkdir(dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf-8');
    },

    async protectSecret(path: string, options?: PluginFsProtectOptions): Promise<boolean> {
      return protectSecretFile(resolveSafe(path), options);
    },

    async delete(path: string): Promise<void> {
      const abs = resolveSafe(path);
      try {
        await fs.unlink(abs);
      } catch (error) {
        // Only "already absent" is success, on the same reasoning as read().
        // A permission error or an I/O failure must propagate: delete is how an
        // agent's Switch token is revoked from disk, and a silent no-op there
        // reports a credential as destroyed while it is still readable.
        if (!isAbsent(error)) throw error;
      }
      // Whether or not the file was there: a first write cut off before its
      // rename leaves only the copy.
      await removeSecretTemps(abs);
    },

    async exists(path: string): Promise<boolean> {
      try {
        await fs.access(resolveSafe(path));
        return true;
      } catch {
        return false;
      }
    },

    async list(path: string, options?: PluginFsListOptions): Promise<string[]> {
      try {
        return await fs.readdir(resolveSafe(path));
      } catch (error) {
        if (options?.strict && !isAbsent(error)) throw error;
        return [];
      }
    },
  };
}

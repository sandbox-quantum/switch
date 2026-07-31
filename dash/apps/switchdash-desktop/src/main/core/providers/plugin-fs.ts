import { promises as fs } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { PluginFs } from '@switchdash/core/agents/plugins';

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

    async write(path: string, content: string): Promise<void> {
      const abs = resolveSafe(path);
      await fs.mkdir(dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf-8');
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
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          throw error;
        }
      }
    },

    async exists(path: string): Promise<boolean> {
      try {
        await fs.access(resolveSafe(path));
        return true;
      } catch {
        return false;
      }
    },

    async list(path: string): Promise<string[]> {
      try {
        return await fs.readdir(resolveSafe(path));
      } catch {
        return [];
      }
    },
  };
}

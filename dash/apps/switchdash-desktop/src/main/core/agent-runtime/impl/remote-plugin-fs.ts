import { dirname } from 'node:path/posix';
import type { PluginFs } from '@switchdash/core/agents/plugins';
import { assertRemoved } from '@main/core/fs/assert-removed';
import {
  FileSystemError,
  FileSystemErrorCodes,
  type FileSystemProvider,
} from '@main/core/fs/types';

/**
 * Adapt a remote SSH `FileSystemProvider` to the `PluginFs` shape that plugin
 * hook/config writers expect, so the same `writeHooks` logic that runs against
 * a local location can install an agent's hooks on its VM over SFTP.
 *
 * The provider is rooted at the agent's remote repo dir, so paths are relative
 * to it (e.g. `.claude/settings.local.json`). Remote hosts are POSIX, so parent
 * directories are derived with the posix path helper. Unlike the local writer,
 * the remote provider's `write` does not create parent dirs, so we `mkdir` first.
 */
export function createRemotePluginFs(fs: FileSystemProvider): PluginFs {
  return {
    async read(path: string): Promise<string | null> {
      try {
        const result = await fs.read(path);
        return result.content;
      } catch (error) {
        // Only a genuinely missing file maps to null. A transport failure
        // (dropped SSH connection, exhausted channel) must propagate: hook
        // writers read-modify-write this file, and treating a failed read as
        // "empty" makes them rewrite it from scratch — wiping the SWITCH_*
        // credentials env block.
        if (error instanceof FileSystemError && error.code === FileSystemErrorCodes.NOT_FOUND) {
          return null;
        }
        throw error;
      }
    },

    async write(path: string, content: string): Promise<void> {
      const dir = dirname(path);
      if (dir && dir !== '.') {
        await fs.mkdir(dir, { recursive: true });
      }
      const result = await fs.write(path, content);
      if (!result.success) {
        throw new Error(`remote plugin fs: failed to write ${path}: ${result.error ?? 'unknown'}`);
      }
    },

    async delete(path: string): Promise<void> {
      assertRemoved(path, await fs.remove(path));
    },

    async exists(path: string): Promise<boolean> {
      return fs.exists(path);
    },

    async list(path: string): Promise<string[]> {
      const result = await fs.list(path);
      return result.entries.map((entry) => {
        const segments = entry.path.split('/');
        return segments[segments.length - 1] ?? entry.path;
      });
    },
  };
}

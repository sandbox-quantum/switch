import { posix as pathPosix } from 'node:path';
import type { PluginFs } from '@switchdash/core/agents/plugins';
import { assertRemoved } from '@main/core/fs/assert-removed';
import type { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { FileSystemError, FileSystemErrorCodes } from '@main/core/fs/types';

/** Generous read cap for the small JSON/markdown files subagent IO touches. */
const MAX_READ_BYTES = 5 * 1024 * 1024;

/**
 * Adapt a remote {@link SshFileSystem} (SFTP over SSH) to the 5-method
 * {@link PluginFs} the subagent behaviors consume, so a parent agent's subagent
 * definitions and credentials can be authored on its remote host exactly as they
 * are locally. Paths are relative to the SshFileSystem's root (the agent's remote
 * repo dir).
 *
 * The one semantic gap bridged here: `SshFileSystem.list` returns paths relative
 * to the FS root, whereas `PluginFs.list` (like `fs.readdir`) yields bare entry
 * names — so entries are mapped back to their basenames.
 */
export function createRemotePluginFs(fs: SshFileSystem): PluginFs {
  return {
    async read(path: string): Promise<string | null> {
      try {
        const result = await fs.read(path, MAX_READ_BYTES);
        return result.content;
      } catch (error) {
        // Only a genuinely missing file maps to null. A transport failure
        // (dropped SSH connection, exhausted channel) must propagate: config
        // writers read-modify-write these files, and treating a failed read
        // as "empty" makes them rewrite the file from scratch, discarding
        // its real content.
        if (error instanceof FileSystemError && error.code === FileSystemErrorCodes.NOT_FOUND) {
          return null;
        }
        throw error;
      }
    },

    async write(path: string, content: string): Promise<void> {
      const result = await fs.write(path, content);
      if (!result.success) {
        throw new Error(
          `remote plugin fs: failed to write ${path}: ${result.error ?? 'unknown error'}`
        );
      }
    },

    async delete(path: string): Promise<void> {
      assertRemoved(path, await fs.remove(path));
    },

    async exists(path: string): Promise<boolean> {
      return fs.exists(path);
    },

    async list(path: string): Promise<string[]> {
      try {
        const result = await fs.list(path, { includeHidden: true });
        return result.entries.map((entry) => pathPosix.basename(entry.path));
      } catch {
        return [];
      }
    },
  };
}

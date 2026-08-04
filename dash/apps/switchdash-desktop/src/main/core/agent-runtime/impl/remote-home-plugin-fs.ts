import type { PluginFs } from '@switchdash/core/agents/plugins';
import type { IExecutionContext } from '@main/core/execution-context/types';

/**
 * Adapt a remote host to the `PluginFs` shape, rooted at the VM's `$HOME`.
 *
 * The SSH `FileSystemProvider` is rooted at the agent's repo dir, so a provider
 * whose config lives in the home directory — Codex writes its hooks to
 * `~/.codex/hooks.json` and its Switch profile beside them — cannot be reached
 * through it at all. Everything here therefore runs as a shell command: the far
 * side expands `$HOME`, and paths and file contents travel as positional
 * arguments (contents base64-encoded) so neither can break out of the command.
 */
export function createRemoteHomePluginFs(ctx: IExecutionContext): PluginFs {
  const checked = (path: string): string => {
    const segments = path.split('/');
    if (path.startsWith('/') || segments.includes('..') || segments.includes('')) {
      throw new Error(`remote home fs: refusing a path outside the home directory: ${path}`);
    }
    return path;
  };

  return {
    /**
     * The first byte of stdout says whether the file was there: `1` followed by
     * its base64 content, or `0`. Distinguishing "absent" from "unreadable" is
     * load-bearing — hook writers read-modify-write these files, and a transport
     * failure reported as "missing" makes them rewrite from scratch.
     */
    async read(path: string): Promise<string | null> {
      const { stdout } = await ctx.exec('sh', [
        '-c',
        'f="$HOME/$1"; if [ -f "$f" ]; then printf 1; base64 < "$f"; else printf 0; fi',
        'sh',
        checked(path),
      ]);
      if (stdout.startsWith('0')) return null;
      if (!stdout.startsWith('1')) {
        throw new Error(`remote home fs: unreadable response while reading ${path}`);
      }
      return Buffer.from(stdout.slice(1), 'base64').toString('utf8');
    },

    async write(path: string, content: string): Promise<void> {
      await ctx.exec('sh', [
        '-c',
        'set -e; mkdir -p "$HOME/$(dirname "$1")"; printf %s "$2" | base64 -d > "$HOME/$1"',
        'sh',
        checked(path),
        Buffer.from(content, 'utf8').toString('base64'),
      ]);
    },

    async delete(path: string): Promise<void> {
      await ctx.exec('sh', ['-c', 'rm -f "$HOME/$1"', 'sh', checked(path)]);
    },

    async exists(path: string): Promise<boolean> {
      const { stdout } = await ctx.exec('sh', [
        '-c',
        'if [ -e "$HOME/$1" ]; then printf 1; else printf 0; fi',
        'sh',
        checked(path),
      ]);
      return stdout.trim() === '1';
    },

    async list(path: string): Promise<string[]> {
      const { stdout } = await ctx.exec('sh', [
        '-c',
        'if [ -d "$HOME/$1" ]; then ls -1A "$HOME/$1"; fi',
        'sh',
        checked(path),
      ]);
      return stdout
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    },
  };
}

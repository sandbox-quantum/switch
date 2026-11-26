import { chmod, lstat, mkdir } from 'node:fs/promises';
import { dirMode } from './host-permissions';

/**
 * A directory a login file goes in: made when missing, never a link, and, when
 * it is this user's, given the mode `dirMode` asks for. Under the shared group
 * that lets the agent controller remove the login when it is withdrawn or the
 * agent is removed, after this agent host has stopped (`clearHostedProvider`).
 */
export async function ensureLoginDirectory(directory: string): Promise<void> {
  const mode = dirMode(0o700);
  await mkdir(directory, { recursive: true, mode });
  const info = await lstat(directory);
  if (info.isSymbolicLink())
    throw new Error('Provider authentication directory must not be a symbolic link.');
  if (info.uid === process.getuid?.() && (info.mode & 0o777) !== mode) await chmod(directory, mode);
}

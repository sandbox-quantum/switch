import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { log } from '@main/lib/logger';

const execFileAsync = promisify(execFile);

function resolveGhBin(): string {
  const candidates = [
    (process.env.GH_PATH || '').trim(),
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    '/usr/bin/gh',
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return 'gh';
}

/** Resolved path to the GitHub CLI binary. */
export const GH_EXECUTABLE = resolveGhBin();

/**
 * Read the user's existing GitHub token from the `gh` CLI (`gh auth token`).
 *
 * Reuses the login the user already performed with `gh auth login` so the
 * updater can reach the private switch release feed without us shipping a
 * baked secret or running our own OAuth app. Returns null when `gh` is missing,
 * not authenticated, or returns nothing — callers treat that as "auth not
 * available yet" rather than an error.
 */
export async function getGithubTokenFromGhCli(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(GH_EXECUTABLE, ['auth', 'token'], {
      timeout: 10_000,
    });
    const token = stdout.trim();
    return token.length > 0 ? token : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      log.info('gh CLI not found; GitHub-authenticated updates are unavailable');
    } else {
      log.info('gh auth token unavailable; GitHub-authenticated updates are unavailable');
    }
    return null;
  }
}

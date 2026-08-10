import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '@main/lib/logger';

/**
 * Parse SSH config text and return the concrete `Host` aliases the user can
 * connect through. Pattern entries (containing `*`, `?`, or a leading `!`) are
 * skipped — they are matchers, not connectable hosts.
 */
export function parseSshConfigHosts(content: string): string[] {
  const aliases = new Set<string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^host\s+(.+)$/i.exec(line);
    if (!match) continue;
    for (const token of match[1]!.split(/\s+/)) {
      if (!token || token.includes('*') || token.includes('?') || token.startsWith('!')) continue;
      aliases.add(token);
    }
  }
  return [...aliases].sort((a, b) => a.localeCompare(b));
}

/**
 * Read the user's `~/.ssh/config` and return connectable `Host` aliases. Used to
 * populate the host-onboarding picker; auth still resolves from the SSH
 * config/agent (Switch Console stores no credentials).
 */
export async function listSshConfigHosts(): Promise<string[]> {
  const configPath = path.join(os.homedir(), '.ssh', 'config');

  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return [];
    log.warn('[RemoteHosts] Failed to read ~/.ssh/config', {
      error: String((error as Error)?.message ?? error),
    });
    return [];
  }

  return parseSshConfigHosts(content);
}

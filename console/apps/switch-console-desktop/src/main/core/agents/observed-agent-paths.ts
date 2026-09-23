import type { RemoteAgentSummary } from '@shared/core/switch-servers/switch-servers';

/**
 * The pure half of following agents another account runs on a shared host
 * (CHOO-2893): reading where the server says an agent runs, and whose home
 * that is. No host access and no Electron, so discovery and its tests can use
 * it without either.
 */

/** How this account can reach a directory on the host. */
export type DirAccess =
  /** Readable: its agents can be loaded and run from here, the ordinary way. */
  | 'readable'
  /** There, or under a home this account cannot enter: another account's. */
  | 'denied'
  /** Not on this host at all — the agent runs somewhere else. */
  | 'missing';

export type HostHome = { account: string; home: string };

/** Parse `passwd` lines into the accounts that have a home worth matching. */
export function parseHomes(passwd: string): HostHome[] {
  const homes: HostHome[] = [];
  for (const line of passwd.split('\n')) {
    const fields = line.trim().split(':');
    if (fields.length < 7) continue;
    const account = fields[0]!;
    const home = fields[5]!.replace(/\/+$/, '');
    if (!account || !home.startsWith('/') || home === '/nonexistent') continue;
    homes.push({ account, home });
  }
  return homes;
}

/** The account whose home holds `dir`, by the longest matching home, or null. */
export function accountOwning(dir: string, homes: HostHome[]): string | null {
  let best: HostHome | null = null;
  for (const entry of homes) {
    if (dir !== entry.home && !dir.startsWith(`${entry.home}/`)) continue;
    if (!best || entry.home.length > best.home.length) best = entry;
  }
  return best?.account ?? null;
}

/** Where the server says an agent runs, or null when it does not say. */
export function repoDirOf(agent: Pick<RemoteAgentSummary, 'knownAgentOptions'>): string | null {
  const repoDir = agent.knownAgentOptions?.repo_dir;
  return typeof repoDir === 'string' && repoDir.length > 0 ? repoDir : null;
}

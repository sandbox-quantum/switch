/**
 * The local agent store: who this machine can be, and the secrets to prove it.
 *
 * A session switchdash launched gets its identity from the environment and never
 * reaches any of this. Everything else — a connector plugin installed by hand, a
 * Codex session started from a shell — has only what is on disk.
 *
 * The store is split across two roots deliberately. The working tree holds what
 * is safe to see: which agents are provisioned here, their ids, and the server
 * they belong to. The token lives under `$HOME` at `0600`, because a live
 * credential inside a working tree is one `git add -f`, one `tar`, or one
 * editor backup away from leaving the machine, and a `.gitignore` stops none of
 * those.
 *
 * Home-side files are keyed by **agent id**, not by name. Names collide — the
 * same `reviewer` can exist on two Switch deployments — and `$HOME` is shared by
 * every project on the machine, so a name-keyed secret would have the two
 * fighting over one file. An id is unique by construction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Where each half of the store lives, relative to its own root. */
export const AGENTS_DIR_RELATIVE = path.join('.switch', 'agents');

/** An agent this machine is provisioned for, with its secret resolved. */
export type ResolvedAgent = {
  /** The store's own handle for the agent — the project file's name. */
  slug: string;
  /** The agent's name on the Switch server. */
  name: string;
  agentId: string;
  endpoint: string;
  token: string;
  /** True when the token came from the working tree rather than `$HOME`. */
  tokenInWorkingTree: boolean;
};

/**
 * A project entry that named an agent but could not be used, and why.
 *
 * Kept rather than dropped: "you have no agents" and "you have one whose secret
 * is missing" call for completely different fixes, and a store that silently
 * skips the broken entry tells you the first when it means the second.
 */
export type UnusableAgent = { slug: string; reason: string };

export type AgentStore = {
  agents: ResolvedAgent[];
  unusable: UnusableAgent[];
  /** The directory scanned for project entries, for error messages. */
  projectDir: string;
};

function readJson(file: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

/**
 * Whether a secret file is readable by anyone but its owner.
 *
 * Reported, not enforced: refusing to start over a group-readable file would
 * strand a working setup on a permissions detail the user may not control (a
 * synced home directory, a restrictive umask applied after the fact). The
 * warning names the file and the fix.
 */
function isOverlyPermissive(file: string): boolean {
  try {
    return (fs.statSync(file).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

type ProjectEntry = { slug: string; name: string; agentId: string; endpoint: string };

/**
 * Read one project entry.
 *
 * Two shapes are accepted. The current one carries no secret. The legacy one is
 * the `{ env: { SWITCH_* } }` block switchdash wrote before the split, token and
 * all — still read so an un-migrated tree keeps working, but flagged by the
 * caller rather than passed off as equivalent.
 */
function parseProjectEntry(
  file: string,
  slug: string
): { entry: ProjectEntry; inlineToken: string } | { error: string } {
  const data = readJson(file);
  if (data === null) return { error: `unreadable or malformed JSON: ${file}` };

  const env = (data.env ?? {}) as Record<string, unknown>;
  const name = str(data.name) || slug;
  const agentId = str(data.agent_id) || str(env.SWITCH_AGENT_ID);
  const endpoint = str(data.endpoint) || str(env.SWITCH_API_ENDPOINT);
  const inlineToken = str(env.SWITCH_API_TOKEN);

  if (!agentId) return { error: `no agent id in ${file}` };
  if (!endpoint) return { error: `no endpoint in ${file}` };

  return { entry: { slug, name, agentId, endpoint }, inlineToken };
}

/** Read the token for one agent from the home-side store, or `''` if absent. */
function readHomeSecret(homeDir: string, agentId: string): { token: string; permissive: boolean } {
  const file = path.join(homeDir, AGENTS_DIR_RELATIVE, `${agentId}.json`);
  const data = readJson(file);
  if (data === null) return { token: '', permissive: false };
  return { token: str(data.token), permissive: isOverlyPermissive(file) };
}

/**
 * Enumerate the agents this machine is provisioned for.
 *
 * `projectDir` is the working directory the host was started in; `homeDir` is
 * `$HOME`. Neither existing is an ordinary answer — an empty store, not an
 * error — because "no agents provisioned here" is what an unconfigured machine
 * legitimately looks like.
 */
export function readAgentStore(
  projectDir: string,
  homeDir: string,
  warn: (message: string) => void
): AgentStore {
  const dir = path.join(projectDir, AGENTS_DIR_RELATIVE);
  const agents: ResolvedAgent[] = [];
  const unusable: UnusableAgent[] = [];

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return { agents, unusable, projectDir: dir };
  }

  for (const file of files.sort()) {
    const slug = file.slice(0, -'.json'.length);
    const parsed = parseProjectEntry(path.join(dir, file), slug);
    if ('error' in parsed) {
      unusable.push({ slug, reason: parsed.error });
      continue;
    }

    const { entry, inlineToken } = parsed;
    const home = readHomeSecret(homeDir, entry.agentId);

    if (home.token) {
      if (home.permissive) {
        warn(
          `secret for ${entry.name} is readable by other users — ` +
            `chmod 600 ${path.join(homeDir, AGENTS_DIR_RELATIVE, `${entry.agentId}.json`)}`
        );
      }
      agents.push({ ...entry, token: home.token, tokenInWorkingTree: false });
      continue;
    }

    if (inlineToken) {
      warn(
        `${entry.name}: token is still inside the working tree at ` +
          `${path.join(dir, file)} — move it to ${path.join(homeDir, AGENTS_DIR_RELATIVE)} at 0600`
      );
      agents.push({ ...entry, token: inlineToken, tokenInWorkingTree: true });
      continue;
    }

    unusable.push({
      slug,
      reason:
        `no secret for agent ${entry.agentId} — expected ` +
        `${path.join(homeDir, AGENTS_DIR_RELATIVE, `${entry.agentId}.json`)}`,
    });
  }

  return { agents, unusable, projectDir: dir };
}

/** The distinct Switch endpoints a set of agents belongs to. */
export function distinctEndpoints(agents: ResolvedAgent[]): string[] {
  return [...new Set(agents.map((a) => a.endpoint.replace(/\/+$/, '')))].sort();
}

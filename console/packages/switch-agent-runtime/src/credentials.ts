/**
 * The local agent store: who this machine can be, and the credentials to prove
 * it.
 *
 * A session Switch Console launched gets all three `SWITCH_*` vars injected and
 * never reaches any of this. Everything else — a connector plugin installed by
 * hand, a Codex session started from a shell — needs the disk, either for the
 * whole identity or to complete an environment that names an agent without
 * carrying its token.
 *
 * One file per agent, in the working directory switchdash already writes to, in
 * the shape it already writes. Keeping the token out of the working tree is a
 * real improvement and a separate change: two credential locations is a thing
 * every reader, writer, migration and teardown path then has to hold in its
 * head, and that cost belongs to the change that buys it, not to this one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Where the store lives, relative to the working directory. */
export const AGENTS_DIR_RELATIVE = path.join('.switch', 'agents');

/** An agent this machine is provisioned for. */
export type ResolvedAgent = {
  /** The store's own handle for the agent — the file's name. */
  slug: string;
  /** The agent's name on the Switch server. */
  name: string;
  agentId: string;
  endpoint: string;
  token: string;
};

/**
 * A file that named an agent but could not be used, and why.
 *
 * Kept rather than dropped: "you have no agents" and "you have one that is
 * broken" call for completely different fixes, and a store that silently skips
 * the broken entry tells you the first when it means the second.
 */
export type UnusableAgent = { slug: string; reason: string };

export type AgentStore = {
  agents: ResolvedAgent[];
  unusable: UnusableAgent[];
  /** The directory scanned, for error messages. */
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
 * Read one entry.
 *
 * The `{ env: { SWITCH_* } }` shape is what switchdash writes and what Claude
 * Code reads natively from the same file, so it is the shape here. The flat
 * field names are accepted too, since they are the obvious thing to write by
 * hand and cost one line to support.
 */
function parseEntry(file: string, slug: string): ResolvedAgent | { error: string } {
  const data = readJson(file);
  if (data === null) return { error: `unreadable or malformed JSON: ${file}` };

  const env = (data.env ?? {}) as Record<string, unknown>;
  const name = str(data.name) || slug;
  const agentId = str(data.agent_id) || str(env.SWITCH_AGENT_ID);
  const endpoint = str(data.endpoint) || str(env.SWITCH_API_ENDPOINT);
  const token = str(data.token) || str(env.SWITCH_API_TOKEN);

  if (!agentId) return { error: `no agent id in ${file}` };
  if (!endpoint) return { error: `no endpoint in ${file}` };
  if (!token) return { error: `no API token in ${file}` };

  return { slug, name, agentId, endpoint, token };
}

/**
 * Enumerate the agents this working directory is provisioned for.
 *
 * The directory not existing is an ordinary answer — an empty store, not an
 * error — because that is what an unconfigured directory legitimately looks
 * like.
 */
export function readAgentStore(projectDir: string): AgentStore {
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
    const parsed = parseEntry(path.join(dir, file), slug);
    if ('error' in parsed) {
      unusable.push({ slug, reason: parsed.error });
      continue;
    }
    agents.push(parsed);
  }

  return { agents, unusable, projectDir: dir };
}

/**
 * Compare endpoints without tripping over a trailing slash or the casing of the
 * parts that are defined to be case-insensitive.
 *
 * Scheme and host fold; the path does not, because it is case-sensitive and
 * folding it would call two different resources the same. This decides whether
 * an identity binds, not just how endpoints are grouped for display, so a
 * cosmetic difference must not read as a different server.
 */
export function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  return trimmed.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]*)/, (_all, scheme, authority) =>
    `${scheme.toLowerCase()}${authority.toLowerCase()}`
  );
}

/** The distinct Switch endpoints a set of agents belongs to. */
export function distinctEndpoints(agents: ResolvedAgent[]): string[] {
  return [...new Set(agents.map((a) => normalizeEndpoint(a.endpoint)))].sort();
}

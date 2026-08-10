import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { appSettings } from '@main/db/schema';

/**
 * Local mirror of which agents have `auto_session` enabled. The agent's gateway
 * profile (`connection_model === 'auto_session'`) is the source of truth; this
 * mirror lets the watcher start at boot using only the agent token (no gateway
 * JWT), and is reconciled from the gateway when the UI loads the agent. Stored
 * as a JSON array of local agent ids under a single appSettings key.
 */
const KEY = 'auto_session_agents';

async function readSet(): Promise<Set<string>> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, KEY));
  if (!row) return new Set();
  try {
    const ids = JSON.parse(row.value) as string[];
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}

async function writeSet(ids: Set<string>): Promise<void> {
  const serialized = JSON.stringify([...ids]);
  await db
    .insert(appSettings)
    .values({ key: KEY, value: serialized })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: serialized } });
}

/** Local agent ids currently mirrored as auto_session-enabled. */
export async function listAutoSessionAgentIds(): Promise<string[]> {
  return [...(await readSet())];
}

/** Add or remove an agent from the local auto_session mirror. */
export async function setAutoSessionAgent(agentId: string, enabled: boolean): Promise<void> {
  const ids = await readSet();
  if (enabled) ids.add(agentId);
  else ids.delete(agentId);
  await writeSet(ids);
}

/**
 * Local mirror of which subagents have `auto_session` enabled. A subagent has no
 * Switch Console agent row of its own, so it is keyed by its parent's local agent id
 * plus its bare name. Stored as a JSON array of `{ parentAgentId, name }`.
 */
const SUBAGENT_KEY = 'auto_session_subagents';

export type AutoSessionSubagent = { parentAgentId: string; name: string };

async function readSubagents(): Promise<AutoSessionSubagent[]> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, SUBAGENT_KEY));
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value) as AutoSessionSubagent[];
    return Array.isArray(parsed)
      ? parsed.filter((s) => typeof s?.parentAgentId === 'string' && typeof s?.name === 'string')
      : [];
  } catch {
    return [];
  }
}

async function writeSubagents(list: AutoSessionSubagent[]): Promise<void> {
  const serialized = JSON.stringify(list);
  await db
    .insert(appSettings)
    .values({ key: SUBAGENT_KEY, value: serialized })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: serialized } });
}

/** Subagents currently mirrored as auto_session-enabled. */
export async function listAutoSessionSubagents(): Promise<AutoSessionSubagent[]> {
  return readSubagents();
}

/** Add or remove a subagent from the local auto_session mirror. */
export async function setAutoSessionSubagent(
  parentAgentId: string,
  name: string,
  enabled: boolean
): Promise<void> {
  const list = await readSubagents();
  const without = list.filter((s) => !(s.parentAgentId === parentAgentId && s.name === name));
  await writeSubagents(enabled ? [...without, { parentAgentId, name }] : without);
}

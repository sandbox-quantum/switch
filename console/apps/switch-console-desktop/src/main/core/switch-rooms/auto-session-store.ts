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

/**
 * Agents whose controller someone stopped by hand. Every agent linked to Switch
 * is given a controller at boot, so this is the only record that one of them
 * was deliberately taken off the air — without it, quitting Console would put
 * a stopped agent back on it.
 */
const STOPPED_KEY = 'stopped_controller_agents';

async function readSet(key: string): Promise<Set<string>> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key));
  if (!row) return new Set();
  try {
    const ids = JSON.parse(row.value) as string[];
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}

async function writeSet(key: string, ids: Set<string>): Promise<void> {
  const serialized = JSON.stringify([...ids]);
  await db
    .insert(appSettings)
    .values({ key, value: serialized })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: serialized } });
}

const inFlight = new Map<string, Promise<void>>();

/**
 * One mutation of a key at a time. A key holds a whole collection in a single
 * row, so changing one member is a read, an edit and a write with suspension
 * points between them: two that overlap both read before either writes, and the
 * later write drops the earlier's member. Overlapping is ordinary here —
 * removing an agent clears both agent keys, and tearing down a host removes its
 * agents together — and what is lost is durable, so an agent stopped by hand is
 * back on the air at the next boot.
 */
function serialize(key: string, mutate: () => Promise<void>): Promise<void> {
  const next = (inFlight.get(key) ?? Promise.resolve()).then(mutate);
  // A failed mutation must not poison the queue behind it, and the caller still
  // gets the rejection through `next`.
  inFlight.set(
    key,
    next.catch(() => {})
  );
  return next;
}

async function updateSet(key: string, agentId: string, member: boolean): Promise<void> {
  await serialize(key, async () => {
    const ids = await readSet(key);
    if (member) ids.add(agentId);
    else ids.delete(agentId);
    await writeSet(key, ids);
  });
}

/** Local agent ids currently mirrored as auto_session-enabled. */
export async function listAutoSessionAgentIds(): Promise<string[]> {
  return [...(await readSet(KEY))];
}

/** Add or remove an agent from the local auto_session mirror. */
export async function setAutoSessionAgent(agentId: string, enabled: boolean): Promise<void> {
  await updateSet(KEY, agentId, enabled);
}

/** Local agent ids whose controller is stopped until someone starts it again. */
export async function listStoppedControllerAgentIds(): Promise<string[]> {
  return [...(await readSet(STOPPED_KEY))];
}

/** Record that an agent's controller was stopped by hand, or started again. */
export async function setControllerStopped(agentId: string, stopped: boolean): Promise<void> {
  await updateSet(STOPPED_KEY, agentId, stopped);
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
  await serialize(SUBAGENT_KEY, async () => {
    const list = await readSubagents();
    const without = list.filter((s) => !(s.parentAgentId === parentAgentId && s.name === name));
    await writeSubagents(enabled ? [...without, { parentAgentId, name }] : without);
  });
}

import { and, eq, ne } from 'drizzle-orm';
import { db } from '@main/db/client';
import { agents } from '@main/db/schema';

/**
 * Whether another agent in the same location already answers to `name`.
 *
 * Everything switchdash provisions per agent is keyed by the name rather than the
 * id — `.switch/agents/<name>.json` carries the Switch token, `.claude/agents/<name>.md`
 * the definition — so two agents sharing a name in one directory share one
 * credentials file, and whoever writes last decides which identity both of them
 * present. The gateway's own uniqueness check cannot stand in for this one: it is
 * scoped to a Switch server, and a name can be free there while taken here.
 *
 * `exceptAgentId` is the agent being renamed, so it does not conflict with itself;
 * pass null when the agent does not exist yet.
 */
export async function agentNameTaken(
  locationId: string,
  name: string,
  exceptAgentId: string | null
): Promise<boolean> {
  const matchesName = and(eq(agents.locationId, locationId), eq(agents.name, name));
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(exceptAgentId === null ? matchesName : and(matchesName, ne(agents.id, exceptAgentId)))
    .limit(1);
  return row !== undefined;
}

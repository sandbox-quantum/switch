import { db } from '@main/db/client';
import { agents, locations, switchServers } from '@main/db/schema';

/**
 * Whether this install holds nothing of its own — the fresh-install question the
 * shell asks before it puts the first-run page over the whole window.
 *
 * Deliberately not "has no Switch server". Agents, locations and the sessions
 * running in them outlive a server on purpose: removing one says in as many
 * words that its agents are kept and can be re-linked elsewhere. Reading an
 * empty server list as a fresh install would answer that promise by replacing
 * the window with a welcome page — permanently, across relaunches, with those
 * sessions still running behind it.
 *
 * Answered here rather than assembled in the renderer because the counts are
 * three rows the database already has, and the alternative is the shell waiting
 * on stores that mount agents and open SSH connections to tell it whether to
 * draw a sidebar at all.
 */
export async function installIsEmpty(): Promise<boolean> {
  const [server] = await db.select({ id: switchServers.id }).from(switchServers).limit(1);
  if (server) return false;
  const [location] = await db.select({ id: locations.id }).from(locations).limit(1);
  if (location) return false;
  const [agent] = await db.select({ id: agents.id }).from(agents).limit(1);
  return agent === undefined;
}

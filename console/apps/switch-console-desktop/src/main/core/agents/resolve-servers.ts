import { isNotNull, notInArray } from 'drizzle-orm';
import { listServers } from '@main/core/switch-servers/servers-store';
import { db } from '@main/db/client';
import { agents } from '@main/db/schema';
import { log } from '@main/lib/logger';

/**
 * Drop agent → server links that point at a server no longer in the registry,
 * so an agent never references a server that has been removed.
 *
 * Links are otherwise authoritative: an agent's `serverId` is chosen and
 * verified explicitly at onboarding (or via the assign-server action), not
 * inferred. This reconciliation only *unlinks* dangling references — it never
 * re-derives or re-assigns a server — so an explicit choice is never clobbered.
 * An agent left with a null `serverId` surfaces in the UI as "needs a server".
 *
 * Run at boot and whenever the server registry changes.
 */
export async function resolveAgentServers(): Promise<void> {
  const servers = await listServers();
  const registeredIds = servers.map((s) => s.id);

  // No registered servers → every linked agent is dangling. Otherwise unlink
  // only agents whose serverId is set and not among the registered ids.
  // (`NOT IN` already excludes null rows, so unassigned agents stay untouched.)
  const where =
    registeredIds.length === 0
      ? isNotNull(agents.serverId)
      : notInArray(agents.serverId, registeredIds);

  const result = await db
    .update(agents)
    .set({ serverId: null })
    .where(where)
    .returning({ id: agents.id });

  if (result.length > 0) {
    log.info('switch-agents: unlinked agents pointing at removed servers', {
      unlinked: result.length,
    });
  }
}

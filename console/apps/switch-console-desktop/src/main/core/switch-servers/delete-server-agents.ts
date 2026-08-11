import { eq } from 'drizzle-orm';
import { deleteAgent } from '@main/core/agents/deleteAgent';
import { db } from '@main/db/client';
import { agents } from '@main/db/schema';
import { log } from '@main/lib/logger';

/**
 * Delete every agent that belongs to a managed Switch server, as part of
 * destroying that server's stack.
 *
 * Wiping a managed stack destroys the server-side identity behind each of its
 * agents: the token in the agent's on-disk Switch settings authenticates
 * nothing, and its API endpoint is a port that will never be listened on again.
 * An agent left in that state is not merely idle — Switch Console restores its
 * room-connected sessions on every launch, and each one polls a dead endpoint
 * for as long as the app runs.
 *
 * Deliberately scoped to *managed* servers. De-registering an external server
 * destroys nothing: that switch-core keeps running and its agents keep working,
 * so those agents are unlinked and kept (see `removeServer`).
 *
 * `deleteInSwitch` is false — the server-side records are about to be destroyed
 * wholesale by the reset, and a per-agent gateway call would fail against a
 * stack that is already going away.
 *
 * Each agent is deleted independently so one failure cannot strand the rest;
 * the failures are returned rather than thrown, since the reset that follows is
 * what the caller is really waiting on.
 */
export async function deleteAgentsForServer(
  serverId: string
): Promise<{ deleted: string[]; failed: { agentId: string; error: string }[] }> {
  const rows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.serverId, serverId));

  const deleted: string[] = [];
  const failed: { agentId: string; error: string }[] = [];

  for (const row of rows) {
    try {
      await deleteAgent(row.id, { deleteInSwitch: false });
      deleted.push(row.id);
    } catch (error) {
      failed.push({ agentId: row.id, error: String(error) });
      log.error('deleteAgentsForServer: failed to delete agent of a destroyed server', {
        event: 'server_teardown_agent_failed',
        serverId,
        agentId: row.id,
        agentName: row.name,
        error: String(error),
      });
    }
  }

  if (rows.length > 0) {
    log.info('deleteAgentsForServer: removed agents belonging to a destroyed server', {
      event: 'server_teardown_agents_removed',
      serverId,
      deleted: deleted.length,
      failed: failed.length,
    });
  }

  return { deleted, failed };
}

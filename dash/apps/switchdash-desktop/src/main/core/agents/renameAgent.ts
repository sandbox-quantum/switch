import { eq, sql } from 'drizzle-orm';
import {
  agentSidecarTmuxName,
  killSidecarSession,
} from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import { db } from '@main/db/client';
import { agents } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { Agent, RenameAgentParams } from '@shared/core/agents/agents';
import { getRemoteAgentLocation } from './agent-location';
import { connectRemoteAgent } from './connect-remote-agent';
import { getAgentById } from './getAgentById';
import { ensureRemoteWatcher } from './remote-watcher';
import { mapAgentRowToAgent } from './utils';

/**
 * Tear down the remote sidecar the agent ran under its previous name, then bring
 * one back up under the new one.
 *
 * A sidecar's tmux name is a hash of `(repo dir, creds slug)` and the slug is the
 * agent's name, so a rename makes the running sidecar unreachable to every code
 * path rather than renaming it: left alone it keeps polling the agent's Switch
 * rooms forever while the next launch starts a second one beside it.
 *
 * Best-effort — a rename must not fail because the VM is unreachable. The
 * leftover is then reaped by `reapStaleSidecarsForAgent` on the next launch.
 */
async function moveSidecarToNewName(previous: Agent, renamed: Agent): Promise<void> {
  try {
    const location = await getRemoteAgentLocation(previous);
    if (!location) return;
    const { host, remoteRepoDir } = await connectRemoteAgent(previous);
    await killSidecarSession(
      host,
      agentSidecarTmuxName(remoteRepoDir, previous.name ?? previous.id),
      log
    );
    await ensureRemoteWatcher(renamed.id);
  } catch (error) {
    log.warn('renameAgent: failed to move the sidecar to the new name', {
      agentId: previous.id,
      error: String(error),
    });
  }
}

export async function renameAgent(params: RenameAgentParams): Promise<Agent | undefined> {
  const previous = await getAgentById(params.agentId);
  const [row] = await db
    .update(agents)
    .set({ name: params.newName, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(agents.id, params.agentId))
    .returning();
  if (!row) return undefined;
  const renamed = mapAgentRowToAgent(row);
  if (previous && previous.name !== renamed.name) {
    await moveSidecarToNewName(previous, renamed);
  }
  return renamed;
}

import { eq } from 'drizzle-orm';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { resolveSubagentFs } from '@main/core/subagents/resolve-subagent-fs';
import {
  listAutoSessionSubagents,
  setAutoSessionAgent,
  setAutoSessionSubagent,
} from '@main/core/switch-rooms/auto-session-store';
import { autoSessionWatcher } from '@main/core/switch-rooms/auto-session-watcher';
import {
  deleteAgent as gatewayDeleteAgent,
  fetchAgentChildren,
} from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { viewStateService } from '@main/core/view-state/view-state-service';
import { db } from '@main/db/client';
import { agents, sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import { sessionRuntimeManager } from '../sessions/session-runtime-manager';
import { agentEvents } from './agent-events';
import { getAgentLocation } from './agent-location';
import { getAgentById } from './getAgentById';
import { stopRemoteWatcher } from './remote-watcher';
import { removeSwitchCredentials } from './remove-switch-settings';

export type DeleteAgentOptions = {
  /**
   * Also delete the agent's identity on the Switch server (via the gateway),
   * cascading to delete every subagent registered under it. When false, the
   * agent is removed from switchdash only; its Switch identity (and its
   * subagents') is left registered on the server.
   */
  deleteInSwitch: boolean;
};

/**
 * Delete the agent's identity on the Switch server, cascading to its subagents.
 *
 * The gateway does NOT cascade child deletes on its own (a parent delete only
 * orphans its children), so switchdash drives the cascade: enumerate the
 * registered children and delete each one first, then delete the parent. Runs
 * before any local teardown so a gateway failure surfaces loudly and aborts the
 * delete with local state intact, rather than leaving the row gone but the Switch
 * identity orphaned.
 */
async function deleteAgentInSwitch(agent: Agent): Promise<void> {
  if (!agent.serverId || !agent.switchAgentId) {
    throw new Error(
      `Agent ${agent.id} is not linked to a Switch server, so it cannot be deleted in Switch.`
    );
  }
  const server = await getServer(agent.serverId);
  if (!server) throw new Error(`No Switch server with id ${agent.serverId}`);

  const { children } = await fetchAgentChildren(server, agent.switchAgentId);
  for (const child of children) {
    await gatewayDeleteAgent(server, child.id);
  }
  await gatewayDeleteAgent(server, agent.switchAgentId);
}

/**
 * Reverse the on-disk state switchdash provisioned for the agent: its own Switch
 * credentials (provider-aware — see {@link removeSwitchCredentials}) and every
 * subagent's definition + credential files under its working directory. Runs
 * against the agent's local dir or its remote SSH host transparently.
 *
 * Best-effort: a working directory that is gone or a host that is unreachable
 * should not block removing the agent from switchdash, so failures are logged
 * (visibly) rather than thrown — the credentials being torn down are already dead.
 */
async function removeProvisionedFiles(agent: Agent): Promise<void> {
  const ctx = await resolveSubagentFs(agent.id);
  try {
    const subagents = getPlugin(agent.providerId).behavior.subagents;
    if (subagents) {
      const local = await subagents.discoverLocal(ctx.fs, ctx.homeFs);
      for (const subagent of local) {
        await subagents.removeLocal(ctx.fs, subagent.name).catch((error) => {
          log.warn('deleteAgent: failed to remove subagent files', {
            agentId: agent.id,
            subagent: subagent.name,
            error: String(error),
          });
        });
      }
    }
    await removeSwitchCredentials(agent.providerId, ctx.fs);
  } finally {
    ctx.close();
  }
}

/**
 * Delete an agent — the one real delete entry point (the sidebar's Remove
 * Agent routes here). Tears down everything a bare row delete would leak:
 *
 * 1. The agent's identity on the Switch server, cascading to its subagents —
 *    only when `deleteInSwitch` is set (the opt-in "also delete in Switch").
 * 2. The agent's running sessions (runtime + view-state), which previously
 *    only the location-delete path handled.
 * 3. Its auto_session watcher (or, for a remote agent, the on-VM sidecar's
 *    watch flag + reconciler) and the local auto_session mirror. The watcher
 *    caches the agent's Switch credentials in memory, so without an explicit
 *    stop it keeps heartbeating and polling notifications for an agent that
 *    no longer exists.
 * 4. The Switch credentials + subagent files switchdash provisioned on disk
 *    (local or remote), which a bare row delete would leave orphaned.
 *
 * The agent's location row is intentionally kept — locations are reusable
 * and other agents may still live there.
 */
export async function deleteAgent(agentId: string, options: DeleteAgentOptions): Promise<void> {
  const agent = await getAgentById(agentId);
  const location = agent ? await getAgentLocation(agent).catch(() => null) : null;

  // Gateway cascade first: fail loud before touching local state so a failure
  // never leaves the row deleted but the Switch identity orphaned.
  if (options.deleteInSwitch && agent) {
    await deleteAgentInSwitch(agent);
  }

  const sessionRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.agentId, agentId));
  await Promise.allSettled(
    sessionRows.flatMap((row) => [
      sessionRuntimeManager.teardownSession(row.id),
      viewStateService.del(`session:${row.id}`),
    ])
  );

  if (location && location.sshHost !== null) {
    await stopRemoteWatcher(agentId).catch((error) => {
      log.warn('deleteAgent: failed to stop remote watcher', { agentId, error: String(error) });
    });
  } else {
    autoSessionWatcher.stopForAgent(agentId);
  }

  for (const { parentAgentId, name } of await listAutoSessionSubagents()) {
    if (parentAgentId !== agentId) continue;
    autoSessionWatcher.stopForSubagent(parentAgentId, name);
    await setAutoSessionSubagent(parentAgentId, name, false);
  }
  await setAutoSessionAgent(agentId, false);

  if (agent) {
    await removeProvisionedFiles(agent).catch((error) => {
      log.warn('deleteAgent: failed to remove provisioned files', {
        agentId,
        error: String(error),
      });
    });
  }

  await db.delete(agents).where(eq(agents.id, agentId));
  agentEvents._emit('agent:deleted', agentId);
}

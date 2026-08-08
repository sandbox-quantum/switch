import { eq } from 'drizzle-orm';
import {
  agentSidecarTmuxName,
  killSidecarSession,
} from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { setAutoSessionAgent } from '@main/core/switch-rooms/auto-session-store';
import { autoSessionWatcher } from '@main/core/switch-rooms/auto-session-watcher';
import { deleteAgent as gatewayDeleteAgent } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { viewStateService } from '@main/core/view-state/view-state-service';
import { db } from '@main/db/client';
import { agents, sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import type { Location } from '@shared/core/locations/locations';
import { sessionRuntimeManager } from '../sessions/session-runtime-manager';
import { agentEvents } from './agent-events';
import { getAgentLocation } from './agent-location';
import { resolveWorkspaceFsFor } from './agent-workspace-fs';
import { connectRemoteAgent } from './connect-remote-agent';
import { getAgentById } from './getAgentById';
import { stopRemoteWatcher } from './remote-watcher';
import { removeAgentLaunchProfile } from './remove-launch-profile';
import { agentSettingsRelativePath } from './switch-settings-paths';

export type DeleteAgentOptions = {
  /**
   * Also delete the agent's identity on the Switch server (via the gateway).
   * When false, the agent is removed from switchdash only; its Switch identity is
   * left registered on the server.
   */
  deleteInSwitch: boolean;
};

/**
 * Delete this agent's own identity on the Switch server — and ONLY this one.
 *
 * switchdash agents are flat: a directory is a container of independent agents
 * with no parent/child hierarchy (CHOO-1440), so deleting one never affects any
 * other agent, even a sibling in the same directory. (Legacy agents may still
 * carry a gateway parent/child link from the old subagent model; we deliberately
 * do not follow it — deleting a former "parent" simply orphans those links, it
 * must not cascade-delete the other agents.) Runs before any local teardown so a
 * gateway failure surfaces loudly and aborts the delete with local state intact,
 * rather than leaving the row gone but the Switch identity orphaned.
 */
async function deleteAgentInSwitch(agent: Agent): Promise<void> {
  if (!agent.serverId || !agent.switchAgentId) {
    throw new Error(
      `Agent ${agent.id} is not linked to a Switch server, so it cannot be deleted in Switch.`
    );
  }
  const server = await getServer(agent.serverId);
  if (!server) throw new Error(`No Switch server with id ${agent.serverId}`);

  await gatewayDeleteAgent(server, agent.switchAgentId);
}

/**
 * Reverse the on-disk state switchdash provisioned for this one agent: its
 * provider definition (`.claude/agents/<name>.md`) and its per-agent Switch
 * credentials. Runs against the agent's local dir or its remote SSH host
 * transparently. Only THIS agent's files are removed — sibling agents sharing the
 * directory are untouched (CHOO-1440).
 *
 * Best-effort: a working directory that is gone or a host that is unreachable
 * should not block removing the agent from switchdash, so failures are logged
 * (visibly) rather than thrown — the credentials being torn down are already dead.
 */
async function removeProvisionedFiles(agent: Agent, location: Location): Promise<void> {
  const ctx = await resolveWorkspaceFsFor(location.sshHost, location.dir);
  try {
    const behavior = getPlugin(agent.providerId).behavior.repoAgents;
    if (behavior && agent.name) {
      await behavior.removeLocal(ctx.fs, agent.name).catch((error) => {
        log.warn('deleteAgent: failed to remove agent definition files', {
          agentId: agent.id,
          name: agent.name,
          error: String(error),
        });
      });
    }
    // The per-agent credentials are written for every provider, so they are
    // removed for every provider — a provider without repo-agent definitions has
    // no `removeLocal` to carry the token file out with it.
    //
    // Isolated like `removeLocal` above: each teardown step must run even if an
    // earlier one fails, or one unwritable file leaves the rest of the agent's
    // credentials behind.
    await ctx.fs.delete(agentSettingsRelativePath(agent.name ?? agent.id)).catch((error) => {
      log.warn('deleteAgent: failed to remove the per-agent Switch credentials', {
        agentId: agent.id,
        name: agent.name,
        error: String(error),
      });
    });
    // A provider that registers the Switch server itself (Codex) leaves a
    // per-agent launch profile under the user's home — a different scope than
    // ctx.fs, reached through its own home filesystem (local or remote).
    await removeAgentLaunchProfile(agent, location, agent.name ?? agent.id);
  } finally {
    ctx.close();
  }
}

/**
 * Kill the agent's own sidecar on its VM. `stopRemoteWatcher` only flips the
 * watch flag — the process stays up, holding this agent's Switch room
 * connections and renewing them, for an agent that is about to stop existing.
 * Nothing would ever address that sidecar again: its tmux name is derived from
 * the agent row being deleted. Scoped to this agent's name, so a sibling sharing
 * the directory keeps its own (CHOO-1440).
 *
 * Best-effort: an unreachable host must not block removing the agent locally.
 */
async function killRemoteSidecar(agent: Agent): Promise<void> {
  try {
    const { host, remoteRepoDir } = await connectRemoteAgent(agent);
    await killSidecarSession(
      host,
      agentSidecarTmuxName(remoteRepoDir, agent.name ?? agent.id),
      log
    );
  } catch (error) {
    log.warn('deleteAgent: failed to kill the remote sidecar', {
      agentId: agent.id,
      error: String(error),
    });
  }
}

/**
 * Delete an agent — the one real delete entry point (the sidebar's Remove
 * Agent routes here). Tears down everything a bare row delete would leak:
 *
 * 1. The agent's own identity on the Switch server (never any other agent) —
 *    only when `deleteInSwitch` is set (the opt-in "also delete in Switch").
 * 2. The agent's running sessions (runtime + view-state), which previously
 *    only the location-delete path handled.
 * 3. Its auto_session watcher (or, for a remote agent, the on-VM sidecar's
 *    watch flag + reconciler) and the local auto_session mirror. The watcher
 *    caches the agent's Switch credentials in memory, so without an explicit
 *    stop it keeps heartbeating and polling notifications for an agent that
 *    no longer exists.
 * 4. The Switch credentials + definition file switchdash provisioned on disk for
 *    THIS agent (local or remote), which a bare row delete would leave orphaned.
 *    Sibling agents' files in the same directory are untouched.
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
    if (agent) await killRemoteSidecar(agent);
  } else {
    autoSessionWatcher.stopForAgent(agentId);
  }

  await setAutoSessionAgent(agentId, false);

  if (agent && location) {
    await removeProvisionedFiles(agent, location).catch((error) => {
      log.warn('deleteAgent: failed to remove provisioned files', {
        agentId,
        error: String(error),
      });
    });
  }

  await db.delete(agents).where(eq(agents.id, agentId));
  agentEvents._emit('agent:deleted', agentId);
}

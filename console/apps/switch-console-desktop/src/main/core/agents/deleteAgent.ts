import { eq } from 'drizzle-orm';
import {
  agentSidecarTmuxName,
  killSidecarSession,
} from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { sessionHooks } from '@main/core/sessions/session-hooks';
import { setAutoSessionAgent } from '@main/core/switch-rooms/auto-session-store';
import { autoSessionWatcher } from '@main/core/switch-rooms/auto-session-watcher';
import {
  deleteAgent as gatewayDeleteAgent,
  GatewayError,
} from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { agentTypeOf } from '@main/core/telemetry/agent-type';
import type {
  TelemetryAgentRemoveFailure,
  TelemetryAgentRemoveTrigger,
  TelemetryLocationKind,
} from '@main/core/telemetry/events';
import { agentRemoveTriggerOf } from '@main/core/telemetry/narrow';
import { trackEvent } from '@main/core/telemetry/telemetry-service';
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
import { removeSwitchCredentials } from './remove-switch-settings';
import { agentSettingsRelativePath } from './switch-settings-paths';

export type DeleteAgentOptions = {
  /**
   * Also delete the agent's identity on the Switch server (via the gateway).
   * When false, the agent is removed from Switch Console only; its Switch identity is
   * left registered on the server.
   */
  deleteInSwitch: boolean;
  /**
   * Also tear down what was provisioned on disk for this agent (its
   * `.switch/agents/<name>.json` credentials, provider definition files, launch
   * profile) and kill its sidecar on the host.
   *
   * Required with no default, because the right answer depends on who owns the
   * on-disk state: an agent this Console created can carry its files out, but an
   * agent merely loaded from a shared host (CHOO-2560) has credentials that
   * belong to ANOTHER install — deleting them there is data loss on a
   * colleague's machine. Plain remove must mirror attach's guarantee: nothing in
   * the working directory is touched.
   */
  removeProvisionedFiles: boolean;
  /**
   * Whether a person removed this agent or a server teardown swept it up.
   *
   * Required, because the same function serves both: wiping a managed server
   * deletes every agent on it one at a time, and a default here would file that
   * as a room full of people deleting their agents at once.
   */
  trigger: TelemetryAgentRemoveTrigger;
};

/**
 * The agent has no Switch identity to delete.
 *
 * A class rather than a message, so the reason can be reported as a code
 * without matching on prose that a later edit would quietly change.
 */
class AgentNotLinkedToSwitchError extends Error {}

/** What went wrong, as a code taken from the error's own type. */
function removeFailureReason(error: unknown): TelemetryAgentRemoveFailure {
  if (error instanceof AgentNotLinkedToSwitchError) return 'not_linked_to_switch';
  if (error instanceof GatewayError) return `gateway_${error.kind}`;
  return 'error';
}

/** Where the agent runs, from a row already read. `unknown` when it has gone. */
function locationKindOfRow(location: Location | null): TelemetryLocationKind {
  if (!location) return 'unknown';
  return location.sshHost ? 'remote' : 'local';
}

/**
 * Delete this agent's own identity on the Switch server — and ONLY this one.
 *
 * Switch Console agents are flat: a directory is a container of independent agents
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
    throw new AgentNotLinkedToSwitchError(
      `Agent ${agent.id} is not linked to a Switch server, so it cannot be deleted in Switch.`
    );
  }
  const server = await getServer(agent.serverId);
  if (!server) {
    throw new AgentNotLinkedToSwitchError(`No Switch server with id ${agent.serverId}`);
  }

  await gatewayDeleteAgent(server, agent.switchAgentId);
}

/**
 * Reverse the on-disk state Switch Console provisioned for this one agent: its
 * provider definition (`.claude/agents/<name>.md`) and its per-agent Switch
 * credentials. Runs against the agent's local dir or its remote SSH host
 * transparently. Only THIS agent's files are removed — sibling agents sharing the
 * directory are untouched (CHOO-1440).
 *
 * Best-effort: a working directory that is gone or a host that is unreachable
 * should not block removing the agent from Switch Console, so failures are logged
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
    await removeSwitchCredentials(agent.providerId, ctx.fs);
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
 * 4. Only when `removeProvisionedFiles` is set: the Switch credentials +
 *    definition file provisioned on disk for THIS agent (local or remote), and
 *    its sidecar. A plain remove leaves the working directory and the host's
 *    processes untouched — on a shared host they may belong to another install
 *    (CHOO-2560). Sibling agents' files are never touched either way.
 *
 * The agent's location row is intentionally kept — locations are reusable
 * and other agents may still live there.
 */
export async function deleteAgent(agentId: string, options: DeleteAgentOptions): Promise<void> {
  const agent = await getAgentById(agentId);
  const location = agent ? await getAgentLocation(agent).catch(() => null) : null;
  // Captured before the row goes: after the delete below there is nothing left
  // to describe what was removed.
  const shape = {
    agent_type: agent ? agentTypeOf(agent.providerId) : ('unknown' as const),
    location: locationKindOfRow(location),
    delete_in_switch: options.deleteInSwitch,
    trigger: agentRemoveTriggerOf(options.trigger),
  };

  try {
    await removeAgent(agentId, agent, location, options);
  } catch (error) {
    trackEvent('agent_removed', {
      ...shape,
      outcome: 'failure',
      failure_reason: removeFailureReason(error),
    });
    throw error;
  }
  trackEvent('agent_removed', { ...shape, outcome: 'success', failure_reason: 'none' });
}

async function removeAgent(
  agentId: string,
  agent: Agent | undefined,
  location: Location | null,
  options: DeleteAgentOptions
): Promise<void> {
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
    // The sidecar is host state, like the files: killing it under an agent
    // another install still manages takes their agent offline. Only tear it
    // down when the on-disk teardown was asked for.
    if (agent && options.removeProvisionedFiles) await killRemoteSidecar(agent);
  } else {
    autoSessionWatcher.stopForAgent(agentId);
  }

  await setAutoSessionAgent(agentId, false);

  if (agent && location && options.removeProvisionedFiles) {
    await removeProvisionedFiles(agent, location).catch((error) => {
      log.warn('deleteAgent: failed to remove provisioned files', {
        agentId,
        error: String(error),
      });
    });
  }

  await db.delete(agents).where(eq(agents.id, agentId));
  // The session rows go with it, by a foreign key rather than by any code here,
  // so nothing else announces their end. Without this every session an agent
  // owned reports a start and no finish — the row is gone and no later pass can
  // notice it left.
  for (const row of sessionRows) sessionHooks._emit('session:deleted', row.id);
  agentEvents._emit('agent:deleted', agentId);
}

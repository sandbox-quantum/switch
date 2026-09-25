import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { getAgents } from '@main/core/agents/getAgents';
import { onManagedServerUpgraded } from '@main/core/managed-switch-server/session-readiness';
import type { HostReachabilityChange } from '@main/core/remote-hosts/host-reachability-service';
import { hostReachabilityService } from '@main/core/remote-hosts/production-host-reachability';
import { disposeLocalHosts } from '@main/core/sdk-host/local-host';
import { applyControllerState, configureSharedWatcher } from '@main/core/sdk-host/shared-watcher';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import {
  listAutoSessionAgentIds,
  listAutoSessionSubagents,
  setAutoSessionAgent,
  setAutoSessionSubagent,
} from './auto-session-store';

type Subagent = { parentAgentId: string; name: string };

class AutoSessionWatcher {
  private watchingHosts = false;
  private watchingUpgrades = false;
  private readonly recovering = new Map<string, { again: boolean }>();

  /**
   * Brings up a controller for every agent linked to Switch, whether or not it
   * may start sessions: an agent is reachable because it exists, and the
   * auto-start setting only decides what its controller does with a message it
   * is addressed in.
   *
   * Each server's agents are brought up on their own, because a controller
   * waits for its managed server to finish upgrading and that must not hold
   * back the agents of every other server.
   */
  async initialize(): Promise<void> {
    this.watchHostRecovery();
    this.watchServerUpgrades();
    for (const agentId of await listAutoSessionAgentIds())
      if (!(await getAgentById(agentId))) await setAutoSessionAgent(agentId, false);
    const agents = await getAgents();
    const subagents: Subagent[] = [];
    for (const subagent of await listAutoSessionSubagents()) {
      if (!(await getAgentById(subagent.parentAgentId))) {
        await setAutoSessionSubagent(subagent.parentAgentId, subagent.name, false);
        continue;
      }
      subagents.push(subagent);
    }
    const servers = new Set(agents.map((agent) => agent.serverId));
    await Promise.all(
      [...servers].map((serverId) => {
        const members = agents.filter((agent) => agent.serverId === serverId);
        return this.startControllers(members, subagentsOf(members, subagents));
      })
    );
  }

  /**
   * Controllers refused while their managed server owed an upgrade — a failed
   * one, or a stopped one — are started once it has finished.
   */
  private watchServerUpgrades(): void {
    if (this.watchingUpgrades) return;
    this.watchingUpgrades = true;
    onManagedServerUpgraded((serverId) => void this.restoreServer(serverId));
  }

  private async restoreServer(serverId: string): Promise<void> {
    try {
      const members = (await getAgents()).filter((agent) => agent.serverId === serverId);
      await this.startControllers(members, subagentsOf(members, await listAutoSessionSubagents()));
    } catch (error) {
      log.error('Shared SDK watchers could not start after their server updated', {
        serverId,
        error: String(error),
      });
    }
  }

  private async startControllers(agents: Agent[], subagents: Subagent[]): Promise<void> {
    for (const agent of agents) {
      if (!agent.switchAgentId) continue;
      try {
        // Restoring a controller an earlier run was already meant to be
        // holding, not a decision to reclaim a connection something else has
        // since taken: one that stood down stays down until someone asks for it
        // by name.
        await applyControllerState(agent.id, 'restore');
      } catch (error) {
        log.error('Shared SDK watcher could not start', {
          agentId: agent.id,
          error: String(error),
        });
      }
    }
    for (const { parentAgentId, name } of subagents) {
      try {
        await this.startForSubagent(parentAgentId, name);
      } catch (error) {
        log.error('Shared SDK subagent watcher could not start', {
          parentAgentId,
          name,
          error: String(error),
        });
      }
    }
  }
  /**
   * A controller whose host was unreachable is otherwise never tried again: the
   * sweep above runs once, so an agent on a host that was down at boot — or one
   * that went down and took its controller with it — stays off the air until
   * Console is restarted. Reachability is the one place that knows a host came
   * back, and it reports it once per recovery rather than per attempt.
   */
  private watchHostRecovery(): void {
    if (this.watchingHosts) return;
    this.watchingHosts = true;
    hostReachabilityService.on('change', ({ current }: HostReachabilityChange) => {
      if (current.status === 'reachable') void this.restoreHost(current.sshHost);
    });
  }

  private async restoreHost(sshHost: string): Promise<void> {
    const running = this.recovering.get(sshHost);
    // A host that goes away and returns while its sweep is still running has
    // invalidated that sweep: whatever it started may have gone down with the
    // host again, and whatever failed while the host was away is the reason
    // this recovery matters. Dropping the second signal loses the agents in
    // both sets until the next flap, so the sweep is run again instead.
    if (running) {
      running.again = true;
      return;
    }
    const run = { again: false };
    this.recovering.set(sshHost, run);
    try {
      do {
        run.again = false;
        await this.startHostControllers(sshHost);
      } while (run.again);
    } finally {
      this.recovering.delete(sshHost);
    }
  }

  private async startHostControllers(sshHost: string): Promise<void> {
    for (const agent of await getAgents()) {
      if (!agent.switchAgentId) continue;
      const location = await getAgentLocation(agent).catch(() => null);
      if (location?.sshHost !== sshHost) continue;
      try {
        // A host coming back is not somebody asking for a connection back, so
        // a controller that stood down after a takeover stays down and one
        // stopped by hand stays stopped.
        await applyControllerState(agent.id, 'restore');
      } catch (error) {
        log.error('Shared SDK watcher could not start after its host returned', {
          agentId: agent.id,
          error: String(error),
        });
      }
    }
  }

  stopForAgent(agentId: string): Promise<void> {
    return configureSharedWatcher(agentId, { connected: false, spawning: false }, 'restore');
  }
  startForSubagent(agentId: string, name: string): Promise<void> {
    return configureSharedWatcher(agentId, { connected: true, spawning: true }, 'restore', name);
  }
  stopForSubagent(agentId: string, name: string): Promise<void> {
    return configureSharedWatcher(agentId, { connected: false, spawning: false }, 'restore', name);
  }
  /**
   * Applies the saved auto-start setting. The controller stays connected either
   * way — only Stop, or deleting the agent, takes an agent's connection away.
   */
  reconcile(agentId: string): Promise<void> {
    return applyControllerState(agentId, 'explicit');
  }
  reconcileSubagent(agentId: string, name: string, enabled: boolean): Promise<void> {
    return configureSharedWatcher(
      agentId,
      { connected: enabled, spawning: enabled },
      'explicit',
      name
    );
  }
  /** Stops every locally hosted watcher and session, so none outlives Console. */
  dispose(): Promise<void> {
    return disposeLocalHosts();
  }
}
function subagentsOf(parents: Agent[], subagents: Subagent[]): Subagent[] {
  const ids = new Set(parents.map((agent) => agent.id));
  return subagents.filter((subagent) => ids.has(subagent.parentAgentId));
}

export const autoSessionWatcher = new AutoSessionWatcher();

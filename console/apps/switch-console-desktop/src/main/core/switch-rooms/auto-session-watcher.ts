import { managedRecordFor } from '@main/core/agent-migration/managed-agents-store';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { getAgents } from '@main/core/agents/getAgents';
import { onManagedServerUpgraded } from '@main/core/managed-switch-server/session-readiness';
import type { HostReachabilityChange } from '@main/core/remote-hosts/host-reachability-service';
import { hostReachabilityService } from '@main/core/remote-hosts/production-host-reachability';
import { applyControllerState, configureAgentHost } from '@main/core/sdk-host/agent-host';
import { disposeLocalHosts, type WatcherIntent } from '@main/core/sdk-host/local-host';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import { listAutoSessionSubagents, setAutoSessionSubagent } from './auto-session-store';
import { currentWatchers } from './current-watchers';

type Subagent = { parentAgentId: string; name: string };

/**
 * How long a host must stay reachable before its recovery sweep runs.
 *
 * A tunnel that drops and returns every 10–30 seconds — which is what an
 * overloaded SSH tunnel does — announced every return, and each one started a
 * full sweep over the host's agents. The sweep is the most expensive thing
 * Console does to a host, so instability triggered the work most likely to
 * make it worse. Waiting for the host to hold still first means a flap costs
 * nothing, and a genuine recovery is delayed by a couple of seconds.
 */
export const HOST_SETTLE_MS = 3_000;
/** The wait before trying again a controller that could not be brought up. */
export const RETRY_FIRST_MS = 30_000;
/** Retries back off by doubling, up to this. */
export const RETRY_MAX_MS = 5 * 60_000;

class AutoSessionWatcher {
  private watchingHosts = false;
  private watchingUpgrades = false;
  private readonly recovering = new Map<string, { again: boolean }>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly settling = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Brings up a controller for every agent linked to Switch. Each server's
   * agents are brought up on their own, because a controller waits for its
   * managed server to finish upgrading and that must not hold back the agents
   * of every other server.
   */
  async initialize(): Promise<void> {
    this.watchHostRecovery();
    this.watchServerUpgrades();
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

  /**
   * Each host is asked once what its watchers are already doing, and only the
   * agents that need something are brought up — usually none. A bring-up is
   * about a dozen SSH round trips whose normal outcome is the launcher
   * deciding to leave a healthy watcher alone, so twenty agents meant ~260
   * round trips to discover twenty times that there was nothing to do. On a
   * host that keeps reconnecting, that ran again on every recovery.
   *
   * Each host's agents are still brought up in turn, and the hosts side by side:
   * a host whose connection is slow or wedged holds back only its own agents,
   * never another host's or this machine's, and one host is not sent every
   * agent's launch at once over its one connection.
   *
   * Restoring a controller an earlier run was already meant to be holding is
   * not a decision to reclaim a connection something else has since taken: one
   * that stood down stays down until someone asks for it by name.
   */
  private async startControllers(agents: Agent[], subagents: Subagent[]): Promise<void> {
    const hosts = new Map<string, Agent[]>();
    for (const agent of agents) {
      if (!agent.switchAgentId) continue;
      const location = await getAgentLocation(agent).catch(() => null);
      const host = location?.sshHost ?? '';
      hosts.set(host, [...(hosts.get(host) ?? []), agent]);
    }
    await Promise.all(
      [...hosts.values()].map(async (members) => {
        const current = await currentWatchers(members);
        for (const agent of members) {
          if (current.has(agent.id)) continue;
          await this.bringUp(agent.id, 'restore');
        }
      })
    );
    for (const { parentAgentId, name } of subagents) {
      try {
        // A subagent moved with its parent, and its parent's controller runs it.
        if (await managedRecordFor(parentAgentId, null)) continue;
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
      if (current.status === 'reachable') this.scheduleRestore(current.sshHost);
      // A host that has gone away again cancels the sweep it had not earned
      // yet: the point of waiting is to not sweep a host that cannot hold a
      // connection.
      else clearTimeout(this.settling.get(current.sshHost));
    });
  }

  /**
   * Run the recovery sweep once the host has stayed reachable for
   * `HOST_SETTLE_MS`, restarting that wait on every further announcement.
   * A host flapping faster than that never sweeps, which is correct: there is
   * nothing to restore onto a connection that keeps dying.
   */
  private scheduleRestore(sshHost: string): void {
    clearTimeout(this.settling.get(sshHost));
    const timer = setTimeout(() => {
      this.settling.delete(sshHost);
      void this.restoreHost(sshHost);
    }, HOST_SETTLE_MS);
    timer.unref();
    this.settling.set(sshHost, timer);
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
      // A host coming back is not somebody asking for a connection back, so a
      // controller that stood down after a takeover stays down and one stopped
      // by hand stays stopped.
      await this.bringUp(agent.id, 'restore');
    }
  }

  /**
   * Puts an agent's controller in the state its settings describe, and keeps
   * trying until it gets there. A controller that cannot be brought up —
   * its host unreachable, its connection wedged, its server mid-upgrade — is
   * tried again after `RETRY_FIRST_MS`, doubling up to `RETRY_MAX_MS`, until
   * it comes up or the agent is gone. Nothing else would try it again, so
   * without this the agent stays off the air until something unrelated, such
   * as a host reconnecting or Console restarting, happens to reapply it.
   *
   * Retries are restores whatever the first attempt was: only the first is
   * somebody's request.
   */
  async bringUp(agentId: string, intent: WatcherIntent): Promise<void> {
    this.cancelRetry(agentId);
    try {
      await applyControllerState(agentId, intent, 'host');
    } catch (error) {
      log.error('Shared SDK watcher could not start; will retry', {
        agentId,
        error: String(error),
      });
      this.scheduleRetry(agentId, 0);
    }
  }

  private scheduleRetry(agentId: string, attempt: number): void {
    const delay = Math.min(RETRY_FIRST_MS * 2 ** attempt, RETRY_MAX_MS);
    const timer = setTimeout(() => {
      if (this.retries.get(agentId) !== timer) return;
      this.retries.delete(agentId);
      void (async () => {
        if (!(await getAgentById(agentId))?.switchAgentId) return;
        try {
          await applyControllerState(agentId, 'restore', 'host');
        } catch (error) {
          log.warn('Shared SDK watcher still could not start; will retry', {
            agentId,
            attempt: attempt + 1,
            error: String(error),
          });
          if (!this.retries.has(agentId)) this.scheduleRetry(agentId, attempt + 1);
        }
      })();
    }, delay);
    timer.unref?.();
    this.retries.set(agentId, timer);
  }

  private cancelRetry(agentId: string): void {
    clearTimeout(this.retries.get(agentId));
    this.retries.delete(agentId);
  }

  /** Stops retrying the agent's watcher, for a caller that turns it off by other means. */
  forgetRetries(agentId: string): void {
    this.cancelRetry(agentId);
  }

  stopForAgent(agentId: string): Promise<void> {
    this.cancelRetry(agentId);
    return configureAgentHost(agentId, { connected: false, spawning: false }, 'restore');
  }
  startForSubagent(agentId: string, name: string): Promise<void> {
    return configureAgentHost(agentId, { connected: true, spawning: true }, 'restore', name);
  }
  stopForSubagent(agentId: string, name: string): Promise<void> {
    return configureAgentHost(agentId, { connected: false, spawning: false }, 'restore', name);
  }
  /** Stops every locally hosted watcher and session, so none outlives Console. */
  dispose(): Promise<void> {
    for (const agentId of [...this.retries.keys()]) this.cancelRetry(agentId);
    for (const timer of this.settling.values()) clearTimeout(timer);
    this.settling.clear();
    return disposeLocalHosts();
  }
}
function subagentsOf(parents: Agent[], subagents: Subagent[]): Subagent[] {
  const ids = new Set(parents.map((agent) => agent.id));
  return subagents.filter((subagent) => ids.has(subagent.parentAgentId));
}

export const autoSessionWatcher = new AutoSessionWatcher();

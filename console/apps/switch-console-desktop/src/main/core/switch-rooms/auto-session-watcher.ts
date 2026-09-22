import { getAgentById } from '@main/core/agents/getAgentById';
import { getAgents } from '@main/core/agents/getAgents';
import { disposeLocalHosts } from '@main/core/sdk-host/local-host';
import { applyControllerState, configureSharedWatcher } from '@main/core/sdk-host/shared-watcher';
import { log } from '@main/lib/logger';
import {
  listAutoSessionAgentIds,
  listAutoSessionSubagents,
  setAutoSessionAgent,
  setAutoSessionSubagent,
} from './auto-session-store';

class AutoSessionWatcher {
  /**
   * Brings up a controller for every agent linked to Switch, whether or not it
   * may start sessions: an agent is reachable because it exists, and the
   * auto-start setting only decides what its controller does with a message it
   * is addressed in.
   */
  async initialize(): Promise<void> {
    for (const agentId of await listAutoSessionAgentIds())
      if (!(await getAgentById(agentId))) await setAutoSessionAgent(agentId, false);
    for (const agent of await getAgents()) {
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
    for (const { parentAgentId, name } of await listAutoSessionSubagents()) {
      if (!(await getAgentById(parentAgentId))) {
        await setAutoSessionSubagent(parentAgentId, name, false);
        continue;
      }
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
export const autoSessionWatcher = new AutoSessionWatcher();

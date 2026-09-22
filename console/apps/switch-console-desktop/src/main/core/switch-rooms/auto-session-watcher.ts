import { getAgentById } from '@main/core/agents/getAgentById';
import { disposeLocalHosts } from '@main/core/sdk-host/local-host';
import { configureSharedWatcher } from '@main/core/sdk-host/shared-watcher';
import { log } from '@main/lib/logger';
import {
  listAutoSessionAgentIds,
  listAutoSessionSubagents,
  setAutoSessionAgent,
  setAutoSessionSubagent,
} from './auto-session-store';

class AutoSessionWatcher {
  async initialize(): Promise<void> {
    for (const agentId of await listAutoSessionAgentIds()) {
      if (!(await getAgentById(agentId))) {
        await setAutoSessionAgent(agentId, false);
        continue;
      }
      try {
        await this.startForAgent(agentId);
      } catch (error) {
        log.error('Shared SDK watcher could not start', { agentId, error: String(error) });
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
  /**
   * Booting restores the watcher an earlier run left enabled. That is not a
   * decision to reclaim a connection something else has since taken, so a
   * watcher that stood down stays down until someone asks for it by name.
   */
  startForAgent(agentId: string): Promise<void> {
    return configureSharedWatcher(agentId, { connected: true, spawning: true }, 'restore');
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
  reconcile(agentId: string, enabled: boolean): Promise<void> {
    return configureSharedWatcher(agentId, { connected: enabled, spawning: enabled }, 'explicit');
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

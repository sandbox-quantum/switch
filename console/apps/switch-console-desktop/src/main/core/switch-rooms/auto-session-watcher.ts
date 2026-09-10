import { getAgentById } from '@main/core/agents/getAgentById';
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
  startForAgent(agentId: string): Promise<void> {
    return configureSharedWatcher(agentId, true);
  }
  stopForAgent(agentId: string): Promise<void> {
    return configureSharedWatcher(agentId, false);
  }
  startForSubagent(agentId: string, name: string): Promise<void> {
    return configureSharedWatcher(agentId, true, name);
  }
  stopForSubagent(agentId: string, name: string): Promise<void> {
    return configureSharedWatcher(agentId, false, name);
  }
  reconcile(agentId: string, enabled: boolean): Promise<void> {
    return configureSharedWatcher(agentId, enabled);
  }
  reconcileSubagent(agentId: string, name: string, enabled: boolean): Promise<void> {
    return configureSharedWatcher(agentId, enabled, name);
  }
  dispose(): void {}
}
export const autoSessionWatcher = new AutoSessionWatcher();

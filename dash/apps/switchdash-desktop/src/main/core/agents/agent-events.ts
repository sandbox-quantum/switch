import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';

export type AgentCrudHooks = {
  'agent:created': (agent: Agent) => void | Promise<void>;
  'agent:deleted': (agentId: string) => void | Promise<void>;
};

class AgentEvents implements Hookable<AgentCrudHooks> {
  private readonly _core = new HookCore<AgentCrudHooks>((name, e) =>
    log.error(`AgentEvents: ${String(name)} hook error`, e)
  );

  on<K extends keyof AgentCrudHooks>(name: K, handler: AgentCrudHooks[K]) {
    return this._core.on(name, handler);
  }

  _emit<K extends keyof AgentCrudHooks>(name: K, ...args: Parameters<AgentCrudHooks[K]>): void {
    this._core.callHookBackground(name, ...args);
  }
}

export const agentEvents = new AgentEvents();

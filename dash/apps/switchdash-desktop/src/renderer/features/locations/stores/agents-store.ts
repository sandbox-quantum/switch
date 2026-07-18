import { makeAutoObservable, runInAction } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import type { Agent } from '@shared/core/agents/agents';

/**
 * Renderer cache of every agent across all locations, used to resolve which
 * Switch server a location belongs to. The sidebar scopes its tree to the active
 * server (see {@link switchServersStore.activeServerId}), so it needs a reactive
 * location→serverId lookup that does not depend on each row's own react-query.
 *
 * A location holds one parent agent plus any subagents, which all share the same
 * server; {@link serverIdForLocation} returns the first non-null serverId among a
 * location's agents.
 */
export class AgentsStore {
  /** All agents grouped by their location id. */
  readonly byLocation = new Map<string, Agent[]>();
  /**
   * Server id a just-created location's agent will belong to, recorded by the
   * add-agent modal before {@link load} has re-fetched the new agent. Used as a
   * fallback in {@link serverIdForLocation} so a freshly-created location does not
   * flicker out of the sidebar's server-scoped view during the gap between the
   * location mounting and the agent list refreshing.
   */
  readonly optimisticServerByLocation = new Map<string, string>();
  loaded = false;

  constructor() {
    makeAutoObservable(this);
  }

  async load(): Promise<void> {
    const agents = await rpc.agents.getAgents();
    runInAction(() => {
      this.byLocation.clear();
      for (const agent of agents) {
        const list = this.byLocation.get(agent.locationId);
        if (list) list.push(agent);
        else this.byLocation.set(agent.locationId, [agent]);
      }
      // Drop optimistic notes now superseded by a real agent record.
      for (const locationId of this.byLocation.keys()) {
        this.optimisticServerByLocation.delete(locationId);
      }
      this.loaded = true;
    });
  }

  /** Record the server a location's agent will bind to, ahead of {@link load}. */
  noteLocationServer(locationId: string, serverId: string): void {
    runInAction(() => {
      this.optimisticServerByLocation.set(locationId, serverId);
    });
  }

  /** The Switch server a location's agents belong to, or null if unlinked. */
  serverIdForLocation(locationId: string): string | null {
    const agents = this.byLocation.get(locationId);
    const resolved = agents?.find((a) => a.serverId !== null)?.serverId ?? null;
    return resolved ?? this.optimisticServerByLocation.get(locationId) ?? null;
  }
}

export const agentsStore = new AgentsStore();

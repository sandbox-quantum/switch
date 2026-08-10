import { makeAutoObservable, runInAction } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import type { Agent } from '@shared/core/agents/agents';

/**
 * Renderer cache of every agent across all locations. The sidebar scopes its tree
 * to the active server (see {@link switchServersStore.activeServerId}), so it needs
 * a reactive lookup that does not depend on each row's own react-query.
 *
 * **A server belongs to an agent, not to a directory.** A directory is a place on
 * disk and can hold agents registered against several servers at once, so there is
 * no such thing as "the location's server" to scope on — asking for one drags every
 * agent in the directory under whichever answer came back first (CHOO-2044). Scope
 * on {@link agentsOnServerAtLocation}; a location is in scope when it has any.
 */
export class AgentsStore {
  /** All agents grouped by their location id. */
  readonly byLocation = new Map<string, Agent[]>();
  /**
   * Server id a just-created location's agent will belong to, recorded by the
   * add-agent modal before {@link load} has re-fetched the new agent. Used as a
   * fallback in {@link locationHasAgentsOnServer} so a freshly-created location does
   * not flicker out of the sidebar's server-scoped view during the gap between the
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

  /** One agent by id, across every location — the palette resolves an agent's
   *  provider from a search hit this way, so it can show the same provider mark
   *  the sidebar does. */
  agentById(agentId: string): Agent | null {
    for (const agents of this.byLocation.values()) {
      const found = agents.find((a) => a.id === agentId);
      if (found) return found;
    }
    return null;
  }

  /**
   * This install's agents that are registered on a given Switch server, i.e.
   * the ones switchdash can actually act on there. The room views list and
   * offer these and no others: an agent registered on some other switchdash
   * cannot be shown under a room or driven from here, so offering it would
   * promise something this app cannot deliver.
   */
  agentsOnServer(serverId: string): Agent[] {
    const matching: Agent[] = [];
    for (const agents of this.byLocation.values()) {
      for (const agent of agents) {
        if (agent.serverId === serverId && agent.switchAgentId) matching.push(agent);
      }
    }
    return matching.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A location's agents that belong to one server — what the sidebar renders
   *  under that server. Agents in the same directory registered elsewhere are not
   *  this server's to show. */
  agentsOnServerAtLocation(locationId: string, serverId: string): Agent[] {
    return (this.byLocation.get(locationId) ?? []).filter((a) => a.serverId === serverId);
  }

  /** Whether a location has anything to show under `serverId`. */
  locationHasAgentsOnServer(locationId: string, serverId: string): boolean {
    return this.serverIdsForLocation(locationId).includes(serverId);
  }

  /**
   * The servers a location's agents belong to. A directory can span several, so
   * this is a list rather than the one answer callers used to ask for.
   *
   * The optimistic note stands in only while the location has no agent rows at
   * all — that is the gap it exists to cover. Letting it also speak for a location
   * that already has agents would have it claim a server the location is not on.
   */
  serverIdsForLocation(locationId: string): string[] {
    const agents = this.byLocation.get(locationId);
    if (!agents || agents.length === 0) {
      const optimistic = this.optimisticServerByLocation.get(locationId);
      return optimistic ? [optimistic] : [];
    }
    const ids = new Set<string>();
    for (const agent of agents) {
      if (agent.serverId !== null) ids.add(agent.serverId);
    }
    return [...ids];
  }
}

export const agentsStore = new AgentsStore();

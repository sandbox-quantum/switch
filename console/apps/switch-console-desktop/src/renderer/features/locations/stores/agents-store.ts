import { makeAutoObservable, runInAction } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import type { Agent } from '@shared/core/agents/agents';

/**
 * Renderer cache of every agent across all locations. The sidebar scopes its tree
 * to the active workspace (see {@link workspacesStore.activeId}), so it needs a
 * reactive lookup that does not depend on each row's own react-query.
 *
 * **A workspace belongs to an agent, not to a directory.** A directory is a place
 * on disk and can hold agents registered in several workspaces at once, so there
 * is no such thing as "the location's workspace" to scope on — asking for one
 * drags every agent in the directory under whichever answer came back first
 * (CHOO-2044). Scope on {@link agentsInWorkspaceAtLocation}; a location is in
 * scope when it has any.
 */
export class AgentsStore {
  /** All agents grouped by their location id. */
  readonly byLocation = new Map<string, Agent[]>();
  /**
   * Workspace id a just-created location's agent will belong to, recorded by the
   * add-agent modal before {@link load} has re-fetched the new agent. Used as a
   * fallback in {@link locationHasAgentsInWorkspace} so a freshly-created location
   * does not flicker out of the sidebar's workspace-scoped view during the gap
   * between the location mounting and the agent list refreshing.
   */
  readonly optimisticWorkspaceByLocation = new Map<string, string>();
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
        this.optimisticWorkspaceByLocation.delete(locationId);
      }
      this.loaded = true;
    });
  }

  /** Record the workspace a location's agent will bind to, ahead of {@link load}. */
  noteLocationWorkspace(locationId: string, workspaceId: string): void {
    runInAction(() => {
      this.optimisticWorkspaceByLocation.set(locationId, workspaceId);
    });
  }

  /** One agent by id, across every location — the palette resolves a search
   *  hit's agent this way, so it can wear the same face and provider mark the
   *  sidebar gives it. */
  agentById(agentId: string): Agent | null {
    for (const agents of this.byLocation.values()) {
      const found = agents.find((a) => a.id === agentId);
      if (found) return found;
    }
    return null;
  }

  /**
   * The agent an agent page is routed to — its location plus its name, the pair
   * every caller of the `location` view navigates with.
   *
   * A route carrying no name is answered only where there is nothing to guess
   * between: a location holding exactly one agent resolves to it. Beyond that,
   * null rather than a guess — picking one of several would put another agent's
   * provider and identity above someone's session list.
   */
  agentAtLocation(locationId: string, agentName: string | undefined): Agent | null {
    const agents = this.byLocation.get(locationId) ?? [];
    if (agentName === undefined) return agents.length === 1 ? agents[0]! : null;
    return agents.find((a) => a.name === agentName) ?? null;
  }

  /**
   * This install's agents that are registered on a given Switch server, i.e.
   * the ones Switch Console can actually act on there. The room views list and
   * offer these and no others: an agent registered on some other Switch Console
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

  /**
   * This install's agents in a given workspace — the ones the room views may
   * list and offer.
   *
   * The workspace-addressed counterpart of {@link agentsOnServer}, and what a
   * view scoped to a workspace asks for: its rooms and their members are that
   * workspace's, and a server hosting several would otherwise offer agents from
   * all of them.
   */
  agentsInWorkspace(workspaceId: string): Agent[] {
    const matching: Agent[] = [];
    for (const agents of this.byLocation.values()) {
      for (const agent of agents) {
        if (agent.workspaceId === workspaceId && agent.switchAgentId) matching.push(agent);
      }
    }
    return matching.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * A location's agents that belong to one workspace — what the sidebar renders
   * under that workspace. Agents in the same directory registered elsewhere are
   * not this workspace's to show.
   *
   * Unlike {@link agentsInWorkspace} this keeps agents with no Switch identity:
   * an agent still being registered has a workspace and a row in the tree, and
   * dropping it would make it disappear from the sidebar mid-onboarding.
   */
  agentsInWorkspaceAtLocation(locationId: string, workspaceId: string): Agent[] {
    return (this.byLocation.get(locationId) ?? []).filter((a) => a.workspaceId === workspaceId);
  }

  /** Whether a location has anything to show under `workspaceId`. */
  locationHasAgentsInWorkspace(locationId: string, workspaceId: string): boolean {
    return this.workspaceIdsForLocation(locationId).includes(workspaceId);
  }

  /**
   * The workspaces a location's agents belong to. A directory can span several,
   * so this is a list rather than the one answer callers used to ask for.
   *
   * The optimistic note stands in only while the location has no agent rows at
   * all — that is the gap it exists to cover. Letting it also speak for a location
   * that already has agents would have it claim a workspace the location is not in.
   */
  workspaceIdsForLocation(locationId: string): string[] {
    const agents = this.byLocation.get(locationId);
    if (!agents || agents.length === 0) {
      const optimistic = this.optimisticWorkspaceByLocation.get(locationId);
      return optimistic ? [optimistic] : [];
    }
    const ids = new Set<string>();
    for (const agent of agents) {
      if (agent.workspaceId !== null) ids.add(agent.workspaceId);
    }
    return [...ids];
  }
}

export const agentsStore = new AgentsStore();

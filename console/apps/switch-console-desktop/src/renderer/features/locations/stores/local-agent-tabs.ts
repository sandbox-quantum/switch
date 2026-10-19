import { makeAutoObservable } from 'mobx';
import type { ServiceGrants } from '@shared/core/switch-servers/service-grants';

export type LocalAgentTab = 'overview' | 'connections';

export type LocalAgentTabOption = { value: LocalAgentTab; label: string };

const TABS: readonly LocalAgentTabOption[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'connections', label: 'Connections' },
];

/**
 * The tabs a local agent's page offers, or null for none: the page is then
 * the one scrolling page it always was. Connections is the only reason for
 * tabs, so they need what it needs: the agent registered on a server, the
 * server's `service_connections` flag, and grants that are the caller's. A
 * server answers null for another person's agent, such as one loaded from
 * them. While the grants load the tabs are offered.
 */
export function localAgentTabs(
  registered: boolean,
  serviceConnections: boolean,
  grants: ServiceGrants | null | undefined
): readonly LocalAgentTabOption[] | null {
  return registered && serviceConnections && grants !== null ? TABS : null;
}

/** The tab to show: the one chosen, or Overview when the page has no tabs. */
export function shownLocalAgentTab(
  chosen: LocalAgentTab,
  tabs: readonly LocalAgentTabOption[] | null
): LocalAgentTab {
  return tabs === null ? 'overview' : chosen;
}

/**
 * Which tab the open local agent is showing, as a managed agent's is kept:
 * one selection, remembered against the agent's local id, so opening a
 * different agent starts on its overview.
 */
export class LocalAgentTabStore {
  private agentId: string | null = null;
  private tab: LocalAgentTab = 'overview';

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  tabFor(agentId: string): LocalAgentTab {
    return this.agentId === agentId ? this.tab : 'overview';
  }

  setTab(agentId: string, tab: LocalAgentTab): void {
    this.agentId = agentId;
    this.tab = tab;
  }
}

export const localAgentTabStore = new LocalAgentTabStore();

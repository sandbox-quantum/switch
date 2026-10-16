import { makeAutoObservable } from 'mobx';

export type AgentTab = 'chats' | 'connections' | 'settings';

/**
 * Which tab the open agent is showing, as the room page's tab is kept: one
 * selection, remembered against the agent id, so opening a different agent
 * starts on its chats again.
 */
export class AgentTabStore {
  private agentId: string | null = null;
  private tab: AgentTab = 'chats';

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  tabFor(agentId: string): AgentTab {
    return this.agentId === agentId ? this.tab : 'chats';
  }

  setTab(agentId: string, tab: AgentTab): void {
    this.agentId = agentId;
    this.tab = tab;
  }
}

export const agentTabStore = new AgentTabStore();

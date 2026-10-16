import { describe, expect, it } from 'vitest';
import type { ServiceGrants } from '@shared/core/switch-servers/service-grants';
import { AgentTabStore } from './agent-tab-store';
import { agentTabs, shownAgentTab } from './agent-tabs';

const GRANTS: ServiceGrants = { grants: [], addressing_open: false };

const values = (tabs: ReturnType<typeof agentTabs>) => tabs.map((tab) => tab.value);

describe('the agent tab store', () => {
  it('keeps Connections for the agent it was chosen on, and starts another agent on Chats', () => {
    const store = new AgentTabStore();
    store.setTab('agent-1', 'connections');
    expect(store.tabFor('agent-1')).toBe('connections');
    expect(store.tabFor('agent-2')).toBe('chats');
  });
});

describe("a managed agent's tabs", () => {
  it('offers Connections between Chats and Settings for an agent whose grants are yours', () => {
    expect(values(agentTabs(true, GRANTS))).toEqual(['chats', 'connections', 'settings']);
  });

  it('offers Connections while the grants load, since the page lists only your agents', () => {
    expect(values(agentTabs(true, undefined))).toEqual(['chats', 'connections', 'settings']);
  });

  it("hides Connections for an agent you don't own: the server answers its grants with null", () => {
    expect(values(agentTabs(true, null))).toEqual(['chats', 'settings']);
  });

  it('hides Connections when the server has service connections off', () => {
    expect(values(agentTabs(false, GRANTS))).toEqual(['chats', 'settings']);
  });

  it('shows the chosen tab, or Chats when Connections was chosen and is no longer offered', () => {
    expect(shownAgentTab('connections', agentTabs(true, GRANTS))).toBe('connections');
    expect(shownAgentTab('connections', agentTabs(true, null))).toBe('chats');
    expect(shownAgentTab('settings', agentTabs(false, GRANTS))).toBe('settings');
  });
});

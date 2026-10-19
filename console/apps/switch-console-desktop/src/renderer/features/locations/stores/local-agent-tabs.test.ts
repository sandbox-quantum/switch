import { describe, expect, it } from 'vitest';
import type { ServiceGrants } from '@shared/core/switch-servers/service-grants';
import { LocalAgentTabStore, localAgentTabs, shownLocalAgentTab } from './local-agent-tabs';

const GRANTS: ServiceGrants = { grants: [], addressing_open: false };

const values = (tabs: ReturnType<typeof localAgentTabs>) => tabs?.map((tab) => tab.value) ?? null;

describe("a local agent's tabs", () => {
  it('offers Overview and Connections for a registered agent whose grants are yours', () => {
    expect(values(localAgentTabs(true, true, GRANTS))).toEqual(['overview', 'connections']);
  });

  it('offers them while the grants load', () => {
    expect(values(localAgentTabs(true, true, undefined))).toEqual(['overview', 'connections']);
  });

  it('has no tabs for an agent not registered on a server', () => {
    expect(localAgentTabs(false, true, undefined)).toBeNull();
  });

  it('has no tabs when the server has service connections off', () => {
    expect(localAgentTabs(true, false, GRANTS)).toBeNull();
  });

  it("has no tabs for an agent you don't own, such as one loaded from someone else", () => {
    expect(localAgentTabs(true, true, null)).toBeNull();
  });

  it('shows the chosen tab, or Overview when the page has no tabs', () => {
    expect(shownLocalAgentTab('connections', localAgentTabs(true, true, GRANTS))).toBe(
      'connections'
    );
    expect(shownLocalAgentTab('connections', localAgentTabs(true, true, null))).toBe('overview');
  });
});

describe('the local agent tab store', () => {
  it('keeps Connections for the agent it was chosen on, and starts another agent on Overview', () => {
    const store = new LocalAgentTabStore();
    store.setTab('local-1', 'connections');
    expect(store.tabFor('local-1')).toBe('connections');
    expect(store.tabFor('local-2')).toBe('overview');
  });
});

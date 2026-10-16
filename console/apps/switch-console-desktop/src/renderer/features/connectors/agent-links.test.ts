import { describe, expect, it, vi } from 'vitest';
import { LocalAgentTabStore } from '@renderer/features/locations/stores/local-agent-tabs';
import { AgentTabStore } from '@renderer/features/managed-agents/agent-tab-store';
import type { NavigateFnTyped } from '@renderer/lib/layout/navigation-provider';
import type { Agent } from '@shared/core/agents/agents';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { ELSEWHERE_TITLE, agentLinkFor, openAgentConnections } from './agent-links';

const LOCAL: Agent = {
  id: 'local-1',
  locationId: 'location-1',
  name: 'm1-cc',
  providerId: 'claude',
  switchAgentId: 'switch-local',
  apiEndpoint: null,
  workspaceId: 'workspace',
  serverId: 'server',
  status: null,
  autoApprove: false,
  ownerName: null,
  providerConfig: null,
  createdAt: '2026-10-16T00:00:00Z',
  updatedAt: '2026-10-16T00:00:00Z',
};

const MANAGED: ManagedAgentView = {
  serverId: 'server',
  workspaceId: 'workspace',
  agentId: 'switch-managed',
  name: 'm3-managed',
  displayName: 'M3',
  iconUrl: null,
  description: '',
  machine: null,
  desiredState: 'running',
  revision: 1,
  definition: {
    provider: 'claude',
    model: null,
    advancedConfig: {},
    instructions: '',
    autoApprove: false,
    directory: null,
    isolation: 'shared',
  },
  status: null,
};

describe("a Used by chip's link", () => {
  it("opens a local agent's page by its location and name", () => {
    expect(agentLinkFor('switch-local', [LOCAL], [MANAGED])).toEqual({
      kind: 'local',
      agentId: 'local-1',
      locationId: 'location-1',
      agentName: 'm1-cc',
    });
  });

  it("opens a managed agent's page under the name the sidebar gives it", () => {
    expect(agentLinkFor('switch-managed', [LOCAL], [MANAGED])).toEqual({
      kind: 'managed',
      serverId: 'server',
      agentId: 'switch-managed',
      name: 'M3',
    });
  });

  it('opens a managed agent that still has a local row as managed', () => {
    const moved = { ...LOCAL, switchAgentId: 'switch-managed' };
    expect(agentLinkFor('switch-managed', [moved], [MANAGED]).kind).toBe('managed');
  });

  it('leads nowhere for an agent this Console does not have, and says why', () => {
    expect(agentLinkFor('switch-other', [LOCAL], [MANAGED])).toEqual({
      kind: 'elsewhere',
      title: ELSEWHERE_TITLE,
    });
    expect(agentLinkFor('switch-managed', [LOCAL], null).kind).toBe('elsewhere');
  });
});

describe("opening an agent's Connections tab", () => {
  const stores = () => ({ local: new LocalAgentTabStore(), managed: new AgentTabStore() });

  it('selects the tab on a local agent, then opens its page', () => {
    const tabs = stores();
    const navigate = vi.fn();
    openAgentConnections(
      agentLinkFor('switch-local', [LOCAL], null) as Parameters<typeof openAgentConnections>[0],
      navigate as unknown as NavigateFnTyped,
      tabs
    );
    expect(tabs.local.tabFor('local-1')).toBe('connections');
    expect(navigate).toHaveBeenCalledWith('location', {
      locationId: 'location-1',
      agentName: 'm1-cc',
    });
  });

  it('selects the tab on a managed agent, then opens its page', () => {
    const tabs = stores();
    const navigate = vi.fn();
    openAgentConnections(
      agentLinkFor('switch-managed', [], [MANAGED]) as Parameters<typeof openAgentConnections>[0],
      navigate as unknown as NavigateFnTyped,
      tabs
    );
    expect(tabs.managed.tabFor('switch-managed')).toBe('connections');
    expect(navigate).toHaveBeenCalledWith('managedAgent', {
      serverId: 'server',
      agentId: 'switch-managed',
      name: 'M3',
    });
  });
});

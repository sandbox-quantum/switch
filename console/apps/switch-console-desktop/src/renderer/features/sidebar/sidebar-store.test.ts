import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import type { AgentConnectionKind } from '@shared/core/agents/agent-connection';
import type { Agent } from '@shared/core/agents/agents';
import {
  agentExpandKey,
  agentRoomGroupKey,
  applyManualOrder,
  roomAgentGroupKey,
  roomViewGroupKey,
  SidebarStore,
} from './sidebar-store';

type SidebarLocationManager = ConstructorParameters<typeof SidebarStore>[0];

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: vi.fn(),
  },
  rpc: {},
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {},
}));

function locationManager(locations: { id: string; createdAt: string }[]): SidebarLocationManager {
  return {
    locations: new Map(locations.map((p) => [p.id, { ...p, mountedLocation: null }])),
  } as unknown as SidebarLocationManager;
}

function session(id: string, createdAt: string) {
  return {
    state: 'provisioned',
    data: {
      id,
      type: 'coding-agent',
      isPinned: false,
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function locationManagerWithSessions(
  locations: { id: string; createdAt: string; sessionIds: string[] }[]
): SidebarLocationManager {
  return {
    locations: new Map(
      locations.map((location) => [
        location.id,
        {
          id: location.id,
          createdAt: location.createdAt,
          mountedLocation: {
            sessionManager: {
              sessions: new Map(
                location.sessionIds.map((sessionId, index) => [
                  sessionId,
                  session(sessionId, `2026-01-01T00:00:0${index}.000Z`),
                ])
              ),
            },
          },
        },
      ])
    ),
  } as unknown as SidebarLocationManager;
}

describe('SidebarStore location ordering', () => {
  it('sorts locations newest first by default', () => {
    const store = new SidebarStore(
      locationManager([
        { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'new', createdAt: '2026-01-02T00:00:00.000Z' },
      ])
    );

    expect(store.orderedLocations.map((location) => location.id)).toEqual(['new', 'old']);
  });

  it('orders locations by recency alone — manual order lives on agents, not locations', () => {
    const store = new SidebarStore(
      locationManager([
        { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'middle', createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'new', createdAt: '2026-01-03T00:00:00.000Z' },
      ])
    );

    expect(store.orderedLocations.map((location) => location.id)).toEqual(['new', 'middle', 'old']);
  });

  it('returns visible session entries in rendered location-tree order', () => {
    const store = new SidebarStore(
      locationManagerWithSessions([
        {
          // Newest, so it renders first and its sessions lead the list.
          id: 'location-1',
          createdAt: '2026-01-02T00:00:00.000Z',
          sessionIds: ['session-1a', 'session-1b'],
        },
        {
          id: 'location-2',
          createdAt: '2026-01-01T00:00:00.000Z',
          sessionIds: ['session-2a'],
        },
      ])
    );

    store.ensureLocationExpanded('location-1');
    store.ensureLocationExpanded('location-2');
    store.setSessionOrder('location-1', ['session-1a', 'session-1b']);

    expect(store.visibleSessionEntries).toEqual([
      { locationId: 'location-1', sessionId: 'session-1a' },
      { locationId: 'location-1', sessionId: 'session-1b' },
      { locationId: 'location-2', sessionId: 'session-2a' },
    ]);
  });
});

describe('SidebarStore grouping', () => {
  it('defaults to agent grouping', () => {
    const store = new SidebarStore(locationManager([]));
    expect(store.grouping).toBe('agent');
  });

  it('round-trips grouping and expanded room keys through the snapshot', () => {
    const store = new SidebarStore(locationManager([]));
    store.setGrouping('room');
    store.ensureRoomExpanded('room-1');
    store.toggleRoomExpanded('room-2');

    const snapshot = store.snapshot;
    expect(snapshot.grouping).toBe('room');
    expect(snapshot.expandedRoomKeys?.sort()).toEqual(['room-1', 'room-2']);

    const restored = new SidebarStore(locationManager([]));
    restored.restoreSnapshot(snapshot);
    expect(restored.grouping).toBe('room');
    expect(restored.expandedRoomKeys.has('room-1')).toBe(true);
    expect(restored.expandedRoomKeys.has('room-2')).toBe(true);
  });

  it('opens the agent and room group a selected session sits in', () => {
    const store = new SidebarStore(locationManager([]));
    // Simulate the user having collapsed both groups above the session.
    store.toggleGroupExpanded(agentExpandKey('agent-1'));
    store.toggleGroupExpanded(agentRoomGroupKey('agent-1', 'room-1'));

    store.revealSelection({ kind: 'session', agentId: 'agent-1', roomKey: 'room-1' });

    expect(store.isGroupExpanded(agentExpandKey('agent-1'))).toBe(true);
    expect(store.isGroupExpanded(agentRoomGroupKey('agent-1', 'room-1'))).toBe(true);
  });

  it('leaves the grouping the user cannot see untouched', () => {
    const store = new SidebarStore(locationManager([]));
    store.toggleGroupExpanded(roomViewGroupKey('room-1'));
    store.toggleGroupExpanded(roomAgentGroupKey('room-1', 'agent-1'));

    // Agent-focused is on screen, so the room-focused groups stay as they were.
    store.revealSelection({ kind: 'session', agentId: 'agent-1', roomKey: 'room-1' });

    expect(store.isGroupExpanded(roomViewGroupKey('room-1'))).toBe(false);
    expect(store.isGroupExpanded(roomAgentGroupKey('room-1', 'agent-1'))).toBe(false);

    store.setGrouping('room');
    store.revealSelection({ kind: 'session', agentId: 'agent-1', roomKey: 'room-1' });

    expect(store.isGroupExpanded(roomViewGroupKey('room-1'))).toBe(true);
    expect(store.isGroupExpanded(roomAgentGroupKey('room-1', 'agent-1'))).toBe(true);
  });

  it('opens every agent a selected room is listed under', () => {
    const store = new SidebarStore(locationManager([]));
    store.toggleGroupExpanded(agentExpandKey('agent-1'));
    store.toggleGroupExpanded(agentExpandKey('agent-2'));

    store.revealSelection({
      kind: 'room',
      roomKey: 'room-1',
      agentIds: ['agent-1', 'agent-2'],
    });

    expect(store.isGroupExpanded(agentExpandKey('agent-1'))).toBe(true);
    expect(store.isGroupExpanded(agentExpandKey('agent-2'))).toBe(true);
  });

  it('opens the room an agent was selected from, in the room-focused tree', () => {
    const store = new SidebarStore(locationManager([]));
    store.setGrouping('room');
    store.toggleGroupExpanded(roomViewGroupKey('room-1'));

    store.revealSelection({ kind: 'agent', roomKey: 'room-1' });

    expect(store.isGroupExpanded(roomViewGroupKey('room-1'))).toBe(true);
  });

  it('closes the branches Collapse all names', () => {
    // The regression this guards: collapseAll used to clear expandedLocationIds
    // and expandedRoomKeys, which no tree has read since the sidebar was
    // regrouped around agents and rooms — so the button moved nothing on screen.
    const store = new SidebarStore(locationManager([]));

    store.collapseAll([agentExpandKey('agent-1'), agentExpandKey('agent-2')]);

    expect(store.isGroupExpanded(agentExpandKey('agent-1'))).toBe(false);
    expect(store.isGroupExpanded(agentExpandKey('agent-2'))).toBe(false);
  });

  it('leaves branches Collapse all was not given open', () => {
    // The caller passes only the grouping on screen, so collapsing in one view
    // must not rearrange the other one behind the user's back.
    const store = new SidebarStore(locationManager([]));

    store.collapseAll([agentExpandKey('agent-1')]);

    expect(store.isGroupExpanded(roomViewGroupKey('room-1'))).toBe(true);
  });

  it('leaves a nested group as the user left it when its parent collapses', () => {
    // Reopening an agent should show the rooms under it the way they were, not
    // a tree flattened by a button pressed at the top level.
    const store = new SidebarStore(locationManager([]));
    store.toggleGroupExpanded(agentRoomGroupKey('agent-1', 'room-1'));

    store.collapseAll([agentExpandKey('agent-1')]);
    store.toggleGroupExpanded(agentExpandKey('agent-1'));

    expect(store.isGroupExpanded(agentExpandKey('agent-1'))).toBe(true);
    expect(store.isGroupExpanded(agentRoomGroupKey('agent-1', 'room-1'))).toBe(false);
  });

  it('collapses one agent-under-room without collapsing the same agent elsewhere', () => {
    // An agent in two rooms is two rows in two places, not one row drawn twice.
    // Keyed by agent alone they collapsed and highlighted together.
    const store = new SidebarStore(locationManager([]));
    store.toggleGroupExpanded(roomAgentGroupKey('room-1', 'agent-1'));

    expect(store.isGroupExpanded(roomAgentGroupKey('room-1', 'agent-1'))).toBe(false);
    expect(store.isGroupExpanded(roomAgentGroupKey('room-2', 'agent-1'))).toBe(true);
  });

  it("returns a location's visible sessions for grouped views", () => {
    const store = new SidebarStore(
      locationManagerWithSessions([
        {
          id: 'location-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          sessionIds: ['session-1a', 'session-1b'],
        },
      ])
    );

    expect(
      store
        .visibleSessionsForLocation('location-1')
        .map((s) => s.data.id)
        .sort()
    ).toEqual(['session-1a', 'session-1b']);
    expect(store.visibleSessionsForLocation('missing')).toEqual([]);
  });
});

describe('SidebarStore active-server scoping', () => {
  function linkAgent(locationId: string, serverId: string | null) {
    agentsStore.byLocation.set(locationId, [{ locationId, serverId } as Agent]);
  }

  afterEach(() => {
    switchServersStore.activeServerId = null;
    agentsStore.byLocation.clear();
  });

  it("shows only the active server's locations", () => {
    const store = new SidebarStore(
      locationManager([
        { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', createdAt: '2026-01-02T00:00:00.000Z' },
      ])
    );
    linkAgent('a', 'server-1');
    linkAgent('b', 'server-2');
    switchServersStore.activeServerId = 'server-1';

    expect(store.orderedLocations.map((p) => p.id)).toEqual(['a']);
    expect(store.isEmpty).toBe(false);
  });

  it('shows all locations when no server is active', () => {
    const store = new SidebarStore(
      locationManager([
        { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', createdAt: '2026-01-02T00:00:00.000Z' },
      ])
    );
    linkAgent('a', 'server-1');
    linkAgent('b', 'server-2');

    expect(store.orderedLocations.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('hides unlinked locations when a server is active', () => {
    const store = new SidebarStore(
      locationManager([{ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' }])
    );
    linkAgent('a', null);
    switchServersStore.activeServerId = 'server-1';

    expect(store.orderedLocations).toEqual([]);
    expect(store.isEmpty).toBe(true);
  });

  it('shows a directory shared between servers under both (CHOO-2044)', () => {
    // A directory is a place on disk, not one server's territory. Resolving it to
    // a single server filed it under whichever agent came back first, and the
    // other server's agents vanished from the tree.
    const store = new SidebarStore(
      locationManager([{ id: 'shared', createdAt: '2026-01-01T00:00:00.000Z' }])
    );
    agentsStore.byLocation.set('shared', [
      { locationId: 'shared', serverId: 'server-1' } as Agent,
      { locationId: 'shared', serverId: 'server-2' } as Agent,
    ]);

    switchServersStore.activeServerId = 'server-1';
    expect(store.orderedLocations.map((p) => p.id)).toEqual(['shared']);

    switchServersStore.activeServerId = 'server-2';
    expect(store.orderedLocations.map((p) => p.id)).toEqual(['shared']);

    switchServersStore.activeServerId = 'server-3';
    expect(store.orderedLocations).toEqual([]);
  });

  it('describes a shared directory by an agent on the active server (CHOO-2044)', () => {
    const store = new SidebarStore(
      locationManager([{ id: 'shared', createdAt: '2026-01-01T00:00:00.000Z' }])
    );
    agentsStore.byLocation.set('shared', [
      { locationId: 'shared', serverId: 'server-1', providerId: 'claude' } as Agent,
      { locationId: 'shared', serverId: 'server-2', providerId: 'codex' } as Agent,
    ]);

    switchServersStore.activeServerId = 'server-2';
    expect(store.locationProviderId('shared')).toBe('codex');
  });
});

describe('SidebarStore filters', () => {
  type SessionState = 'provisioned' | 'unprovisioned' | 'unregistered';

  function filterLocationManager(
    locations: {
      id: string;
      createdAt: string;
      sessionStates?: SessionState[];
      sshHost?: string | null;
    }[]
  ): SidebarLocationManager {
    return {
      locations: new Map(
        locations.map((location) => [
          location.id,
          {
            id: location.id,
            createdAt: location.createdAt,
            data: {
              id: location.id,
              name: location.id,
              sshHost: location.sshHost ?? null,
              dir: `/repo/${location.id}`,
              createdAt: location.createdAt,
              updatedAt: location.createdAt,
            },
            mountedLocation: location.sessionStates
              ? {
                  sessionManager: {
                    sessions: new Map(
                      location.sessionStates.map((state, index) => {
                        const id = `${location.id}-s${index}`;
                        return [
                          id,
                          {
                            state,
                            data: {
                              id,
                              isPinned: false,
                              createdAt: location.createdAt,
                              updatedAt: location.createdAt,
                            },
                          },
                        ];
                      })
                    ),
                  },
                }
              : null,
          },
        ])
      ),
    } as unknown as SidebarLocationManager;
  }

  function linkAgent(locationId: string, fields: { providerId?: Agent['providerId'] }) {
    agentsStore.byLocation.set(locationId, [{ locationId, serverId: null, ...fields } as Agent]);
  }

  afterEach(() => {
    agentsStore.byLocation.clear();
    switchServersStore.activeServerId = null;
  });

  it('returns all locations unfiltered when no filter is active', () => {
    const store = new SidebarStore(
      filterLocationManager([
        { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', createdAt: '2026-01-02T00:00:00.000Z' },
      ])
    );
    expect(store.hasActiveFilters).toBe(false);
    expect(store.filteredLocations).toEqual(store.orderedLocations);
  });

  it('filters by run location', () => {
    const store = new SidebarStore(
      filterLocationManager([
        { id: 'local-agent', createdAt: '2026-01-01T00:00:00.000Z', sshHost: null },
        { id: 'remote-agent', createdAt: '2026-01-02T00:00:00.000Z', sshHost: 'vm' },
      ])
    );

    store.toggleFilterConnection('remote');
    expect(store.filteredLocations.map((p) => p.id)).toEqual(['remote-agent']);
  });

  it('filters by agent type, OR-ing selections within the dimension', () => {
    const store = new SidebarStore(
      filterLocationManager([
        { id: 'claude-agent', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'opencode-agent', createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'codex-agent', createdAt: '2026-01-03T00:00:00.000Z' },
      ])
    );
    linkAgent('claude-agent', { providerId: 'claude' });
    linkAgent('opencode-agent', { providerId: 'opencode' });
    linkAgent('codex-agent', { providerId: 'codex' });

    store.toggleFilterProviderId('claude');
    store.toggleFilterProviderId('opencode');
    expect(store.filteredLocations.map((p) => p.id).sort()).toEqual([
      'claude-agent',
      'opencode-agent',
    ]);
  });

  it('filters by presence of a running (provisioned) session', () => {
    const store = new SidebarStore(
      filterLocationManager([
        { id: 'running', createdAt: '2026-01-01T00:00:00.000Z', sessionStates: ['provisioned'] },
        { id: 'idle', createdAt: '2026-01-02T00:00:00.000Z', sessionStates: ['unprovisioned'] },
        { id: 'none', createdAt: '2026-01-03T00:00:00.000Z' },
      ])
    );

    store.setFilterHasLiveSession(true);
    expect(store.filteredLocations.map((p) => p.id)).toEqual(['running']);
  });

  it('composes dimensions with AND across, keeping only locations that match all', () => {
    const store = new SidebarStore(
      filterLocationManager([
        {
          id: 'remote-running',
          createdAt: '2026-01-01T00:00:00.000Z',
          sessionStates: ['provisioned'],
          sshHost: 'vm',
        },
        {
          id: 'remote-idle',
          createdAt: '2026-01-02T00:00:00.000Z',
          sessionStates: ['unprovisioned'],
          sshHost: 'vm',
        },
        {
          id: 'local-running',
          createdAt: '2026-01-03T00:00:00.000Z',
          sessionStates: ['provisioned'],
          sshHost: null,
        },
      ])
    );

    store.toggleFilterConnection('remote');
    store.setFilterHasLiveSession(true);
    expect(store.filteredLocations.map((p) => p.id)).toEqual(['remote-running']);
  });

  it('offers only filter values present among in-scope agents', () => {
    const store = new SidebarStore(
      filterLocationManager([
        { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', createdAt: '2026-01-02T00:00:00.000Z' },
      ])
    );
    linkAgent('a', { providerId: 'claude' });
    linkAgent('b', { providerId: 'opencode' });

    expect(store.availableFilterConnections).toEqual(['local']);
    expect(store.availableFilterProviderIds).toEqual(['claude', 'opencode']);
  });

  it('clears every filter dimension', () => {
    const store = new SidebarStore(filterLocationManager([]));
    store.toggleFilterConnection('remote');
    store.toggleFilterProviderId('claude');
    store.setFilterHasLiveSession(true);
    expect(store.hasActiveFilters).toBe(true);

    store.clearFilters();
    expect(store.hasActiveFilters).toBe(false);
    expect(store.filterConnections.size).toBe(0);
    expect(store.filterProviderIds.size).toBe(0);
    expect(store.filterHasLiveSession).toBe(false);
  });

  it('round-trips filters through the snapshot, dropping invalid values', () => {
    const store = new SidebarStore(filterLocationManager([]));
    store.toggleFilterConnection('remote');
    store.toggleFilterProviderId('claude');
    store.setFilterHasLiveSession(true);

    const snapshot = store.snapshot;
    expect(snapshot.filterConnections).toEqual(['remote']);
    expect(snapshot.filterProviderIds).toEqual(['claude']);
    expect(snapshot.filterHasLiveSession).toBe(true);

    const restored = new SidebarStore(filterLocationManager([]));
    restored.restoreSnapshot({
      ...snapshot,
      filterConnections: [...(snapshot.filterConnections ?? []), 'bogus' as AgentConnectionKind],
      filterProviderIds: [...(snapshot.filterProviderIds ?? []), 'nope' as Agent['providerId']],
    });
    expect([...restored.filterConnections]).toEqual(['remote']);
    expect([...restored.filterProviderIds]).toEqual(['claude']);
    expect(restored.filterHasLiveSession).toBe(true);
  });
});

describe('applyManualOrder', () => {
  const id = (x: string) => x;

  it('returns the input unchanged when no manual order is saved', () => {
    expect(applyManualOrder(['a', 'b', 'c'], id, undefined, false)).toEqual(['a', 'b', 'c']);
    expect(applyManualOrder(['a', 'b', 'c'], id, [], false)).toEqual(['a', 'b', 'c']);
  });

  it('reorders to match the saved order, dropping ids no longer present', () => {
    expect(applyManualOrder(['a', 'b', 'c'], id, ['c', 'a', 'gone', 'b'], false)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('appends items missing from the saved order when newFirst is false', () => {
    expect(applyManualOrder(['a', 'b', 'new'], id, ['b', 'a'], false)).toEqual(['b', 'a', 'new']);
  });

  it('prepends items missing from the saved order when newFirst is true', () => {
    expect(applyManualOrder(['a', 'b', 'new'], id, ['b', 'a'], true)).toEqual(['new', 'b', 'a']);
  });
});

describe('SidebarStore drag-to-reorder ordering', () => {
  it('orders top-level rooms by the saved manual room order', () => {
    const store = new SidebarStore(locationManager([]));
    store.setRoomOrder(['room-c', 'room-a']);
    const rooms = [{ roomKey: 'room-a' }, { roomKey: 'room-b' }, { roomKey: 'room-c' }];
    // Saved rooms come first in saved order; unknown rooms append.
    expect(store.orderRooms(rooms, (room) => room.roomKey)).toEqual([
      { roomKey: 'room-c' },
      { roomKey: 'room-a' },
      { roomKey: 'room-b' },
    ]);
  });

  it('orders top-level agents by the saved manual agent order', () => {
    const store = new SidebarStore(locationManager([]));
    store.setAgentOrder(['agent-c', 'agent-a']);
    const agents = [{ id: 'agent-a' }, { id: 'agent-b' }, { id: 'agent-c' }];
    expect(store.orderAgents(agents, (agent) => agent.id)).toEqual([
      { id: 'agent-c' },
      { id: 'agent-a' },
      { id: 'agent-b' },
    ]);
  });

  it('keeps a dragged agent in place when a new agent arrives', () => {
    const store = new SidebarStore(locationManager([]));
    store.setAgentOrder(['agent-b', 'agent-a']);
    // A newly-added agent must not displace an order the user set deliberately.
    const agents = [{ id: 'agent-a' }, { id: 'agent-b' }, { id: 'fresh' }];
    expect(store.orderAgents(agents, (agent) => agent.id).map((agent) => agent.id)).toEqual([
      'agent-b',
      'agent-a',
      'fresh',
    ]);
  });

  it('round-trips agent and room order through the snapshot', () => {
    const store = new SidebarStore(locationManager([]));
    store.setRoomOrder(['room-2', 'room-1']);
    store.setAgentOrder(['agent-2', 'agent-1']);

    const snapshot = store.snapshot;
    expect(snapshot.roomOrder).toEqual(['room-2', 'room-1']);
    expect(snapshot.agentOrder).toEqual(['agent-2', 'agent-1']);

    const restored = new SidebarStore(locationManager([]));
    restored.restoreSnapshot(snapshot);
    expect(restored.roomOrder).toEqual(['room-2', 'room-1']);
    expect(restored.agentOrder).toEqual(['agent-2', 'agent-1']);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import type { Agent } from '@shared/core/agents/agents';
import type { AgentConnectionKind } from '@shared/core/agents/agent-connection';
import {
  agentRoomGroupKey,
  applyManualOrder,
  roomViewGroupKey,
  SidebarStore,
} from './sidebar-store';

type SidebarProjectManager = ConstructorParameters<typeof SidebarStore>[0];

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: vi.fn(),
  },
  rpc: {},
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {},
}));

function locationManager(projects: { id: string; createdAt: string }[]): SidebarProjectManager {
  return {
    locations: new Map(projects.map((p) => [p.id, { ...p, mountedLocation: null }])),
  } as unknown as SidebarProjectManager;
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

function projectManagerWithSessions(
  projects: { id: string; createdAt: string; sessionIds: string[] }[]
): SidebarProjectManager {
  return {
    locations: new Map(
      projects.map((project) => [
        project.id,
        {
          id: project.id,
          createdAt: project.createdAt,
          mountedLocation: {
            sessionManager: {
              sessions: new Map(
                project.sessionIds.map((sessionId, index) => [
                  sessionId,
                  session(sessionId, `2026-01-01T00:00:0${index}.000Z`),
                ])
              ),
            },
          },
        },
      ])
    ),
  } as unknown as SidebarProjectManager;
}

describe('SidebarStore project ordering', () => {
  it('sorts projects newest first by default', () => {
    const store = new SidebarStore(
      locationManager([
        { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'new', createdAt: '2026-01-02T00:00:00.000Z' },
      ])
    );

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['new', 'old']);
  });

  it('places projects missing from a saved manual order first', () => {
    const store = new SidebarStore(
      locationManager([
        { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'manual', createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'new', createdAt: '2026-01-03T00:00:00.000Z' },
      ])
    );

    store.setProjectOrder(['manual', 'old']);

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['new', 'manual', 'old']);
  });

  it('returns visible session entries in rendered project-tree order', () => {
    const store = new SidebarStore(
      projectManagerWithSessions([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          sessionIds: ['session-1a', 'session-1b'],
        },
        {
          id: 'project-2',
          createdAt: '2026-01-02T00:00:00.000Z',
          sessionIds: ['session-2a'],
        },
      ])
    );

    store.setProjectOrder(['project-1', 'project-2']);
    store.ensureProjectExpanded('project-1');
    store.ensureProjectExpanded('project-2');
    store.setSessionOrder('project-1', ['session-1a', 'session-1b']);

    expect(store.visibleSessionEntries).toEqual([
      { locationId: 'project-1', sessionId: 'session-1a' },
      { locationId: 'project-1', sessionId: 'session-1b' },
      { locationId: 'project-2', sessionId: 'session-2a' },
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

  it('reveals a session in its room across both layouts', () => {
    const store = new SidebarStore(locationManager([]));
    // Simulate the user having collapsed the room group in each layout.
    store.toggleGroupExpanded(agentRoomGroupKey('project-1', 'room-1'));
    store.toggleGroupExpanded(roomViewGroupKey('room-1'));
    expect(store.isGroupExpanded(agentRoomGroupKey('project-1', 'room-1'))).toBe(false);
    expect(store.isGroupExpanded(roomViewGroupKey('room-1'))).toBe(false);

    store.revealSessionInRoom('project-1', 'room-1');

    expect(store.expandedProjectIds.has('project-1')).toBe(true);
    expect(store.isGroupExpanded(agentRoomGroupKey('project-1', 'room-1'))).toBe(true);
    expect(store.isGroupExpanded(roomViewGroupKey('room-1'))).toBe(true);
  });

  it("returns a project's visible sessions for grouped views", () => {
    const store = new SidebarStore(
      projectManagerWithSessions([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          sessionIds: ['session-1a', 'session-1b'],
        },
      ])
    );

    expect(
      store
        .visibleSessionsForProject('project-1')
        .map((s) => s.data.id)
        .sort()
    ).toEqual(['session-1a', 'session-1b']);
    expect(store.visibleSessionsForProject('missing')).toEqual([]);
  });
});

describe('SidebarStore active-server scoping', () => {
  function linkAgent(locationId: string, serverId: string | null) {
    agentsStore.byProject.set(locationId, [{ locationId, serverId } as Agent]);
  }

  afterEach(() => {
    switchServersStore.activeServerId = null;
    agentsStore.byProject.clear();
  });

  it("shows only the active server's projects", () => {
    const store = new SidebarStore(
      locationManager([
        { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', createdAt: '2026-01-02T00:00:00.000Z' },
      ])
    );
    linkAgent('a', 'server-1');
    linkAgent('b', 'server-2');
    switchServersStore.activeServerId = 'server-1';

    expect(store.orderedProjects.map((p) => p.id)).toEqual(['a']);
    expect(store.isEmpty).toBe(false);
  });

  it('shows all projects when no server is active', () => {
    const store = new SidebarStore(
      locationManager([
        { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', createdAt: '2026-01-02T00:00:00.000Z' },
      ])
    );
    linkAgent('a', 'server-1');
    linkAgent('b', 'server-2');

    expect(store.orderedProjects.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('hides unlinked projects when a server is active', () => {
    const store = new SidebarStore(
      locationManager([{ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' }])
    );
    linkAgent('a', null);
    switchServersStore.activeServerId = 'server-1';

    expect(store.orderedProjects).toEqual([]);
    expect(store.isEmpty).toBe(true);
  });
});

describe('SidebarStore filters', () => {
  type SessionState = 'provisioned' | 'unprovisioned' | 'unregistered';

  function filterProjectManager(
    projects: {
      id: string;
      createdAt: string;
      sessionStates?: SessionState[];
      sshHost?: string | null;
    }[]
  ): SidebarProjectManager {
    return {
      locations: new Map(
        projects.map((project) => [
          project.id,
          {
            id: project.id,
            createdAt: project.createdAt,
            data: {
              id: project.id,
              name: project.id,
              sshHost: project.sshHost ?? null,
              dir: `/repo/${project.id}`,
              createdAt: project.createdAt,
              updatedAt: project.createdAt,
            },
            mountedLocation: project.sessionStates
              ? {
                  sessionManager: {
                    sessions: new Map(
                      project.sessionStates.map((state, index) => {
                        const id = `${project.id}-s${index}`;
                        return [
                          id,
                          {
                            state,
                            data: {
                              id,
                              isPinned: false,
                              createdAt: project.createdAt,
                              updatedAt: project.createdAt,
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
    } as unknown as SidebarProjectManager;
  }

  function linkAgent(locationId: string, fields: { providerId?: Agent['providerId'] }) {
    agentsStore.byProject.set(locationId, [{ locationId, serverId: null, ...fields } as Agent]);
  }

  afterEach(() => {
    agentsStore.byProject.clear();
    switchServersStore.activeServerId = null;
  });

  it('returns all projects unfiltered when no filter is active', () => {
    const store = new SidebarStore(
      filterProjectManager([
        { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', createdAt: '2026-01-02T00:00:00.000Z' },
      ])
    );
    expect(store.hasActiveFilters).toBe(false);
    expect(store.filteredProjects).toEqual(store.orderedProjects);
  });

  it('filters by run location', () => {
    const store = new SidebarStore(
      filterProjectManager([
        { id: 'local-agent', createdAt: '2026-01-01T00:00:00.000Z', sshHost: null },
        { id: 'remote-agent', createdAt: '2026-01-02T00:00:00.000Z', sshHost: 'vm' },
      ])
    );

    store.toggleFilterConnection('remote');
    expect(store.filteredProjects.map((p) => p.id)).toEqual(['remote-agent']);
  });

  it('filters by agent type, OR-ing selections within the dimension', () => {
    const store = new SidebarStore(
      filterProjectManager([
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
    expect(store.filteredProjects.map((p) => p.id).sort()).toEqual([
      'claude-agent',
      'opencode-agent',
    ]);
  });

  it('filters by presence of a running (provisioned) session', () => {
    const store = new SidebarStore(
      filterProjectManager([
        { id: 'running', createdAt: '2026-01-01T00:00:00.000Z', sessionStates: ['provisioned'] },
        { id: 'idle', createdAt: '2026-01-02T00:00:00.000Z', sessionStates: ['unprovisioned'] },
        { id: 'none', createdAt: '2026-01-03T00:00:00.000Z' },
      ])
    );

    store.setFilterHasLiveSession(true);
    expect(store.filteredProjects.map((p) => p.id)).toEqual(['running']);
  });

  it('composes dimensions with AND across, keeping only projects that match all', () => {
    const store = new SidebarStore(
      filterProjectManager([
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
    expect(store.filteredProjects.map((p) => p.id)).toEqual(['remote-running']);
  });

  it('offers only filter values present among in-scope agents', () => {
    const store = new SidebarStore(
      filterProjectManager([
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
    const store = new SidebarStore(filterProjectManager([]));
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
    const store = new SidebarStore(filterProjectManager([]));
    store.toggleFilterConnection('remote');
    store.toggleFilterProviderId('claude');
    store.setFilterHasLiveSession(true);

    const snapshot = store.snapshot;
    expect(snapshot.filterConnections).toEqual(['remote']);
    expect(snapshot.filterProviderIds).toEqual(['claude']);
    expect(snapshot.filterHasLiveSession).toBe(true);

    const restored = new SidebarStore(filterProjectManager([]));
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

describe('SidebarStore grouped-view ordering', () => {
  it('orders top-level room keys by the saved manual room order', () => {
    const store = new SidebarStore(locationManager([]));
    store.setRoomOrder(['room-c', 'room-a']);
    // Saved rooms come first in saved order; unknown rooms append.
    expect(store.orderRoomKeys(['room-a', 'room-b', 'room-c'])).toEqual([
      'room-c',
      'room-a',
      'room-b',
    ]);
  });

  it('orders a sub-group by its saved order, surfacing new sessions first', () => {
    const store = new SidebarStore(locationManager([]));
    const sessions = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
    store.setGroupOrder('as:p1|room-1', ['s2', 's1']);
    expect(store.orderGroupItems('as:p1|room-1', sessions, (s) => s.id, true)).toEqual([
      { id: 's3' },
      { id: 's2' },
      { id: 's1' },
    ]);
  });

  it('round-trips room and group order through the snapshot', () => {
    const store = new SidebarStore(locationManager([]));
    store.setRoomOrder(['room-2', 'room-1']);
    store.setGroupOrder('as:p1|room-1', ['s2', 's1']);

    const snapshot = store.snapshot;
    expect(snapshot.roomOrder).toEqual(['room-2', 'room-1']);
    expect(snapshot.groupOrder).toEqual({ 'as:p1|room-1': ['s2', 's1'] });

    const restored = new SidebarStore(locationManager([]));
    restored.restoreSnapshot(snapshot);
    expect(restored.roomOrder).toEqual(['room-2', 'room-1']);
    expect(restored.groupOrder).toEqual({ 'as:p1|room-1': ['s2', 's1'] });
  });
});

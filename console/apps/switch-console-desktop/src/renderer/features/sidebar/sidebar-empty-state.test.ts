import { expect, it } from 'vitest';
import { showsAgentsAndRooms, sidebarEmptyState } from './sidebar-empty-state';

const empty = {
  grouping: 'agent' as const,
  hasActiveFilters: false,
  filteredLocationCount: 0,
  activeServerId: 'server',
  locationCount: 0,
  roomCount: 0,
  serverListedAgentCount: 0,
};

it('says a server with nothing on it is empty', () => {
  expect(sidebarEmptyState(empty)).toBe('empty');
});

it('does not call a server empty while it lists managed agents', () => {
  expect(sidebarEmptyState({ ...empty, serverListedAgentCount: 1 })).toBeNull();
});

it('does not call a server with local sessions or rooms empty', () => {
  expect(sidebarEmptyState({ ...empty, locationCount: 1 })).toBeNull();
  expect(sidebarEmptyState({ ...empty, roomCount: 1 })).toBeNull();
});

it('says filters matched nothing only in the agent view', () => {
  const filtered = { ...empty, hasActiveFilters: true, locationCount: 2 };
  expect(sidebarEmptyState(filtered)).toBe('no-filter-match');
  expect(sidebarEmptyState({ ...filtered, grouping: 'room' })).toBeNull();
});

it('keeps Agents / Rooms, and so switch-buddy, beside legacy agents while the buddy waits on a provider', () => {
  expect(
    showsAgentsAndRooms({ managedAgentCount: 0, buddyPending: true, legacyAgentCount: 3 })
  ).toBe(true);
  expect(
    showsAgentsAndRooms({ managedAgentCount: 0, buddyPending: false, legacyAgentCount: 3 })
  ).toBe(false);
  expect(
    showsAgentsAndRooms({ managedAgentCount: 0, buddyPending: false, legacyAgentCount: 0 })
  ).toBe(true);
  expect(
    showsAgentsAndRooms({ managedAgentCount: 1, buddyPending: false, legacyAgentCount: 3 })
  ).toBe(true);
});

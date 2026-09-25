import type { SidebarGrouping } from '@shared/view-state';

/**
 * What the sidebar says in place of its tree, if anything.
 *
 * Agent filters narrowing everything away is only an empty *agent* list: the
 * room view lists rooms, which are still there, and reports its own filters
 * being too narrow itself. A server with nothing on it yet otherwise left the
 * panel blank, which reads as the list having failed to load rather than as
 * there being nothing to list; its cloud agents are listed below the tree, so
 * a server that has them is not empty.
 */
export function sidebarEmptyState(input: {
  grouping: SidebarGrouping;
  hasActiveFilters: boolean;
  filteredLocationCount: number;
  activeServerId: string | null;
  locationCount: number;
  roomCount: number;
  cloudAgentCount: number;
}): 'no-filter-match' | 'empty' | null {
  if (input.grouping !== 'room' && input.hasActiveFilters && input.filteredLocationCount === 0)
    return 'no-filter-match';
  if (
    !input.hasActiveFilters &&
    input.activeServerId !== null &&
    input.locationCount === 0 &&
    input.roomCount === 0 &&
    input.cloudAgentCount === 0
  )
    return 'empty';
  return null;
}

import type { QueryClient } from '@tanstack/react-query';
import type { LibraryKind } from '@shared/core/switch-servers/library';

export const libraryItemsKey = (workspaceId: string, kind: LibraryKind) => [
  'library-items',
  workspaceId,
  kind,
];

export const libraryItemKey = (workspaceId: string, kind: LibraryKind, itemId: string) => [
  'library-item',
  workspaceId,
  kind,
  itemId,
];

export const libraryRoomsKey = (workspaceId: string, kind: LibraryKind, itemId: string) => [
  'library-item-rooms',
  workspaceId,
  kind,
  itemId,
];

export const referenceTypesKey = (workspaceId: string) => ['reference-types', workspaceId];

/**
 * Everything that shows library items of a kind reads again after one changes:
 * the Library page, an item's page, and what a room's Attach dialog offers.
 */
export async function invalidateLibrary(
  queryClient: QueryClient,
  workspaceId: string,
  kind: LibraryKind
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['library-items', workspaceId, kind] }),
    queryClient.invalidateQueries({ queryKey: ['library-item', workspaceId, kind] }),
    queryClient.invalidateQueries({ queryKey: ['library-item-rooms', workspaceId, kind] }),
    queryClient.invalidateQueries({ queryKey: ['library', workspaceId, kind] }),
    queryClient.invalidateQueries({ queryKey: ['room-resources', workspaceId] }),
  ]);
}

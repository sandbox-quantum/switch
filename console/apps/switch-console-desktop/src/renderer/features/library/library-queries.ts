import type { QueryClient } from '@tanstack/react-query';
import type { LibraryKind } from '@shared/core/switch-servers/library';

export const libraryItemsKey = (workspaceId: string, kind: LibraryKind) => [
  'library-items',
  workspaceId,
  kind,
];

/** Every item page of a kind, to refresh them all at once. */
export const libraryItemsOfKindKey = (workspaceId: string, kind: LibraryKind) => [
  'library-item',
  workspaceId,
  kind,
];

export const libraryItemKey = (workspaceId: string, kind: LibraryKind, itemId: string) => [
  ...libraryItemsOfKindKey(workspaceId, kind),
  itemId,
];

/** Every room's Resources tab in the workspace (the room-resources panel's keys start so). */
export const roomResourcesInWorkspaceKey = (workspaceId: string) => ['room-resources', workspaceId];

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

/**
 * A library item was deleted: what was read for it is dropped rather than
 * read again (it would only fail), and what lists items reads again.
 */
export async function forgetLibraryItem(
  queryClient: QueryClient,
  workspaceId: string,
  kind: LibraryKind,
  itemId: string
): Promise<void> {
  queryClient.removeQueries({ queryKey: libraryItemKey(workspaceId, kind, itemId), exact: true });
  queryClient.removeQueries({ queryKey: libraryRoomsKey(workspaceId, kind, itemId), exact: true });
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['library-items', workspaceId] }),
    queryClient.invalidateQueries({ queryKey: ['library', workspaceId] }),
    queryClient.invalidateQueries({ queryKey: ['room-resources', workspaceId] }),
  ]);
}

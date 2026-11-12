import type { RoomResource } from '@shared/core/switch-servers/switch-servers';

/**
 * A room's attached items split as the gateway shows them: those from the
 * library, and the documents agents wrote in the room itself.
 */
export function resourcesByOrigin(resources: readonly RoomResource[]): {
  library: RoomResource[];
  roomScoped: RoomResource[];
} {
  return {
    library: resources.filter((resource) => !resource.roomScoped),
    roomScoped: resources.filter((resource) => resource.roomScoped),
  };
}

/**
 * The library's items not attached to the room yet, by name, matching what
 * was typed in their name, type or description.
 */
export function attachableResources(
  library: readonly RoomResource[],
  attached: readonly RoomResource[],
  filter: string
): RoomResource[] {
  const already = new Set(attached.map((resource) => resource.id));
  const query = filter.trim().toLowerCase();
  return library
    .filter((resource) => !already.has(resource.id))
    .filter(
      (resource) =>
        !query ||
        [resource.name, resource.typeLabel ?? '', resource.description].some((text) =>
          text.toLowerCase().includes(query)
        )
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether the viewer may open an attached item's own page in Resources. A
 * room shows everything attached to it to every reader, including an item
 * its owner keeps private, whose page would refuse them. The server says so
 * where it can; otherwise its own rule: owner, admin, or readable by all.
 */
export function opensInResources(
  resource: Pick<RoomResource, 'roomScoped' | 'canRead' | 'ownerId' | 'readVisibility'>,
  viewer: { id: string | null; isAdmin: boolean }
): boolean {
  if (resource.roomScoped) return false;
  if (resource.canRead !== undefined) return resource.canRead;
  return (
    viewer.isAdmin ||
    resource.readVisibility === 'public' ||
    (viewer.id !== null && resource.ownerId === viewer.id)
  );
}

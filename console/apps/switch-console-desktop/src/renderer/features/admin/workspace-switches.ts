import type {
  ConnectionCatalogEntry,
  WorkspaceService,
} from '@shared/core/switch-servers/connection-catalog';

export type SwitchTile = {
  service: WorkspaceService;
  /** The catalog's category; null while the catalog is not read, or lists no such service. */
  category: string | null;
};

/**
 * The workspace's switches as tiles, narrowed by the search, in the server's
 * order. The order never follows the switches' state, so a tile stays where
 * it was when it is flipped. The category comes from the catalog, which the
 * switches' own list does not carry.
 */
export function switchTiles(
  services: WorkspaceService[],
  catalog: ConnectionCatalogEntry[] | undefined,
  query: string
): SwitchTile[] {
  const categories = new Map(catalog?.map((entry) => [entry.slug, entry.category]));
  const needle = query.trim().toLocaleLowerCase();
  return services
    .map((service) => ({ service, category: categories.get(service.slug) ?? null }))
    .filter(
      ({ service, category }) =>
        !needle ||
        [service.name, category ?? ''].some((text) => text.toLocaleLowerCase().includes(needle))
    );
}

/** Who a switch reaches: the members who have connected the service, and the agents using it. */
export function switchStanding(
  service: Pick<WorkspaceService, 'connected_members' | 'granted_agents'>
): string {
  const members = service.connected_members;
  const agents = service.granted_agents;
  if (members === 0 && agents === 0) return 'Nobody has connected it yet';
  const connected = `${members} ${members === 1 ? 'member' : 'members'} connected`;
  const using = `${agents} ${agents === 1 ? 'agent uses' : 'agents use'} it`;
  return `${connected} · ${using}`;
}

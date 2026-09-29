import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';

export function filterConnections(
  connections: ConnectionCatalogEntry[],
  query: string
): ConnectionCatalogEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  const matches = needle
    ? connections.filter(
        (connection) =>
          connection.name.toLocaleLowerCase().includes(needle) ||
          connection.category.toLocaleLowerCase().includes(needle)
      )
    : connections;
  return [...matches].sort((a, b) => Number(b.enabled) - Number(a.enabled));
}

export function connectionMonogram(name: string): string {
  return name
    .split(/[\s-]+/)
    .filter((word) => /^\p{L}/u.test(word))
    .slice(0, 2)
    .map((word) => word[0]?.toLocaleUpperCase())
    .join('');
}

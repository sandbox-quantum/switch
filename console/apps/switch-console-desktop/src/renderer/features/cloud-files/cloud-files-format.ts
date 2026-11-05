import type { CloudFileEntry } from '@shared/core/cloud-files/cloud-files';

/** A box-relative path with one more name on the end. The top level is ''. */
export function childPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** The folder a path sits in; '' for the top level. */
export function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** The folders on the way to `path`, for the breadcrumb: each name with its own path. */
export function pathCrumbs(path: string): { name: string; path: string }[] {
  if (!path) return [];
  const parts = path.split('/');
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }));
}

/** A size in the units people read: B, KB, MB or GB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * When a file changed (`mtime`, epoch milliseconds): the time for today, the
 * day and month for this year, and the full date before that.
 */
export function formatChanged(mtime: number, now: number = Date.now()): string {
  const at = new Date(mtime);
  const today = new Date(now);
  if (at.toDateString() === today.toDateString())
    return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (at.getFullYear() === today.getFullYear())
    return at.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return at.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * A folder's entries in the order shown: folders first, then files, each by
 * name. At the top level, the agents' own folders come before "Shared" and
 * any other shared folder.
 */
export function sortEntries(
  entries: readonly CloudFileEntry[],
  topLevel: boolean
): CloudFileEntry[] {
  const rank = (entry: CloudFileEntry) =>
    entry.kind === 'file' ? 2 : topLevel && entry.agent === undefined ? 1 : 0;
  return [...entries].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true })
  );
}

/** What the tree and list call a folder: its label at the top level, otherwise its name. */
export function entryTitle(entry: CloudFileEntry): string {
  return entry.label ?? entry.name;
}

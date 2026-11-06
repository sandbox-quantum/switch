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

const pad = (n: number) => String(n).padStart(2, '0');

/** `2026-07-02`: the date part of `formatChangedFull`, shown once a change is over a week old. */
function shortDate(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * When a file changed (`mtime`, epoch milliseconds), the same way Switch web
 * says it: `Just now`, `N min ago`, `N hr ago`, `N days ago` up to a week,
 * then the date. Always shown with `formatChangedFull` on hover.
 */
export function formatChanged(mtime: number, now: number = Date.now()): string {
  const at = new Date(mtime);
  const seconds = Math.floor((now - mtime) / 1000);
  if (seconds < 0) return shortDate(at);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days <= 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return shortDate(at);
}

/** The full date and time of a change, for the hover: `2026-07-02 9:23 AM`, as Switch web shows it. */
export function formatChangedFull(mtime: number): string {
  const at = new Date(mtime);
  const hours = at.getHours();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${shortDate(at)} ${hour12}:${pad(at.getMinutes())} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** What a folder shows in the Size column, as Switch web does: a dash, never a blank. */
export const NO_SIZE = '—';

/** The zip button's words: everything at the top level, otherwise the open folder. */
export function zipLabel(path: string): string {
  return path === '' ? 'Download all as zip' : 'Download folder as zip';
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

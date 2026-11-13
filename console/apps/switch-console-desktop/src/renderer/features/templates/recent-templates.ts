import { useCallback, useSyncExternalStore } from 'react';
import { log } from '@renderer/utils/logger';

/**
 * The templates this person last opened on a workspace, newest first. Kept on
 * this computer only: it is a shortcut back, not a record anyone else reads.
 */

const KEPT = 10;

export type RecentScope = { workspaceId: string; userId: string | null };

function storageKey({ workspaceId, userId }: RecentScope): string {
  return `templates.recentlyOpened:${workspaceId}:${userId ?? 'signed-out'}`;
}

/** The list with `id` moved to the front, at most {@link KEPT} long. */
export function withOpened(ids: readonly string[], id: string): string[] {
  return [id, ...ids.filter((other) => other !== id)].slice(0, KEPT);
}

export function parseRecent(raw: string | null): string[] {
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error('not a list of template ids');
  }
  return value;
}

const EMPTY: readonly string[] = [];
const snapshots = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();

function read(key: string): readonly string[] {
  const cached = snapshots.get(key);
  if (cached) return cached;
  let ids: readonly string[] = EMPTY;
  try {
    ids = parseRecent(localStorage.getItem(key));
  } catch (error) {
    log.warn('Recently opened templates could not be read; starting the list afresh', {
      key,
      error,
    });
  }
  snapshots.set(key, ids);
  return ids;
}

export function recordTemplateOpened(scope: RecentScope, templateId: string): void {
  const key = storageKey(scope);
  const next = withOpened(read(key), templateId);
  snapshots.set(key, next);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch (error) {
    log.warn('Recently opened templates could not be saved', { key, error });
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRecentTemplateIds(scope: RecentScope | null): readonly string[] {
  const key = scope ? storageKey(scope) : null;
  const getSnapshot = useCallback(() => (key ? read(key) : EMPTY), [key]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

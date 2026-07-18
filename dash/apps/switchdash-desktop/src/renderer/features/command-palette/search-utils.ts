import type { SearchItem } from '@shared/core/search';

/**
 * Re-ranks FTS5 results by boosting items belonging to the active project.
 * Applied to DB results only — actions are already ordered by context relevance.
 */
export function applyContextAffinity(
  items: SearchItem[],
  context: { locationId?: string }
): SearchItem[] {
  return [...items].sort((a, b) => {
    const boost = (x: SearchItem) =>
      x.locationId === context.locationId && context.locationId != null ? 1 : 0;
    const diff = boost(b) - boost(a);
    // BM25: lower (more negative) is better
    return diff !== 0 ? diff : a.score - b.score;
  });
}

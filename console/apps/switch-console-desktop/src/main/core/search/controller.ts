import { trackEvent } from '@main/core/telemetry/telemetry-service';
import type { CommandPaletteQuery, SearchStatus } from '@shared/core/search';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { searchService } from './search-service';

/**
 * How long after the last keystroke a search counts as finished.
 *
 * The palette searches as you type, on a 100ms debounce — shorter than most
 * people type — so a six-character query runs four or five searches. Reporting
 * each would make this the most frequent event in the catalogue by a wide margin
 * and say nothing the last one does not, which is the high-volume reporting the
 * catalogue is meant to stay clear of.
 */
const SEARCH_SETTLE_MS = 1_000;

let pendingSearch: { status: SearchStatus; count: number } | null = null;
let searchTimer: NodeJS.Timeout | null = null;

/**
 * Report one search per burst of typing: the last one, which is the query the
 * person actually meant and the result they actually saw.
 *
 * The timer is unref'd so a pending report cannot hold the process open at quit,
 * and a burst still in flight when the app closes is simply not reported —
 * losing the tail of a session's searches is a far smaller error than counting
 * every keystroke as a search.
 */
function reportSearch(status: SearchStatus, count: number): void {
  pendingSearch = { status, count };
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const settled = pendingSearch;
    pendingSearch = null;
    searchTimer = null;
    if (settled) {
      trackEvent('search_performed', { status: settled.status, result_count: settled.count });
    }
  }, SEARCH_SETTLE_MS);
  searchTimer.unref?.();
}

export const searchController = createRPCController({
  // The query itself is never reported: what someone types is theirs, and the
  // answerable questions — does search find anything, and how often does it fail
  // outright — are answered by the outcome and the count alone.
  commandPalette: (query: CommandPaletteQuery) => {
    const result = searchService.search(query);
    // Only a search someone actually ran. Opening the palette asks for recents
    // with an empty query, and reporting that would count a search nobody
    // performed — once per open, which would quickly outnumber the real ones.
    if (result.status !== 'recents') {
      reportSearch(result.status, result.items.length);
    }
    return result;
  },
});

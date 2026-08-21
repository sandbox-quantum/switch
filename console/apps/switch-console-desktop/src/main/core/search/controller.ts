import { trackEvent } from '@main/core/telemetry/telemetry-service';
import type { CommandPaletteQuery } from '@shared/core/search';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { searchService } from './search-service';

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
      trackEvent('search_performed', {
        status: result.status,
        result_count: result.items.length,
      });
    }
    return result;
  },
});

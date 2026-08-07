/**
 * Two populations, one item shape.
 *
 * `'session' | 'command' | 'agent'` come from the SQLite FTS index —
 * high-cardinality local content worth indexing.
 *
 * `'room' | 'server' | 'host'` are matched in the renderer against sets it has
 * already loaded. Rooms are not mirrored into SQLite at all (the Switch server
 * owns them); servers and hosts are local tables, but small ones with no
 * lifecycle events, so indexing them would mean inventing change notifications
 * whose only job is to stop the index going stale. Matching a handful of rows
 * in the renderer is always fresh and has nothing to invalidate.
 */
export type SearchItemKind = 'session' | 'command' | 'agent' | 'room' | 'server' | 'host';

export interface SearchItem {
  kind: SearchItemKind;
  id: string;
  locationId: string | null;
  sessionId: string | null;
  title: string;
  subtitle: string;
  score: number;
}

/**
 * Why the accompanying items are what they are. Without this the palette cannot
 * tell a result set from a consolation prize: an empty query, a query too short
 * for the trigram tokenizer, and a query whose search failed outright all used
 * to arrive as a bare array and render identically.
 */
export type SearchStatus =
  /** `items` are matches for the query. */
  | 'ok'
  /** No query was entered; `items` are recents, not matches. */
  | 'recents'
  /** A query was entered but no term survived the tokenizer's 3-char minimum;
   *  `items` are recents and must be labelled as such. */
  | 'query-too-short'
  /** The search itself failed; `items` is empty and that is not "no matches". */
  | 'failed';

export interface SearchResult {
  items: SearchItem[];
  status: SearchStatus;
}

/**
 * Where a term matched, best first. `null` means the text does not contain the
 * term at all.
 *
 * A term matches if it appears **anywhere** in the text, so "dash" finds
 * `switchdash`. That is the recall a substring search is for, and the grade
 * exists to order results rather than to exclude them: an item whose name
 * begins with what you typed should outrank one that merely contains it
 * somewhere in the middle, but both are real answers.
 *
 * Filtering is done by the term being present, not by where — see
 * `search-service`, where the index's own matching is too loose to be trusted
 * as the filter.
 */
export type MatchQuality = 'prefix' | 'word' | 'substring' | null;

/** Characters that separate words for ranking. Covers the shapes names take
 *  here: `reviewer-bot`, `gpu_box`, `switch.local`, `host:port`, paths, URLs. */
const WORD_SEPARATORS = /[\s\-_./:@\\]+/;

/** How well `term` matches `text`: at its start, at the start of a word inside
 *  it, elsewhere inside it, or not at all. */
export function matchQuality(text: string, term: string): MatchQuality {
  const haystack = text.toLowerCase();
  const needle = term.toLowerCase();
  if (!needle) return null;
  if (haystack.startsWith(needle)) return 'prefix';
  if (!haystack.includes(needle)) return null;
  return haystack.split(WORD_SEPARATORS).some((word) => word.startsWith(needle))
    ? 'word'
    : 'substring';
}

export interface CommandPaletteQuery {
  query: string;
  context?: {
    sessionId?: string;
    locationId?: string;
  };
}

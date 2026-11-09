import { ChevronRight, Lock } from 'lucide-react';

/**
 * How a list row says whether it opens: a chevron at the end of one that does,
 * a lock beside the name of one the viewer may not open (an item its owner
 * keeps private, listed because what holds it is shared), whose text is also
 * dimmed. Every list that can show such an item uses these, so they read the
 * same everywhere.
 */

export const LOCKED_ROW_HINT = 'Private to its owner, so you can’t open it.';

/** Beside the name of an item the viewer may not open. */
export function LockedMark() {
  return <Lock role="img" aria-label="Private" className="size-3 shrink-0 text-foreground-muted" />;
}

/** At the end of a row that opens something. */
export function OpensMark() {
  return <ChevronRight aria-hidden className="size-4 shrink-0 text-foreground-passive" />;
}

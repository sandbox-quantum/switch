import type { ReactNode } from 'react';

/**
 * The filter row the list pages share — Rooms, Templates and Connectors — so
 * each puts the same thing in the same place: which slice you are looking at
 * (yours, all) first, then the search filling the width, then whatever
 * narrows it further.
 */
export function ListToolbar({
  scope,
  search,
  filters,
}: {
  /** The scope switch, such as Mine | All rooms. */
  scope?: ReactNode;
  search: ReactNode;
  /** Further filters, after the search. */
  filters?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {scope && <div className="shrink-0">{scope}</div>}
      <div className="min-w-[220px] flex-1">{search}</div>
      {filters && <div className="flex shrink-0 flex-wrap items-center gap-2">{filters}</div>}
    </div>
  );
}

/** The width the list pages share, so moving between them does not reflow the column. */
export const LIST_PAGE_WIDTH = 1000;

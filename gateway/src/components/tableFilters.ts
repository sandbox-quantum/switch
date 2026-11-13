/** The filtering behind `DataTable`'s toolbar, kept apart from the component
 *  so it can be tested without a laid-out grid (jsdom renders no rows). */

/** How a column is filtered from its header menu. */
export interface ColumnFilter<T> {
  /** The value a row holds for this column, or several when a row carries
   *  more than one (an agent in several rooms). Compared as text. */
  value: (row: T) => string | readonly string[];
  /** The values offered, in order, with their labels. Omit it to offer the
   *  distinct values the rows hold, sorted, labelled as themselves. */
  options?: readonly FilterOption[];
}

export interface FilterOption {
  value: string;
  label: string;
}

/** A one-click toolbar shortcut for one value of a filterable column. It sets
 *  the same filter the header menu does, so the two never disagree. */
export interface QuickFilter {
  field: string;
  value: string;
  label: string;
}

/** The values picked per column. A row must match every column with a pick,
 *  and matches a column when it holds any of the values picked there. */
export type FilterSelection = Readonly<Record<string, readonly string[]>>;

export interface FilterableColumn<T> {
  field: string;
  headerName?: string;
  filter?: ColumnFilter<T>;
}

const valuesOf = <T>(filter: ColumnFilter<T>, row: T): readonly string[] => {
  const value = filter.value(row);
  return typeof value === "string" ? [value] : value;
};

/** The options a column's filter menu lists. */
export function filterOptions<T>(column: FilterableColumn<T>, rows: readonly T[]): FilterOption[] {
  const filter = column.filter;
  if (!filter) throw new Error(`column "${column.field}" has no filter`);
  if (filter.options) return [...filter.options];
  const distinct = new Set(rows.flatMap((row) => valuesOf(filter, row)));
  return [...distinct]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((value) => ({ value, label: value }));
}

/** The rows that pass the search and every column's picked values. */
export function applyFilters<T>(
  rows: readonly T[],
  columns: readonly FilterableColumn<T>[],
  selection: FilterSelection,
  query: string,
  searchText: ((row: T) => string) | undefined,
): T[] {
  const active = columns.flatMap((column) => {
    const picked = selection[column.field];
    if (!picked || picked.length === 0) return [];
    if (!column.filter) throw new Error(`a filter is set on column "${column.field}", which has none`);
    return [{ filter: column.filter, picked: new Set(picked) }];
  });
  const needle = query.trim().toLocaleLowerCase();

  return rows.filter((row) => {
    if (needle && searchText && !searchText(row).toLocaleLowerCase().includes(needle)) return false;
    return active.every(({ filter, picked }) => valuesOf(filter, row).some((value) => picked.has(value)));
  });
}

const without = (selection: FilterSelection, field: string): FilterSelection =>
  Object.fromEntries(Object.entries(selection).filter(([key]) => key !== field));

/** `selection` with `value` picked or unpicked on `field`. */
export function toggleValue(selection: FilterSelection, field: string, value: string): FilterSelection {
  const current = selection[field] ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  const rest = without(selection, field);
  return next.length > 0 ? { ...rest, [field]: next } : rest;
}

/** A quick filter is on when its value is the only one picked on its column:
 *  pressing it narrows the column to exactly that value. */
export function isQuickFilterOn(selection: FilterSelection, quick: QuickFilter): boolean {
  const picked = selection[quick.field];
  return picked?.length === 1 && picked[0] === quick.value;
}

/** Pressing a quick filter replaces whatever its column had picked; pressing
 *  it again clears the column. */
export function toggleQuickFilter(selection: FilterSelection, quick: QuickFilter): FilterSelection {
  const rest = without(selection, quick.field);
  return isQuickFilterOn(selection, quick) ? rest : { ...rest, [quick.field]: [quick.value] };
}

/** A dropdown above the table for one filterable column, as the design's
 *  filter row has. It picks one value or every value, and sets the same
 *  filter the header menu does, so the two never disagree. */
export interface SelectFilter {
  field: string;
  /** The dropdown's own label, which may be shorter than the column's. */
  label: string;
  /** What it reads with nothing picked: "All types". */
  allLabel: string;
}

/** What picking from a select filter does: `field` narrowed to `value`
 *  alone, or cleared when `value` is null. */
export function pickOnly(selection: FilterSelection, field: string, value: string | null): FilterSelection {
  const rest = without(selection, field);
  return value === null ? rest : { ...rest, [field]: [value] };
}

/** `selection` without the values no column offers any more. Rows holding
 *  one can go (the parent a table was narrowed to is deleted), and a pick
 *  that matches nothing would hide every row behind a chip naming a value
 *  nobody can see. The same object when nothing is dropped. */
export function pruneSelection<T>(
  selection: FilterSelection,
  columns: readonly FilterableColumn<T>[],
  rows: readonly T[],
): FilterSelection {
  let changed = false;
  const kept: Record<string, readonly string[]> = {};
  for (const [field, picked] of Object.entries(selection)) {
    const column = columns.find((c) => c.field === field && c.filter);
    const offered = column ? new Set(filterOptions(column, rows).map((option) => option.value)) : new Set<string>();
    const still = picked.filter((value) => offered.has(value));
    if (still.length !== picked.length) changed = true;
    if (still.length > 0) kept[field] = still;
  }
  return changed ? kept : selection;
}

/** "12 agents", or "3 of 12 agents" while anything narrows the table. */
export function countLabel(shown: number, total: number, noun: TableNoun, narrowed: boolean): string {
  const word = total === 1 ? noun.one : noun.other;
  return narrowed ? `${shown} of ${total} ${word}` : `${total} ${word}`;
}

export interface TableNoun {
  one: string;
  other: string;
}

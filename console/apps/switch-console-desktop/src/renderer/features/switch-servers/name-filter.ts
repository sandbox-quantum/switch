/** Whether any of a thing's names contains what was typed, ignoring case; everything matches an empty filter. */
export function matchesNameFilter(names: (string | null | undefined)[], filter: string): boolean {
  const query = filter.trim().toLowerCase();
  return query === '' || names.some((name) => name?.toLowerCase().includes(query));
}

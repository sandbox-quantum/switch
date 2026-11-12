/**
 * A reference type's slug, the name stored on every reference of the type.
 * The server takes lowercase letters, digits and underscores, starting with a
 * letter, 2 to 63 long. People are not shown that rule as a pattern: the field
 * writes what it can for them and says, in words, what is still wrong.
 */

export const SLUG_MIN = 2;
export const SLUG_MAX = 63;

/** A slug made from a display name: "Linear issues" becomes "linear_issues". */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, SLUG_MAX)
    .replace(/_+$/, '');
}

/**
 * What typing into the slug field keeps: lower case, and spaces or hyphens as
 * underscores, so the common slips are mended rather than refused. Anything
 * else stays as typed, for {@link slugProblem} to point out.
 */
export function slugAsTyped(value: string): string {
  return value.toLowerCase().replace(/[\s-]/g, '_');
}

/** What is wrong with a slug, in words, or null when the server would take it. */
export function slugProblem(
  slug: string,
  known: { builtin: ReadonlySet<string>; taken: ReadonlySet<string> }
): string | null {
  if (slug.length === 0) return 'Give it a slug.';
  if (/[^a-z0-9_]/.test(slug)) return 'Use only letters, digits and underscores.';
  if (!/^[a-z]/.test(slug)) return 'Start with a letter.';
  if (slug.length < SLUG_MIN) return `At least ${SLUG_MIN} characters.`;
  if (slug.length > SLUG_MAX) return `At most ${SLUG_MAX} characters.`;
  if (known.builtin.has(slug)) return 'Switch already has a built-in type with this slug.';
  if (known.taken.has(slug)) return 'Another type already uses this slug.';
  return null;
}

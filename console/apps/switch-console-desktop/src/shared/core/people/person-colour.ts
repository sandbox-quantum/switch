/**
 * A person's colour, for the disc behind their initials: the same person
 * gets the same colour wherever Console draws them, on every machine.
 *
 * Seeded by the person's Switch user id when it is known, so two people who
 * share a name still look different, and a person keeps their colour when
 * they change their name. A messaging-app username no one has linked has no
 * id; its name is the seed then.
 *
 * Ten colours picked to tell apart at a glance (no two neighbouring hues),
 * each dark enough for white initials, in light mode and dark alike.
 */
const COLOURS = [
  '#c2410c', // orange
  '#b91c1c', // red
  '#be185d', // rose
  '#a21caf', // fuchsia
  '#6d28d9', // violet
  '#1d4ed8', // blue
  '#0e7490', // cyan
  '#0f766e', // teal
  '#15803d', // green
  '#a16207', // ochre
] as const;

export function personColour(seed: string): { backgroundColor: string; color: string } {
  // FNV-1a: small, stable across platforms, and spreads near-identical ids.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return { backgroundColor: COLOURS[(hash >>> 0) % COLOURS.length], color: 'white' };
}

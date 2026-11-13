/**
 * A person's colour, for the disc behind their initials: the same person
 * gets the same colour wherever Console draws them, on every machine.
 *
 * Seeded by the person's Switch user id when it is known, so two people who
 * share a name still look different, and a person keeps their colour when
 * they change their name. A messaging-app username no one has linked has no
 * id; its name is the seed then.
 *
 * The hues are spread round the wheel and drawn at one lightness that white
 * initials read on, in light mode and dark alike.
 */
const HUES = [4, 28, 45, 95, 145, 172, 195, 215, 240, 265, 290, 325] as const;

export function personColour(seed: string): { backgroundColor: string; color: string } {
  // FNV-1a: small, stable across platforms, and spreads near-identical ids.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hue = HUES[(hash >>> 0) % HUES.length];
  return { backgroundColor: `hsl(${hue} 42% 44%)`, color: 'white' };
}

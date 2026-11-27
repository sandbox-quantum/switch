/** The server's record of the template run that created an agent. */
export type BuddyTemplateRecord = { id: string; key: string; revision?: number | null };

/** The template every person's buddy is created from, served by the server. */
export const BUDDY_TEMPLATE_ID = 'official:switch-buddy';

/** The template's key for the buddy among what it creates. */
export const BUDDY_KEY = 'buddy';

const NAME_PREFIX = 'switch-buddy';

/** Agent names are lowercase letters, digits, `.`, `-` and `_`. */
function slug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 40);
}

/**
 * The name a person's buddy is created under: `switch-buddy-<person>`, from
 * their name, else the part of their e-mail before the @. Names are unique per
 * workspace and everyone there gets a buddy, hence the person in it; when even
 * that is taken, a number follows (`switch-buddy-max-2`).
 */
export function buddyAgentName(
  person: { name: string | null; email: string | null },
  taken: ReadonlySet<string>
): string {
  const who = slug(person.name ?? '') || slug(person.email?.split('@')[0] ?? '');
  const base = who ? `${NAME_PREFIX}-${who}` : NAME_PREFIX;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Whether one of the person's own managed agents is their buddy.
 *
 * The server records which template run created an agent: when it says, that
 * decides (the buddy is what switch-buddy's template created as `buddy`, so an
 * agent another template made is never taken for it, whatever its name). An
 * agent with no record, or from a server too old to keep one, is read off its
 * name instead: named as buddies are created (`switch-buddy` or
 * `switch-buddy-<person>`). The list holds only the person's own agents, so
 * another person's buddy is never taken for theirs.
 */
export function isBuddy(agent: { name: string; template?: BuddyTemplateRecord | null }): boolean {
  if (agent.template)
    return agent.template.id === BUDDY_TEMPLATE_ID && agent.template.key === BUDDY_KEY;
  return agent.name === NAME_PREFIX || agent.name.startsWith(`${NAME_PREFIX}-`);
}

/** The person's buddy among their own agents, if they have one. */
export function findBuddy<T extends { name: string; template?: BuddyTemplateRecord | null }>(
  agents: readonly T[] | null | undefined
): T | null {
  return agents?.find(isBuddy) ?? null;
}

/** "notes-helper" -> "Notes Helper": the label a name usually reads as. */
export function labelFromName(name: string): string {
  return name
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Whether a display name is just the agent's name written out, and so should
 * follow the name when it is renamed. Anything else was chosen on purpose and
 * is left as it is — the same rule Switch applies to a rename from chat.
 */
export function labelFollowsName(displayName: string | null, name: string): boolean {
  return displayName !== null && displayName !== '' && displayName === labelFromName(name);
}

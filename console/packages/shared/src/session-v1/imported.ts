import type { Snapshot } from './contract';

/**
 * What a turn's id starts with when the host copied the turn into the
 * transcript from a conversation that began outside Switch, rather than ran
 * it. Such turns are history: they say nothing about whether this session has
 * done anything yet.
 */
export const IMPORTED_TURN_PREFIX = 'imported:';

export function isImportedTurn(turnId: string): boolean {
  return turnId.startsWith(IMPORTED_TURN_PREFIX);
}

/** Whether the session has run anything itself, leaving imported history aside. */
export function hasOwnActivity(snapshot: Pick<Snapshot, 'turns' | 'items'>): boolean {
  return (
    snapshot.turns.some((turn) => !isImportedTurn(turn.turnId)) ||
    snapshot.items.some((item) => !isImportedTurn(item.turnId))
  );
}

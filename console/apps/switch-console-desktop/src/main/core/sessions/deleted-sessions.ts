/**
 * Sessions deleted in this run of Console.
 *
 * Discovery polls the server every couple of seconds and adopts any session it
 * does not hold locally, so a row deleted a moment ago comes straight back
 * until the server reflects that it is finished. Deleting records the id here
 * to close that window.
 *
 * Its own module so the delete path can reach it without importing discovery,
 * which reaches back into the session service to create the rows.
 */
const deleted = new Set<string>();

export function tombstoneSession(sessionId: string): void {
  deleted.add(sessionId);
}

export function sessionWasDeleted(sessionId: string): boolean {
  return deleted.has(sessionId);
}

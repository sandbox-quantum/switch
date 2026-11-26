import { access, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A mark in a session's state root that its host is being stopped on purpose:
 * by its supervisor (the agent stopped or deleted, a new build or definition,
 * a session deleted or restarted), not by the whole box going down. A turn
 * cut off by such a stop owes the room no "I was restarted" line. The host
 * clears it when it next starts.
 */
const STOP_ASKED = 'stop-asked';

export async function markStopAsked(root: string): Promise<void> {
  await writeFile(join(root, STOP_ASKED), `${new Date().toISOString()}\n`).catch(() => {});
}

export async function stopWasAsked(root: string): Promise<boolean> {
  try {
    await access(join(root, STOP_ASKED));
    return true;
  } catch {
    return false;
  }
}

export async function clearStopAsked(root: string): Promise<void> {
  await rm(join(root, STOP_ASKED), { force: true });
}

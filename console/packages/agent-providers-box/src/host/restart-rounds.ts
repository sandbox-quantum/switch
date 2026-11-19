import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * How many rounds of tries each cut-off turn's "I was restarted" line has had
 * and lost, in a session's state root. A line Switch never accepts (the agent
 * left the room, say) stays `pending` in the journal, and every start would
 * wake the session to try again, for ever. After `RESTART_REPLY_ROUNDS`
 * rounds the line is given up on.
 *
 * Kept beside the journal, not in it: the journal's records are parsed
 * strictly, so a new kind of record would stop an earlier build from starting
 * the session after a rollback. An earlier build ignores this file and simply
 * keeps trying, as it always did.
 */
const ROUNDS_FILE = 'restart-reply-rounds.json';

/** Starts' worth of tries (a 2-minute round each) before a line is given up on. */
export const RESTART_REPLY_ROUNDS = 3;

export async function restartReplyRounds(root: string): Promise<Record<string, number>> {
  try {
    const parsed = JSON.parse(await readFile(join(root, ROUNDS_FILE), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isInteger(entry[1]) && entry[1] > 0
      )
    );
  } catch {
    return {};
  }
}

/** Records one more lost round for `turnId`; answers how many it has had now. */
export async function addRestartReplyRound(root: string, turnId: string): Promise<number> {
  const rounds = await restartReplyRounds(root);
  rounds[turnId] = (rounds[turnId] ?? 0) + 1;
  await writeFile(join(root, ROUNDS_FILE), `${JSON.stringify(rounds)}\n`, { mode: 0o600 });
  return rounds[turnId];
}

/** Whether `turnId`'s line has had all its rounds. */
export function restartReplyGivenUp(rounds: Record<string, number>, turnId: string): boolean {
  return (rounds[turnId] ?? 0) >= RESTART_REPLY_ROUNDS;
}

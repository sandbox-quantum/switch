import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completeLines } from '../journal-snapshot';
import { sharedSessionRoot } from '../launch';

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

/**
 * Whether the session's host still owes a room an "I was restarted" line: its
 * inbox records one as `pending` with no `sent` after it. The reconnect
 * restart starts such a session so the line goes out without waiting for the
 * next message.
 */
export async function owesRestartReply(sessionId: string): Promise<boolean> {
  const lines = await completeLines(join(sharedSessionRoot(sessionId), 'inbox.jsonl'));
  if (!lines) return false;
  const state = new Map<string, string>();
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as { type?: string; commandId?: string; state?: string };
      if (record.type === 'restart-reply' && record.commandId && record.state)
        state.set(record.commandId, record.state);
    } catch {
      // A line the host never finished writing: not a record.
    }
  }
  const rounds = await restartReplyRounds(sharedSessionRoot(sessionId));
  return [...state.entries()].some(
    ([turnId, value]) => value === 'pending' && !restartReplyGivenUp(rounds, turnId)
  );
}

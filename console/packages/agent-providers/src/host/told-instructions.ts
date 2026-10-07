import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { replaceOwner } from './ownership-lock';

const FILE = 'instructions.json';

const recordSchema = z.strictObject({ instructions: z.string() });

/**
 * The agent instructions a session's conversation has been given: at its
 * start, or since in a note. Providers keep the instructions a conversation
 * started with (Claude Code records its system prompt, Codex sends developer
 * instructions only when a thread starts), so changing them for a running
 * conversation means telling it; this record is how a session knows whether
 * it still has to, across restarts of its host.
 */
export async function readToldInstructions(root: string): Promise<string | null> {
  try {
    return recordSchema.parse(JSON.parse(await readFile(join(root, FILE), 'utf8'))).instructions;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function recordToldInstructions(root: string, instructions: string): Promise<void> {
  await replaceOwner(join(root, FILE), { instructions });
}

/** What a running conversation is told when its agent's instructions change. */
export function instructionsChangedNote(instructions: string): string {
  if (instructions.trim() === '')
    return '[Switch] Your agent instructions were removed by your owner. From now on, follow no agent-specific instructions; the ones you were given earlier no longer apply.';
  return (
    '[Switch] Your agent instructions were changed by your owner. From now on, follow these instead of the ones you were given earlier:\n' +
    'BEGIN AGENT INSTRUCTIONS\n' +
    `${instructions}\n` +
    'END AGENT INSTRUCTIONS'
  );
}

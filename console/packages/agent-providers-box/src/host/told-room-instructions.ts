import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { replaceOwner } from './ownership-lock';

const FILE = 'room-instructions.json';

const recordSchema = z.strictObject({ rooms: z.record(z.string(), z.string()) });

/**
 * The room instructions a session's conversation has been told, per room, as
 * the text it was told ('' for a room that has none).
 *
 * A room's instructions reach an agent in `connect_to_room`'s answer, but a
 * session its controller started for a room message is placed in the room
 * without that call, and can answer without ever making it. So the host tells
 * the conversation a room's instructions with its first message from the
 * room, and again with the next one after they change. This record is how it
 * knows, across restarts of its host; a fresh conversation starts it empty.
 */
export async function readToldRoomInstructions(root: string): Promise<Record<string, string>> {
  try {
    return recordSchema.parse(JSON.parse(await readFile(join(root, FILE), 'utf8'))).rooms;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function recordToldRoomInstructions(
  root: string,
  rooms: Record<string, string>
): Promise<void> {
  await replaceOwner(join(root, FILE), { rooms });
}

/**
 * What a conversation is told about a room's instructions before a message
 * from it, or null when it already has them. `told` is what it was told for
 * this room before, undefined if nothing.
 */
export function roomInstructionsNote(
  roomId: string,
  instructions: string,
  told: string | undefined
): string | null {
  if (told === instructions) return null;
  if (instructions.trim() === '') {
    if (told === undefined) return null;
    return `[Switch] Room ${roomId}'s instructions were removed. The ones you were given for it earlier no longer apply.`;
  }
  return (
    (told === undefined
      ? `[Switch] Room ${roomId} has instructions of its own. They apply to everything you do in that room, and override general defaults where they differ:\n`
      : `[Switch] Room ${roomId}'s instructions were changed. From now on, follow these there instead of the ones you were given earlier:\n`) +
    'BEGIN ROOM INSTRUCTIONS\n' +
    `${instructions}\n` +
    'END ROOM INSTRUCTIONS'
  );
}

/**
 * The note for a room whose instructions could not be read: the agent is told
 * so, and how to read them itself, rather than answering as if there were none.
 */
export function roomInstructionsUnreadNote(roomId: string, reason: string): string {
  return (
    `[Switch] Room ${roomId}'s instructions could not be read for you (${reason}). ` +
    `Before you reply, call connect_to_room with room_id ${roomId} and include_general_instructions false, and follow the instructions it returns.`
  );
}

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readToldRoomInstructions,
  recordToldRoomInstructions,
  roomInstructionsNote,
  roomInstructionsUnreadNote,
} from './told-room-instructions';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('roomInstructionsNote', () => {
  it('tells a room’s instructions the first time, and nothing for a room without any', () => {
    const note = roomInstructionsNote('room-1', 'Sign every reply.', undefined);
    expect(note).toContain('Room room-1 has instructions of its own');
    expect(note).toContain('BEGIN ROOM INSTRUCTIONS\nSign every reply.\nEND ROOM INSTRUCTIONS');
    expect(roomInstructionsNote('room-1', '', undefined)).toBeNull();
  });

  it('says nothing again until they change, then tells the change or the removal', () => {
    expect(roomInstructionsNote('room-1', 'Sign every reply.', 'Sign every reply.')).toBeNull();
    expect(roomInstructionsNote('room-1', 'Be brief.', 'Sign every reply.')).toContain(
      "Room room-1's instructions were changed"
    );
    expect(roomInstructionsNote('room-1', '  ', 'Sign every reply.')).toContain(
      "Room room-1's instructions were removed"
    );
    expect(roomInstructionsNote('room-1', '', '')).toBeNull();
  });

  it('tells the agent how to read them itself when they could not be read', () => {
    expect(roomInstructionsUnreadNote('room-1', 'Switch is down')).toContain(
      'call connect_to_room with room_id room-1 and include_general_instructions false'
    );
  });
});

it('keeps what each room was told across a restart, and starts empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'told-room-'));
  roots.push(root);
  expect(await readToldRoomInstructions(root)).toEqual({});
  await recordToldRoomInstructions(root, { 'room-1': 'Sign every reply.', 'room-2': '' });
  expect(await readToldRoomInstructions(root)).toEqual({
    'room-1': 'Sign every reply.',
    'room-2': '',
  });
});

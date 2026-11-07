import { expect } from 'vitest';
import { WRITABLE, type FastScenario } from './scenario.ts';

/**
 * Whether a room may see what its agents' tool calls were given and gave back:
 * off for a new room, and switched on and off again by the room's owner, as
 * the server then holds it.
 */
export const toolDetail: FastScenario = {
  header: {
    id: 'tool-detail',
    covers: ['PATCH /gateway/rooms/{room_id}'],
    lane: 'fast',
    environments: WRITABLE,
    owner: 'platform',
    requires: [],
  },
  async run({ fixtures, switchClient }) {
    const agent = await fixtures.agent('detail');
    const room = await fixtures.internalRoom('room', [agent]);

    expect(await switchClient.roomShowsToolDetail(room.id)).toBe(false);
    expect(await switchClient.setRoomToolDetail(room.id, true)).toBe(true);
    expect(await switchClient.roomShowsToolDetail(room.id)).toBe(true);
    expect(await switchClient.setRoomToolDetail(room.id, false)).toBe(false);
    expect(await switchClient.roomShowsToolDetail(room.id)).toBe(false);
  },
};

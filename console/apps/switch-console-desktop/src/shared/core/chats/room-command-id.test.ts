import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { roomCommandId } from './room-command-id';

/** The host's derivation, as `room-prompt.ts` in the agent providers writes it. */
function hostRoomCommandId(agentId: string, roomId: string, messageId: string): string {
  const hex = createHash('sha256')
    .update(`switch-room:${agentId}:${roomId}:${messageId}`)
    .digest('hex')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

describe('roomCommandId', () => {
  it('matches the session host', async () => {
    for (const [agent, room, message] of [
      ['agent-1', 'room-1', 'msg-1'],
      ['a', '!room:example.org', '$event_id'],
    ] as const)
      expect(await roomCommandId(agent, room, message)).toBe(
        hostRoomCommandId(agent, room, message)
      );
  });
});

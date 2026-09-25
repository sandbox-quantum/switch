import { describe, expect, it } from 'vitest';
import { cutoverCommandId, roomCommand, roomCommandId, roomMessageSchema } from './room-prompt';

describe('a room command', () => {
  const event = {
    type: 'message',
    payload: { sender: '@owner:example.test', sender_name: 'Owner', message_id: '$m', body: 'hi' },
  };
  const command = (message: unknown) =>
    roomCommand({
      agentId: 'agent',
      sessionId: 'session',
      epoch: 'epoch',
      roomId: '!room:example.test',
      message: roomMessageSchema.parse(message),
      surface: 'switch-web',
      attachments: [],
    });

  it('is named by the room message it answers', () => {
    expect(command(event).commandId).toBe(roomCommandId('agent', '!room:example.test', '$m'));
  });

  it('is named apart from the live delivery when imported at the cutover', () => {
    const imported = command({ ...event, cutover: true }).commandId;
    expect(imported).toBe(cutoverCommandId('agent', '!room:example.test', '$m'));
    expect(imported).not.toBe(roomCommandId('agent', '!room:example.test', '$m'));
  });
});

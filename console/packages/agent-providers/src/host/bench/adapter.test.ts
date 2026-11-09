import { describe, expect, it } from 'vitest';
import { roomCommand, roomMessageSchema } from '../room-prompt';
import { benchOrigin } from './adapter';

describe('the room message a benchmark turn answers', () => {
  const prompt = (routed: boolean, routedReason: 'decided' | 'fallback' | null = null) => {
    const body = roomCommand({
      agentId: 'agent',
      sessionId: 'session',
      epoch: 'epoch',
      roomId: '!room:example.test',
      message: roomMessageSchema.parse({
        type: 'message',
        payload: {
          sender: '@owner:example.test',
          sender_name: 'Owner',
          message_id: '$m',
          body: 'switch-bench:00000000-0000-4000-8000-000000000001',
          routed,
          routed_reason: routedReason,
        },
      }),
      surface: 'switch-web',
      attachments: [],
      preface: null,
      firstOfConversation: false,
    }).body;
    if (body.type !== 'message.send') throw new Error('not a message');
    return body.text;
  };

  it('is read from an addressed message', () => {
    expect(benchOrigin(prompt(false))).toEqual({ roomId: '!room:example.test', messageId: '$m' });
  });

  it('is read from a message Switch routed to the agent', () => {
    expect(benchOrigin(prompt(true))).toEqual({ roomId: '!room:example.test', messageId: '$m' });
  });

  it("is read from a message delivered to the room's triage agent while auto-route was down", () => {
    expect(benchOrigin(prompt(true, 'fallback'))).toEqual({
      roomId: '!room:example.test',
      messageId: '$m',
    });
  });

  it('is absent from a turn that carries no room message', () => {
    expect(benchOrigin('just a prompt')).toBeNull();
  });
});

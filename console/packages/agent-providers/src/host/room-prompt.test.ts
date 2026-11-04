import { describe, expect, it } from 'vitest';
import { REPLY_REMINDER, roomCommand, roomCommandId, roomMessageSchema } from './room-prompt';

describe('a room command', () => {
  const event = {
    type: 'message',
    payload: {
      sender: '@owner:example.test',
      sender_name: 'Owner',
      steering_actor_id: 'starter',
      message_id: '$m',
      body: 'hi',
    },
  };
  const command = (
    message: unknown,
    firstOfConversation = false,
    steering?: Parameters<typeof roomCommand>[0]['steering']
  ) =>
    roomCommand({
      agentId: 'agent',
      sessionId: 'session',
      epoch: 'epoch',
      roomId: '!room:example.test',
      message: roomMessageSchema.parse(message),
      surface: 'switch-web',
      attachments: [],
      preface: null,
      firstOfConversation,
      steering,
    });
  const text = (message: unknown, first = false) => {
    const body = command(message, first).body;
    if (body.type !== 'message.send') throw new Error('not a message');
    return body.text;
  };

  it.each([
    { name: 'turn starter', expected: 'steer' },
    { name: 'agent owner', sender: '@another:example.test', owner: true, expected: 'steer' },
    { name: 'other sender', sender: '@another:example.test', expected: 'queue' },
    { name: 'other thread', thread: '$other', expected: 'queue' },
    { name: 'always queue', mode: 'queue' as const, expected: 'queue' },
    { name: 'unsupported provider', supported: false, expected: 'queue' },
    { name: 'idle', idle: true, expected: 'queue' },
    { name: 'missing identity', legacy: true, expected: 'queue' },
  ])(
    'routes a room message for $name',
    ({ sender, owner, thread, mode, supported, idle, legacy, expected }) => {
      const first = command({ ...event, payload: { ...event.payload, thread_id: '$thread' } });
      const second = command(
        {
          ...event,
          payload: {
            ...event.payload,
            sender: sender ?? event.payload.sender,
            thread_id: thread ?? '$thread',
            sender_owns_agent: owner,
            steering_actor_id: legacy ? undefined : (sender ?? event.payload.steering_actor_id),
          },
        },
        false,
        { running: idle ? null : first.origin, mode, supported: supported ?? true }
      );
      expect(second.body).toMatchObject({ type: 'message.send', delivery: expected });
    }
  );

  it('matches replies to the root message of the running turn', () => {
    const first = command(event);
    const steering = { supported: true, running: first.origin };
    const root = { ...event, payload: { ...event.payload, message_id: '$second' } };
    const reply = { ...root, payload: { ...root.payload, thread_id: '$m' } };
    expect(command(root, false, steering).body).toMatchObject({ delivery: 'queue' });
    expect(command(reply, false, steering).body).toMatchObject({ delivery: 'steer' });
  });

  it('is named by the room message it answers', () => {
    expect(command(event).commandId).toBe(roomCommandId('agent', '!room:example.test', '$m'));
  });

  it('reminds the agent to reply with post_message, every time', () => {
    expect(text(event).endsWith(REPLY_REMINDER)).toBe(true);
  });

  it('tells the first message of a conversation what the chat opened with', () => {
    const opened = {
      ...event,
      payload: { ...event.payload, opening_message: 'Hi, I am your buddy.' },
    };
    expect(text(opened, true)).toContain('This chat opened with this message');
    expect(text(opened, true)).toContain('Hi, I am your buddy.');
    expect(text(opened, true).indexOf('Hi, I am your buddy.')).toBeLessThan(
      text(opened, true).indexOf('[Switch] Owner addressed you')
    );
    // Later messages are not told again.
    expect(text(opened, false)).not.toContain('Hi, I am your buddy.');
  });

  it('tells what Switch has to say before the message, outside its markers, on every message', () => {
    const noticed = {
      ...event,
      payload: { ...event.payload, switch_notice: 'Your template has a new revision.' },
    };
    for (const first of [true, false]) {
      const said = text(noticed, first);
      expect(said).toContain('[Switch] Your template has a new revision.');
      expect(said.indexOf('Your template has a new revision.')).toBeLessThan(
        said.indexOf('BEGIN SWITCH MESSAGE')
      );
    }
    expect(text(event)).not.toContain('new revision');
  });

  it("says the sender's role in the workspace, as the server read it", () => {
    const fromMember = { ...event, payload: { ...event.payload, sender_role: 'member' } };
    expect(text(fromMember)).toContain('[Switch] Owner (workspace member) addressed you');
    expect(text(event)).toContain('[Switch] Owner addressed you');
  });
});

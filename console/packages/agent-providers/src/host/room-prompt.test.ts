import { describe, expect, it } from 'vitest';
import {
  REPLY_REMINDER,
  roomCommand,
  roomCommandId,
  roomMessageSteerTarget,
  roomMessageSchema,
} from './room-prompt';

describe('a room command', () => {
  const event = {
    type: 'message',
    payload: { sender: '@owner:example.test', sender_name: 'Owner', message_id: '$m', body: 'hi' },
  };
  const command = (message: unknown, firstOfConversation = false) =>
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
    });
  const text = (message: unknown, first = false) => {
    const body = command(message, first).body;
    if (body.type !== 'message.send') throw new Error('not a message');
    return body.text;
  };

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

  it('queues the message unless the caller asks for steering', () => {
    expect(command(event).body).toMatchObject({ delivery: 'queue' });
    const steered = roomCommand({
      agentId: 'agent',
      sessionId: 'session',
      epoch: 'epoch',
      roomId: '!room:example.test',
      message: roomMessageSchema.parse(event),
      surface: 'switch-web',
      attachments: [],
      preface: null,
      firstOfConversation: false,
      delivery: 'steer',
    });
    expect(steered.body).toMatchObject({ delivery: 'steer' });
  });
});

describe('the delivery a room message is sent with', () => {
  const origin = {
    surface: 'switch-web' as const,
    actorId: 'starter',
    roomId: 'room',
    threadId: null,
    messageId: 'root',
  };
  const message = (sender = 'starter', thread = 'root', extra = {}) =>
    roomMessageSchema.parse({
      type: 'message',
      payload: {
        sender,
        sender_name: sender,
        sender_role: 'member',
        message_id: 'reply',
        thread_id: thread,
        body: 'correction',
        ...extra,
      },
    });
  const input = {
    canSteer: true,
    roomId: 'room',
    message: message(),
    turns: [{ turnId: 'running', status: 'running' }],
    items: [{ turnId: 'running', kind: 'user-message', origin }],
  };
  it('steers the starter or owner in the running thread', () => {
    expect(roomMessageSteerTarget(input)).toBe('running');
    expect(
      roomMessageSteerTarget({
        ...input,
        message: message('owner', 'root', { sender_owns_agent: true }),
      })
    ).toBe('running');
  });
  it('steers the current turn when the conversation has imported history', () => {
    expect(
      roomMessageSteerTarget({
        ...input,
        turns: [{ turnId: 'imported', status: 'completed' }, ...input.turns],
        items: [{ turnId: 'imported', kind: 'user-message', origin: null }, ...input.items],
      })
    ).toBe('running');
  });
  it('queues another sender, thread, room, unknown sender, or agent', () => {
    expect(roomMessageSteerTarget({ ...input, message: message('other') })).toBeUndefined();
    expect(
      roomMessageSteerTarget({ ...input, message: message('starter', 'other') })
    ).toBeUndefined();
    expect(roomMessageSteerTarget({ ...input, roomId: 'other' })).toBeUndefined();
    expect(
      roomMessageSteerTarget({
        ...input,
        message: message('starter', 'root', { sender_role: null }),
      })
    ).toBeUndefined();
  });
  it('queues when disabled, unsupported, idle, or origin is unknown', () => {
    expect(
      roomMessageSteerTarget({
        ...input,
        message: message('starter', 'root', { mid_turn_delivery: 'queue' }),
      })
    ).toBeUndefined();
    expect(roomMessageSteerTarget({ ...input, canSteer: false })).toBeUndefined();
    expect(
      roomMessageSteerTarget({ ...input, turns: [{ turnId: 'running', status: 'queued' }] })
    ).toBeUndefined();
    expect(roomMessageSteerTarget({ ...input, items: [] })).toBeUndefined();
  });
});

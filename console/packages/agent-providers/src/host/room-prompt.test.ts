import { describe, expect, it } from 'vitest';
import {
  FALLBACK_NOTE,
  FOLLOW_UP_NOTE,
  REPLY_REMINDER,
  ROUTED_NOTE,
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

  it('reads a workspace owner from a server before the merge as an admin', () => {
    const fromOwner = { ...event, payload: { ...event.payload, sender_role: 'owner' } };
    expect(text(fromOwner)).toContain('[Switch] Owner (workspace admin) addressed you');
  });

  it('says a message was addressed to the agent, and nothing about routing', () => {
    const said = text(event);
    expect(said).toContain(
      '[Switch] Owner addressed you in room !room:example.test (message_id $m, thread_id none):'
    );
    expect(said).not.toContain('without tagging anyone');
    expect(said).not.toContain(ROUTED_NOTE);
  });

  it('says Switch picked the agent for a message nobody tagged, and that it may stay silent', () => {
    const routed = {
      ...event,
      payload: { ...event.payload, routed: true, thread_id: '$root', sender_role: 'member' },
    };
    const said = text(routed);
    expect(said).toContain(
      '[Switch] Owner (workspace member) posted in room !room:example.test without tagging anyone, and Switch picked you to answer (message_id $m, thread_id $root):'
    );
    expect(said).not.toContain('addressed you');
    expect(said).toContain(ROUTED_NOTE);
    expect(ROUTED_NOTE).toContain('stay silent');
    // Told after the message, so the sender's text cannot sit between the two.
    expect(said.indexOf(ROUTED_NOTE)).toBeGreaterThan(said.indexOf('END SWITCH MESSAGE'));
    expect(said.endsWith(REPLY_REMINDER)).toBe(true);
  });

  it('reads a payload without the field as not routed', () => {
    expect(roomMessageSchema.parse(event).payload.routed).toBeUndefined();
    const fromOldServer = { ...event, payload: { ...event.payload, routed: null } };
    expect(text(fromOldServer)).toContain('[Switch] Owner addressed you');
  });

  it('frames a message the decision service picked the same whether or not the reason is given', () => {
    const decided = {
      ...event,
      payload: { ...event.payload, routed: true, routed_reason: 'decided' },
    };
    const said = text(decided);
    expect(said).toContain('without tagging anyone, and Switch picked you to answer');
    expect(said).toContain(ROUTED_NOTE);
    expect(said).not.toContain(FALLBACK_NOTE);
  });

  it("says a fallback came to the agent as the room's triage agent, and that it may stay silent", () => {
    const fallback = {
      ...event,
      payload: { ...event.payload, routed: true, routed_reason: 'fallback' },
    };
    const said = text(fallback);
    expect(said).toContain(
      "[Switch] Owner posted in room !room:example.test without tagging anyone, and auto-route was unavailable, so it came to you as the room's triage agent (message_id $m, thread_id none):"
    );
    expect(said).not.toContain('Switch picked you');
    expect(said).not.toContain(ROUTED_NOTE);
    expect(said).toContain(FALLBACK_NOTE);
    expect(FALLBACK_NOTE).toContain('auto-route was unavailable');
    expect(FALLBACK_NOTE).toContain('stay silent');
    expect(said.indexOf(FALLBACK_NOTE)).toBeGreaterThan(said.indexOf('END SWITCH MESSAGE'));
    expect(said.endsWith(REPLY_REMINDER)).toBe(true);
  });

  it('says why a follow-up came to the agent, and that it may stay silent', () => {
    const cases = [
      [
        'thread_follow_up',
        'you spoke or were tagged in this thread more recently than any other agent',
      ],
      ['channel_follow_up', 'it continues their exchange with you'],
      ['main_agent', "you are this room's assigned agent"],
    ] as const;
    for (const [followUp, why] of cases) {
      const said = text({ ...event, payload: { ...event.payload, follow_up: followUp } });
      expect(said).toContain(
        `[Switch] Owner posted in room !room:example.test without tagging anyone, and it came to you because ${why} (message_id $m, thread_id none):`
      );
      expect(said).not.toContain('addressed you');
      expect(said).toContain(FOLLOW_UP_NOTE);
      expect(said.indexOf(FOLLOW_UP_NOTE)).toBeGreaterThan(said.indexOf('END SWITCH MESSAGE'));
      expect(said.endsWith(REPLY_REMINDER)).toBe(true);
    }
    expect(FOLLOW_UP_NOTE).toContain('stay silent');
  });

  it('reads a follow-up rule it does not know as addressing the agent', () => {
    const unknown = { ...event, payload: { ...event.payload, follow_up: 'something_new' } };
    expect(roomMessageSchema.parse(unknown).payload.follow_up).toBeNull();
    const said = text(unknown);
    expect(said).toContain('[Switch] Owner addressed you');
    expect(said).not.toContain(FOLLOW_UP_NOTE);
  });

  it('reads a routing reason it does not know as Switch’s pick, rather than losing the message', () => {
    const unknown = {
      ...event,
      payload: { ...event.payload, routed: true, routed_reason: 'something_new' },
    };
    const parsed = roomMessageSchema.parse(unknown);
    expect(parsed.payload.routed_reason).toBeNull();
    const said = text(unknown);
    expect(said).toContain('without tagging anyone, and Switch picked you to answer');
    expect(said).toContain(ROUTED_NOTE);
    expect(said).not.toContain(FALLBACK_NOTE);
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
  // Mo started the running turn with a top-level message `root` in a channel.
  const running = {
    turnId: 'running',
    origin: {
      surface: 'switch-web' as const,
      actorId: '@mo-slack:test',
      roomId: 'room',
      threadId: null,
      messageId: 'root',
    },
    steeringActor: 'mo',
  };
  const message = (
    payload: Record<string, unknown> = {},
    channelType: string | null = 'channel_public'
  ) =>
    roomMessageSchema.parse({
      type: 'message',
      channel_type: channelType,
      payload: {
        sender: '@mo-slack:test',
        sender_name: 'mo',
        sender_role: 'member',
        sender_person: 'mo',
        sender_owns_agent: false,
        mid_turn_delivery: 'steer',
        message_id: 'reply',
        thread_id: 'root',
        body: 'no, use the other file',
        ...payload,
      },
    });
  const target = (overrides: Partial<Parameters<typeof roomMessageSteerTarget>[0]> = {}) =>
    roomMessageSteerTarget({
      canSteer: true,
      roomId: 'room',
      message: message(),
      running,
      ...overrides,
    });

  it.each([
    ['a reply in the turn’s thread from its starter', message(), 'running'],
    [
      'the starter writing from another surface, as the same Switch user',
      message({ sender: '@mo-console:test' }),
      'running',
    ],
    [
      'the owner replying in a colleague’s thread',
      message({ sender: '@ana:test', sender_person: 'mo-owner', sender_owns_agent: true }),
      'running',
    ],
    [
      'a new top-level message in the channel',
      message({ thread_id: null, message_id: 'fresh' }),
      undefined,
    ],
    ['a reply in another thread', message({ thread_id: 'other-root' }), undefined],
    [
      'a colleague replying in the thread',
      message({ sender: '@ana:test', sender_person: 'ana' }),
      undefined,
    ],
    [
      'a workspace admin who does not own the agent',
      message({ sender: '@root:test', sender_person: 'boss', sender_role: 'admin' }),
      undefined,
    ],
    [
      'an agent, or a schedule the owner set up (no person)',
      message({ sender_person: null, sender_role: null }),
      undefined,
    ],
    ['an agent set to always queue', message({ mid_turn_delivery: 'queue' }), undefined],
    [
      'a server from before steering, which says nothing of the sender',
      roomMessageSchema.parse({
        type: 'message',
        payload: {
          sender: '@mo-slack:test',
          sender_name: 'mo',
          message_id: 'reply',
          thread_id: 'root',
          body: 'x',
        },
      }),
      undefined,
    ],
    [
      'a follow-up anywhere in a direct room',
      message({ thread_id: null, message_id: 'fresh' }, 'direct'),
      'running',
    ],
  ])('%s', (_name, incoming, expected) => {
    expect(target({ message: incoming })).toBe(expected);
  });

  it('steers a reply in the thread of a turn started by a reply', () => {
    expect(
      target({
        running: { ...running, origin: { ...running.origin, threadId: 'root', messageId: 'r1' } },
      })
    ).toBe('running');
  });

  it('queues when nothing runs, in another room, or on a provider that cannot steer', () => {
    expect(target({ running: null })).toBeUndefined();
    expect(target({ roomId: 'elsewhere' })).toBeUndefined();
    expect(target({ canSteer: false })).toBeUndefined();
  });

  it('never matches a turn whose starter Switch did not identify, except for the owner', () => {
    const anonymous = { ...running, steeringActor: null };
    expect(target({ running: anonymous })).toBeUndefined();
    expect(target({ running: anonymous, message: message({ sender_owns_agent: true }) })).toBe(
      'running'
    );
  });
});

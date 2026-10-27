import { describe, expect, it } from 'vitest';
import {
  FALLBACK_NOTE,
  REPLY_REMINDER,
  ROUTED_NOTE,
  roomCommand,
  roomCommandId,
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
});

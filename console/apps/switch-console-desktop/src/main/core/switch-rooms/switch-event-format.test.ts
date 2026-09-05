import { describe, expect, it } from 'vitest';
import { formatEventForInjection, type AgentBridgeEvent } from './switch-event-format';

const room = 'room-1';

function event(type: string, payload: Record<string, unknown>): AgentBridgeEvent {
  return { type, room_id: room, payload } as unknown as AgentBridgeEvent;
}

describe('formatEventForInjection', () => {
  it('surfaces only message_id for a root-level message', () => {
    const text = formatEventForInjection(
      event('message', { addressed: true, sender_name: 'alice', body: 'ping', message_id: '$m1' })
    );
    expect(text).toBe('[Switch] alice addressed you in room room-1 (message_id $m1): ping');
  });

  it('marks who can read the room when the server says so', () => {
    /**
     * A session reachable in several rooms at once holds a private DM and an
     * open channel in one context, and this line is the only thing on this
     * delivery path that tells the two apart.
     *
     * The label comes from the envelope rather than from `channel_type`: this
     * side cannot see the bridge's type, so it cannot tell an email room from
     * an ordinary DM, and guessing wrong in that direction is the disclosure
     * nobody sees.
     */
    const text = formatEventForInjection(
      {
        ...event('message', {
          addressed: true,
          sender_name: 'alice',
          body: 'ping',
          message_id: '$m1',
        }),
        audience: 'private',
      },
      'Alice'
    );
    expect(text).toBe(
      '[Switch] alice addressed you in room Alice [private] (message_id $m1): ping'
    );
  });

  it('says nothing about the audience when it is not established', () => {
    /** `[unknown]` on every line is noise, not information — the structured MCP
     * meta is where the explicit value lives. This is also what an envelope
     * from a server predating the field produces. */
    const text = formatEventForInjection(
      {
        ...event('message', {
          addressed: true,
          sender_name: 'alice',
          body: 'ping',
          message_id: '$m1',
        }),
      },
      'Engineering'
    );
    expect(text).toBe('[Switch] alice addressed you in room Engineering (message_id $m1): ping');
  });

  it('uses the room name when provided', () => {
    const text = formatEventForInjection(
      event('message', { addressed: true, sender_name: 'alice', body: 'ping', message_id: '$m1' }),
      'Engineering'
    );
    expect(text).toBe('[Switch] alice addressed you in room Engineering (message_id $m1): ping');
  });

  it('surfaces both ids when the message is already in a thread', () => {
    const text = formatEventForInjection(
      event('message', {
        addressed: true,
        sender_name: 'alice',
        body: 'ping',
        message_id: '$m1',
        thread_id: '$thread-1',
      }),
      'Engineering'
    );
    expect(text).toBe(
      '[Switch] alice addressed you in room Engineering (message_id $m1, thread_id $thread-1): ping'
    );
  });

  it('omits thread_id when it is null', () => {
    const text = formatEventForInjection(
      event('message', {
        addressed: true,
        sender_name: 'alice',
        body: 'ping',
        message_id: '$m1',
        thread_id: null,
      })
    );
    expect(text).toBe('[Switch] alice addressed you in room room-1 (message_id $m1): ping');
  });

  it('drops an unaddressed message', () => {
    expect(
      formatEventForInjection(
        event('message', { addressed: false, sender_name: 'alice', body: 'chatter' })
      )
    ).toBeNull();
  });

  it('drops a room_join the agent is not listening for', () => {
    expect(
      formatEventForInjection(event('room_join', { member_name: 'bob', listening: false }))
    ).toBeNull();
  });

  it('surfaces a room_join the agent is listening for', () => {
    expect(
      formatEventForInjection(event('room_join', { member_name: 'bob', listening: true }))
    ).toBe('[Switch] bob joined room room-1');
  });

  it('formats a delegated task', () => {
    expect(
      formatEventForInjection(
        event('task_delegate', { task_id: 't1', summary: 'do X', description: 'details' })
      )
    ).toBe('[Switch] Task delegated to you in room room-1: do X — details');
  });

  it('formats a finalised task with a missing outcome', () => {
    expect(formatEventForInjection(event('task_finalise', { task_id: 't1' }))).toBe(
      '[Switch] Task t1 finalised: (no outcome provided)'
    );
  });

  it('returns null for unknown event types', () => {
    expect(formatEventForInjection(event('mystery', {}))).toBeNull();
  });
});

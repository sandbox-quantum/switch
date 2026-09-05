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

  it('marks who can read the room when the type says so', () => {
    /**
     * A session reachable in several rooms at once holds a private DM and an
     * open channel in one context, and this line is the only thing on this
     * delivery path that tells the two apart.
     */
    const text = formatEventForInjection(
      {
        ...event('message', {
          addressed: true,
          sender_name: 'alice',
          body: 'ping',
          message_id: '$m1',
        }),
        channel_type: 'direct',
      },
      'Alice'
    );
    expect(text).toBe(
      '[Switch] alice addressed you in room Alice [private] (message_id $m1): ping'
    );
  });

  it('says nothing about the audience when the room type does not', () => {
    /** `[unknown]` on every line of every single-room session is noise, not
     * information — the structured MCP meta is where the explicit value lives. */
    const text = formatEventForInjection(
      {
        ...event('message', {
          addressed: true,
          sender_name: 'alice',
          body: 'ping',
          message_id: '$m1',
        }),
        channel_type: null,
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

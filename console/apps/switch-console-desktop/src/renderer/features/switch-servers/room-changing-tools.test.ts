import { describe, expect, it } from 'vitest';
import { changesRooms } from './room-changing-tools';

function row(title: string, status = 'completed', kind = 'tool-activity' as const) {
  return { kind, status, title };
}

describe('changesRooms', () => {
  it('matches a finished room-changing Switch call from each provider', () => {
    expect(changesRooms(row('mcp__switch__create_room'))).toBe(true);
    expect(changesRooms(row('switch.add_users_to_room'))).toBe(true);
    expect(changesRooms(row('switch_invite_agent_to_room'))).toBe(true);
    expect(changesRooms(row('mcp__switch__run_template {"name":"x"}'))).toBe(true);
  });

  it('waits for the call to complete', () => {
    expect(changesRooms(row('mcp__switch__create_room', 'in-progress'))).toBe(false);
    expect(changesRooms(row('mcp__switch__create_room', 'failed'))).toBe(false);
  });

  it('ignores calls that leave rooms as they were', () => {
    expect(changesRooms(row('mcp__switch__post_message'))).toBe(false);
    expect(changesRooms(row('mcp__switch__create_room_document'))).toBe(false);
    expect(changesRooms(row('mcp__other__create_room'))).toBe(false);
    expect(changesRooms(row('create_room'))).toBe(false);
  });

  it('ignores rows that are not tool calls', () => {
    expect(
      changesRooms({ kind: 'assistant-message', status: 'completed', title: 'switch.create_room' })
    ).toBe(false);
  });
});

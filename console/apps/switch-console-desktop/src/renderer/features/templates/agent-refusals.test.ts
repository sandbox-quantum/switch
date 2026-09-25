import { describe, expect, it } from 'vitest';
import type { AgentRefusal } from '@main/core/switch-servers/gateway-client';
import {
  isRecentRefusal,
  RECENT_REFUSAL_MS,
  refusalOperationLabel,
  refusalSummary,
  splitRefusals,
} from './agent-refusals';

const NOW = Date.parse('2026-09-25T12:00:00Z');

function refusal(id: string, createdAt: string): AgentRefusal {
  return {
    id,
    agentId: 'agent-1',
    agentName: 'planner',
    operation: 'run_template',
    reason: 'agent_creation_console_only',
    message: 'This template would create a new agent.',
    subject: 'Triage pair',
    createdAt,
  };
}

describe('refusalOperationLabel', () => {
  it('names the known operations', () => {
    expect(refusalOperationLabel('run_template')).toBe('Run a template');
    expect(refusalOperationLabel('update_template')).toBe('Edit a template');
    expect(refusalOperationLabel('create_room')).toBe('Create a room');
    expect(refusalOperationLabel('create_room_from_yaml')).toBe('Create a room');
  });

  it('reads an unknown operation as its code with spaces', () => {
    expect(refusalOperationLabel('archive_room')).toBe('Archive room');
  });

  it('falls back for an empty operation', () => {
    expect(refusalOperationLabel('')).toBe('A request');
  });
});

describe('isRecentRefusal', () => {
  it('counts the last seven days, the edge included', () => {
    expect(isRecentRefusal(refusal('a', '2026-09-25T11:00:00Z'), NOW)).toBe(true);
    expect(
      isRecentRefusal(refusal('b', new Date(NOW - RECENT_REFUSAL_MS).toISOString()), NOW)
    ).toBe(true);
    expect(
      isRecentRefusal(refusal('c', new Date(NOW - RECENT_REFUSAL_MS - 1000).toISOString()), NOW)
    ).toBe(false);
  });

  it('treats an unreadable time as older', () => {
    expect(isRecentRefusal(refusal('a', 'not a date'), NOW)).toBe(false);
  });
});

describe('splitRefusals', () => {
  it('splits by age and keeps the order', () => {
    const list = [
      refusal('a', '2026-09-25T11:00:00Z'),
      refusal('b', '2026-09-20T11:00:00Z'),
      refusal('c', '2026-09-10T11:00:00Z'),
      refusal('d', '2026-09-01T11:00:00Z'),
    ];
    const { recent, older } = splitRefusals(list, NOW);
    expect(recent.map((r) => r.id)).toEqual(['a', 'b']);
    expect(older.map((r) => r.id)).toEqual(['c', 'd']);
  });
});

describe('refusalSummary', () => {
  it('uses the singular for one', () => {
    expect(refusalSummary(1)).toBe('Your agents were refused 1 request this week');
  });

  it('uses the plural otherwise', () => {
    expect(refusalSummary(3)).toBe('Your agents were refused 3 requests this week');
  });
});

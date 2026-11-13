import { describe, expect, it } from 'vitest';
import { byActivity, roomActivityAt } from './room-order';

type Row = { name: string; activityAt: string; unread: boolean };
const order = (rows: Row[]) => byActivity(rows, (row) => row).map((row) => row.name);

describe('byActivity', () => {
  it('puts the most recently active first', () => {
    expect(
      order([
        { name: 'old', activityAt: '2026-11-01T00:00:00Z', unread: false },
        { name: 'new', activityAt: '2026-11-13T00:00:00Z', unread: false },
        { name: 'never', activityAt: '', unread: false },
      ])
    ).toEqual(['new', 'old', 'never']);
  });

  it('puts rooms with unread messages above the rest, whatever their age', () => {
    expect(
      order([
        { name: 'busy', activityAt: '2026-11-13T00:00:00Z', unread: false },
        { name: 'waiting', activityAt: '2026-11-01T00:00:00Z', unread: true },
      ])
    ).toEqual(['waiting', 'busy']);
  });

  it('falls back to the name for rooms alike', () => {
    expect(
      order([
        { name: 'beta', activityAt: '', unread: false },
        { name: 'alpha', activityAt: '', unread: false },
      ])
    ).toEqual(['alpha', 'beta']);
  });
});

describe('roomActivityAt', () => {
  it('takes a Console room’s newest message over its creation', () => {
    const chat = {
      lastMessage: { seq: 1, sentAt: '2026-11-13T00:00:00Z', preview: '', senderName: '' },
    };
    expect(roomActivityAt(chat, '2026-01-01T00:00:00Z')).toBe('2026-11-13T00:00:00Z');
  });

  it('uses a messaging-app room’s creation, its messages being out of sight', () => {
    expect(roomActivityAt(undefined, '2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00Z');
  });
});

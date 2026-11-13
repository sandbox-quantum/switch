import { describe, expect, it } from 'vitest';
import { byActivity, holdingOpenRoom, roomActivityAt } from './room-order';

type Row = { name: string; activityAt: number; unread: boolean };
const order = (rows: Row[]) => byActivity(rows, (row) => row).map((row) => row.name);
const at = (iso: string) => Date.parse(iso);

describe('byActivity', () => {
  it('puts the most recently active first', () => {
    expect(
      order([
        { name: 'old', activityAt: at('2026-11-01T00:00:00Z'), unread: false },
        { name: 'new', activityAt: at('2026-11-13T00:00:00Z'), unread: false },
        { name: 'never', activityAt: 0, unread: false },
      ])
    ).toEqual(['new', 'old', 'never']);
  });

  it('puts rooms with unread messages above the rest, whatever their age', () => {
    expect(
      order([
        { name: 'busy', activityAt: at('2026-11-13T00:00:00Z'), unread: false },
        { name: 'waiting', activityAt: at('2026-11-01T00:00:00Z'), unread: true },
      ])
    ).toEqual(['waiting', 'busy']);
  });

  it('falls back to the name for rooms alike', () => {
    expect(
      order([
        { name: 'beta', activityAt: 0, unread: false },
        { name: 'alpha', activityAt: 0, unread: false },
      ])
    ).toEqual(['alpha', 'beta']);
  });
});

describe('roomActivityAt', () => {
  const chat = (sentAt: string) => ({
    lastMessage: { seq: 1, sentAt, preview: '', senderName: '' },
  });

  it('takes the newest of what Console saw and what the server reports', () => {
    expect(
      roomActivityAt(chat('2026-11-13T09:00:00Z'), { lastMessageAt: '2026-11-13T10:00:00Z' })
    ).toBe(at('2026-11-13T10:00:00Z'));
    expect(
      roomActivityAt(chat('2026-11-13T11:00:00Z'), { lastMessageAt: '2026-11-13T10:00:00Z' })
    ).toBe(at('2026-11-13T11:00:00Z'));
  });

  it('orders a messaging-app room by its last message, which only the server sees', () => {
    expect(
      roomActivityAt(undefined, {
        createdAt: '2026-01-01T00:00:00Z',
        lastMessageAt: '2026-11-13T10:00:00Z',
      })
    ).toBe(at('2026-11-13T10:00:00Z'));
  });

  it('uses when the room was made only when nothing was said in it', () => {
    expect(roomActivityAt(undefined, { createdAt: '2026-01-01T00:00:00Z' })).toBe(
      at('2026-01-01T00:00:00Z')
    );
  });

  it('compares times, not how they are written', () => {
    // Made late on a day beats a message early that day, whatever the spelling.
    const made = roomActivityAt(undefined, { createdAt: '2026-11-13T17:30:00.000Z' });
    const said = roomActivityAt(chat('2026-11-13T09:00:00+00:00'), null);
    expect(made).toBeGreaterThan(said);
  });
});

describe('holdingOpenRoom', () => {
  const rooms = (...ids: string[]) => ids.map((id) => ({ id }));
  const ids = (list: { id: string }[]) => list.map((room) => room.id);

  it('keeps the open room where it was clicked, though it would now sort elsewhere', () => {
    // Read once opened, `b` would drop below the unread `c`.
    expect(ids(holdingOpenRoom(rooms('c', 'a', 'b'), 'b', 0))).toEqual(['b', 'c', 'a']);
  });

  it('leaves the order alone with no room open, or one that was not on screen', () => {
    expect(ids(holdingOpenRoom(rooms('a', 'b'), null, null))).toEqual(['a', 'b']);
    expect(ids(holdingOpenRoom(rooms('a', 'b'), 'b', null))).toEqual(['a', 'b']);
  });
});

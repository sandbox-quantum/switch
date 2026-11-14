import { describe, expect, it } from 'vitest';
import { appLabel, appsOf, inApp, roomApp, SWITCH_APP } from './room-apps';

const room = (id: string, bridgeType: string | null) => ({ id, bridgeType });

describe('room apps', () => {
  const rooms = [room('a', 'slack'), room('b', null), room('c', 'discord'), room('d', 'slack')];

  it('puts a room on its messaging app, or on Switch when it has none', () => {
    expect(roomApp(rooms[0]!)).toBe('slack');
    expect(roomApp(rooms[1]!)).toBe(SWITCH_APP);
  });

  it('lists each app once, Switch first and the rest by name', () => {
    expect(appsOf(rooms)).toEqual([SWITCH_APP, 'discord', 'slack']);
  });

  it('keeps only the chosen app’s rooms, in their order', () => {
    expect(inApp(rooms, 'slack').map((r) => r.id)).toEqual(['a', 'd']);
    expect(inApp(rooms, SWITCH_APP).map((r) => r.id)).toEqual(['b']);
  });

  it('shows every room for no choice, or one with no rooms left', () => {
    expect(inApp(rooms, null)).toHaveLength(4);
    expect(inApp(rooms, 'teams')).toHaveLength(4);
  });

  it('names an app it has no label for', () => {
    expect(appLabel('slack')).toBe('Slack');
    expect(appLabel('zulip')).toBe('Zulip');
  });
});

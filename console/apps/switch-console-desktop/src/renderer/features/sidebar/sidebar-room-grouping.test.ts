import { describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '@renderer/features/sessions/stores/session-store';

const roomForSession = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: {} }));
vi.mock('@renderer/features/switch-rooms/switch-rooms-store', () => ({
  switchRoomsStore: { roomForSession },
}));
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: { roomNameById: (id: string) => id },
}));

const { groupByRoom } = await import('./sidebar-room-grouping');

function session(id: string): SessionStore {
  return { data: { id } } as SessionStore;
}

describe('groupByRoom', () => {
  it('groups sessions under the room each is connected to', () => {
    roomForSession.mockImplementation((id: string) => (id === 's1' ? 'room-a' : 'room-b'));

    expect(groupByRoom([session('s1'), session('s2')]).map(([key, s]) => [key, s.length])).toEqual([
      ['room-a', 1],
      ['room-b', 1],
    ]);
  });

  it('sinks sessions with no room into the Unassigned bucket, listed last', () => {
    roomForSession.mockImplementation((id: string) => (id === 's1' ? 'room-a' : null));

    const keys = groupByRoom([session('s2'), session('s1')]).map(([key]) => key);
    expect(keys[0]).toBe('room-a');
    expect(keys.at(-1)).not.toBe('room-a');
    expect(keys).toHaveLength(2);
  });

  it('lists an alwaysShow room with no sessions, so a new room is visible before anything joins it', () => {
    roomForSession.mockReturnValue(null);

    expect(groupByRoom([], ['room-new'])).toEqual([['room-new', []]]);
  });

  it('does not duplicate an alwaysShow room that already has sessions', () => {
    roomForSession.mockReturnValue('room-a');

    expect(groupByRoom([session('s1')], ['room-a']).map(([key, s]) => [key, s.length])).toEqual([
      ['room-a', 1],
    ]);
  });
});

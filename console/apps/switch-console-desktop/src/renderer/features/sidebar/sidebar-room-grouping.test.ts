import { describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '@renderer/features/sessions/stores/session-store';

const associatedRoomForSession = vi.hoisted(() => vi.fn());
const sharedRoomsForSession = vi.hoisted(() => vi.fn((_id: string): string[] => []));

vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: {} }));
vi.mock('@renderer/features/switch-rooms/switch-rooms-store', () => ({
  switchRoomsStore: { associatedRoomForSession, sharedRoomsForSession },
}));
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: { roomNameById: (id: string) => id },
}));

const { groupByRoom } = await import('./sidebar-room-grouping');

function session(id: string): SessionStore {
  return { data: { id } } as SessionStore;
}

describe('groupByRoom', () => {
  it('groups sessions under the room each is associated with', () => {
    associatedRoomForSession.mockImplementation((id: string) =>
      id === 's1' ? 'room-a' : 'room-b'
    );

    expect(groupByRoom([session('s1'), session('s2')]).map(([key, s]) => [key, s.length])).toEqual([
      ['room-a', 1],
      ['room-b', 1],
    ]);
  });

  it('sinks sessions with no room into the Unassigned bucket, listed last', () => {
    associatedRoomForSession.mockImplementation((id: string) => (id === 's1' ? 'room-a' : null));

    const keys = groupByRoom([session('s2'), session('s1')]).map(([key]) => key);
    expect(keys[0]).toBe('room-a');
    expect(keys.at(-1)).not.toBe('room-a');
    expect(keys).toHaveLength(2);
  });

  it('lists an alwaysShow room with no sessions, so a new room is visible before anything joins it', () => {
    associatedRoomForSession.mockReturnValue(null);

    expect(groupByRoom([], ['room-new'])).toEqual([['room-new', []]]);
  });

  it('does not duplicate an alwaysShow room that already has sessions', () => {
    associatedRoomForSession.mockReturnValue('room-a');

    expect(groupByRoom([session('s1')], ['room-a']).map(([key, s]) => [key, s.length])).toEqual([
      ['room-a', 1],
    ]);
  });

  it('lists a shared session under its home room and each room it answers from there', () => {
    associatedRoomForSession.mockImplementation((id: string) => (id === 'lead' ? 'home' : 'own'));
    sharedRoomsForSession.mockImplementation((id: string) => (id === 'lead' ? ['work'] : []));

    expect(
      groupByRoom([session('lead'), session('other')]).map(([key, s]) => [
        key,
        s.map((one) => one.data.id),
      ])
    ).toEqual([
      ['home', ['lead']],
      ['own', ['other']],
      ['work', ['lead']],
    ]);
    sharedRoomsForSession.mockImplementation(() => []);
  });

  it('lists a shared session only under its home room where the agent is the subject', () => {
    associatedRoomForSession.mockImplementation(() => 'home');
    sharedRoomsForSession.mockImplementation(() => ['work']);

    expect(groupByRoom([session('lead')], [], { withShares: false }).map(([key]) => key)).toEqual([
      'home',
    ]);
    sharedRoomsForSession.mockImplementation(() => []);
  });
});

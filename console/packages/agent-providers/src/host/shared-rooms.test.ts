import { expect, it, vi } from 'vitest';
import { SharedRooms, sharingFromDetail } from './shared-rooms';

it('reads the home and shared rooms from the agent detail, and nothing from an old server', () => {
  expect(
    sharingFromDetail({
      home_room_id: 'home',
      rooms: [
        { room_id: 'home', shared_session: 'home' },
        { room_id: 'work', shared_session: 'shared' },
        { room_id: 'own', shared_session: null },
      ],
    })
  ).toEqual({ home: 'home', shared: new Set(['home', 'work']) });
  expect(sharingFromDetail({ rooms: [] })).toEqual({ home: null, shared: new Set() });
  expect(sharingFromDetail(null).home).toBeNull();
});

it('names the home room for a shared room only, and reads again once what it read is old', async () => {
  let now = 0;
  const read = vi.fn(async () => ({ home: 'home', shared: new Set(['home', 'work']) }));
  const rooms = new SharedRooms(read, 1000, () => now);
  expect(await rooms.homeFor('work')).toBe('home');
  expect(await rooms.homeFor('home')).toBeNull();
  expect(await rooms.homeFor('own')).toBeNull();
  expect(read).toHaveBeenCalledOnce();
  now = 1000;
  await rooms.homeFor('work');
  expect(read).toHaveBeenCalledTimes(2);
});

it('keeps routing on what it last read when Switch cannot be asked', async () => {
  let now = 0;
  const read = vi
    .fn()
    .mockResolvedValueOnce({ home: 'home', shared: new Set(['home', 'work']) })
    .mockRejectedValueOnce(new Error('down'));
  const rooms = new SharedRooms(read, 10, () => now);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await rooms.homeFor('work')).toBe('home');
  now = 100;
  expect(await rooms.homeFor('work')).toBe('home');
});

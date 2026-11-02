import { expect, it } from 'vitest';
import { postedToRoom } from './room-posts';

it('reads which room a post reached, from the watcher or the server', () => {
  const ok = { content: [] };
  expect(postedToRoom('read_context', ok)).toBeNull();
  expect(postedToRoom('post_message', { ...ok, isError: true })).toBeNull();
  expect(postedToRoom('post_message', ok)).toEqual({});
  expect(postedToRoom('post_message', { ...ok, _meta: { 'switch/room_id': 'a' } })).toEqual({
    roomId: 'a',
  });
  expect(
    postedToRoom('send_targeted_message', { ...ok, structuredContent: { room_id: 'b' } })
  ).toEqual({ roomId: 'b' });
});

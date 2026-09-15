import { expect, it } from 'vitest';
import { boundRoomRefusal } from './bound-room';

it('refuses a bound session a room that is not its own, naming both', () => {
  const refusal = boundRoomRefusal('!other:example.test', '!mine:example.test');
  expect(refusal).toContain('!mine:example.test');
  expect(refusal).toContain('!other:example.test');
  expect(refusal).toContain('one conversation per room');
});

it('allows the room the session is bound to', () => {
  expect(boundRoomRefusal('!mine:example.test', '!mine:example.test')).toBeNull();
  // The host writes the value; tolerate the whitespace an env round-trip adds.
  expect(boundRoomRefusal('!mine:example.test', ' !mine:example.test ')).toBeNull();
});

it('allows any room when no session is bound', () => {
  expect(boundRoomRefusal('!any:example.test', undefined)).toBeNull();
  expect(boundRoomRefusal('!any:example.test', '')).toBeNull();
  expect(boundRoomRefusal('!any:example.test', '   ')).toBeNull();
});

it('leaves a call with no room id to the server to reject', () => {
  expect(boundRoomRefusal(undefined, '!mine:example.test')).toBeNull();
  expect(boundRoomRefusal(42, '!mine:example.test')).toBeNull();
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PLACEMENTS_FILE, SessionPlacements } from './placements';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'placements-'));
  roots.push(made);
  return made;
}

const saved = async (at: string) =>
  JSON.parse(await readFile(join(at, PLACEMENTS_FILE), 'utf8')).placements;

it('keeps one session per room, saying what a move displaced', async () => {
  const at = await root();
  const placements = await SessionPlacements.open(at, () => []);
  expect(await placements.place('one', 'room-a')).toEqual({ previous: null, displaced: null });
  expect(await placements.place('two', 'room-b')).toEqual({ previous: null, displaced: null });
  // Taking a room off another session leaves that session with none.
  expect(await placements.place('two', 'room-a')).toEqual({
    previous: 'room-b',
    displaced: 'one',
  });
  expect(placements.sessionIn('room-a')).toBe('two');
  expect(placements.sessionIn('room-b')).toBeNull();
  expect(placements.roomOf('one')).toBeNull();
  expect(Object.fromEntries(placements.byRoom)).toEqual({ 'room-a': 'two' });
  expect(Object.fromEntries(placements.bySession)).toEqual({ two: 'room-a' });
  // The same move again changes nothing.
  expect(await placements.place('two', 'room-a')).toEqual({ previous: null, displaced: null });
});

it('forgets a room when its session is unplaced or the room is lost, and can be put back', async () => {
  const at = await root();
  const placements = await SessionPlacements.open(at, () => []);
  await placements.place('one', 'room-a');
  await placements.place('two', 'room-b');
  const before = placements.snapshot();
  expect(await placements.unplace('one')).toBe('room-a');
  expect(await placements.unplace('one')).toBeNull();
  expect(await placements.roomLost('room-b')).toBe('two');
  expect(await placements.roomLost('room-b')).toBeNull();
  expect(placements.snapshot()).toEqual({});
  await placements.restore(before);
  expect(placements.snapshot()).toEqual({ one: 'room-a', two: 'room-b' });
  expect(await saved(at)).toEqual({ one: 'room-a', two: 'room-b' });
});

it('writes every change, and a restart reads the last one back rather than the seed', async () => {
  const at = await root();
  const first = await SessionPlacements.open(at, () => [['seeded', 'room-s']]);
  await first.place('one', 'room-a');
  await Promise.all([first.place('two', 'room-b'), first.place('three', 'room-c')]);
  expect(await saved(at)).toEqual({
    seeded: 'room-s',
    one: 'room-a',
    two: 'room-b',
    three: 'room-c',
  });
  const seed = vi.fn(() => [['other', 'room-x']] as [string, string][]);
  const reopened = await SessionPlacements.open(at, seed);
  expect(seed).not.toHaveBeenCalled();
  expect(reopened.snapshot()).toEqual(first.snapshot());
});

it('is seeded once, one room per session, when there is nothing saved yet', async () => {
  const at = await root();
  const placements = await SessionPlacements.open(at, () => [
    ['one', 'room-a'],
    ['two', 'room-a'],
    ['three', 'room-b'],
  ]);
  expect(placements.snapshot()).toEqual({ two: 'room-a', three: 'room-b' });
  expect(await saved(at)).toEqual({ two: 'room-a', three: 'room-b' });
});

it('refuses a saved file that places one room twice, or cannot be read', async () => {
  const at = await root();
  await writeFile(
    join(at, PLACEMENTS_FILE),
    JSON.stringify({ placements: { one: 'room', two: 'room' } })
  );
  await expect(SessionPlacements.open(at, () => [])).rejects.toThrow('two sessions');
  await writeFile(join(at, PLACEMENTS_FILE), 'not json');
  await expect(SessionPlacements.open(at, () => [])).rejects.toThrow('cannot be read');
});

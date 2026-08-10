import { describe, expect, it } from 'vitest';
import {
  AGENTS_CONTAINER,
  makeDndId,
  parseDndId,
  reorderOnDrop,
  ROOMS_CONTAINER,
} from './sidebar-dnd';

describe('sidebar drag ids', () => {
  it('round-trips a container and item id', () => {
    expect(parseDndId(makeDndId(AGENTS_CONTAINER, 'agent-1'))).toEqual({
      containerId: AGENTS_CONTAINER,
      itemId: 'agent-1',
    });
  });

  it('keeps an item id containing the separator intact', () => {
    // Room keys are opaque, so the split must be on the FIRST separator only.
    const id = makeDndId(ROOMS_CONTAINER, 'room~~odd');
    expect(parseDndId(id)).toEqual({ containerId: ROOMS_CONTAINER, itemId: 'room~~odd' });
  });

  it('rejects an id with no separator', () => {
    expect(parseDndId('agents')).toBeNull();
  });
});

describe('reorderOnDrop', () => {
  const ids = ['a', 'b', 'c'];
  const dnd = (itemId: string) => makeDndId(AGENTS_CONTAINER, itemId);

  it('moves the dragged item to the drop position', () => {
    expect(reorderOnDrop(ids, dnd('a'), dnd('c'))).toEqual(['b', 'c', 'a']);
    expect(reorderOnDrop(ids, dnd('c'), dnd('a'))).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op when dropped on itself', () => {
    expect(reorderOnDrop(ids, dnd('b'), dnd('b'))).toBeNull();
  });

  it('refuses a drop into a different container', () => {
    // Agents and rooms are separate lists; a drag may reorder, never re-parent.
    expect(reorderOnDrop(ids, dnd('a'), makeDndId(ROOMS_CONTAINER, 'b'))).toBeNull();
  });

  it('refuses a drop involving an id that is no longer listed', () => {
    expect(reorderOnDrop(ids, dnd('gone'), dnd('b'))).toBeNull();
    expect(reorderOnDrop(ids, dnd('a'), dnd('gone'))).toBeNull();
  });

  it('does not mutate the list it was given', () => {
    const original = [...ids];
    reorderOnDrop(ids, dnd('a'), dnd('c'));
    expect(ids).toEqual(original);
  });
});

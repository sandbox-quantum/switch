import { describe, expect, it } from 'vitest';
import { LocationViewStore } from './location-view';

describe('SessionViewStore range selection', () => {
  it('keeps the non-shift click as the range anchor', () => {
    const store = new LocationViewStore().sessionView;
    const ids = ['1', '2', '3', '4', '5'];

    store.toggleSelect('1');
    store.selectRange(ids, '5');
    store.selectRange(ids, '3');

    expect([...store.selectedIds]).toEqual(['1', '2', '3']);
    expect(store.lastSelectedId).toBe('1');
  });
});

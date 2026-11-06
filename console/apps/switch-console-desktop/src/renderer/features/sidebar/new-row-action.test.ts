import { describe, expect, it } from 'vitest';
import { newRowAction } from './new-row-action';

describe('newRowAction', () => {
  it('makes a room in the room view and a session in the agent view', () => {
    expect(newRowAction(true)).toBe('New Room');
    expect(newRowAction(false)).toBe('New Session');
  });
});

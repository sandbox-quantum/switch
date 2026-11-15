import { describe, expect, it } from 'vitest';
import { matchesNameFilter } from './name-filter';

describe('matchesNameFilter', () => {
  it('matches any name containing the filter, ignoring case and surrounding space', () => {
    expect(matchesNameFilter(['smiley', 'Smiley the helper'], ' HELP ')).toBe(true);
    expect(matchesNameFilter(['porky', null], 'smi')).toBe(false);
    expect(matchesNameFilter(['porky'], '')).toBe(true);
  });
});

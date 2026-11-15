import { describe, expect, it } from 'vitest';
import { parseRecent, withOpened } from './recent-templates';

describe('withOpened', () => {
  it('puts the opened template first, once', () => {
    expect(withOpened(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(withOpened([], 'a')).toEqual(['a']);
  });

  it('keeps the ten most recent', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const next = withOpened(ids, 'new');
    expect(next).toHaveLength(10);
    expect(next[0]).toBe('new');
    expect(next).not.toContain('t9');
  });
});

describe('parseRecent', () => {
  it('reads nothing stored as an empty list', () => {
    expect(parseRecent(null)).toEqual([]);
  });

  it('reads a stored list of ids', () => {
    expect(parseRecent('["a","b"]')).toEqual(['a', 'b']);
  });

  it('refuses anything that is not a list of ids', () => {
    expect(() => parseRecent('{"a":1}')).toThrow();
    expect(() => parseRecent('[1,2]')).toThrow();
    expect(() => parseRecent('not json')).toThrow();
  });
});

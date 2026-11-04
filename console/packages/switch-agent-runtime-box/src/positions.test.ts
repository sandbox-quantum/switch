import { describe, expect, it } from 'vitest';
import { furthest, readPosition } from './positions';

describe('furthest', () => {
  it('takes each source at the further of the two, keeping sources only one has', () => {
    expect(furthest({ s: 5, 'r:a': 2 }, { s: 3, 'r:a': 7, 'r:b': 1 })).toEqual({
      s: 5,
      'r:a': 7,
      'r:b': 1,
    });
  });

  it('lands in the same place whatever order and however often reports arrive', () => {
    const a = { s: 4, 'r:a': 9 };
    const b = { s: 6 };
    const c = { 'r:a': 2, 'r:b': 3 };
    const once = furthest(furthest(a, b), c);
    expect(furthest(furthest(c, a), b)).toEqual(once);
    expect(furthest(once, b)).toEqual(once);
  });
});

describe('readPosition', () => {
  it('reads an object of source to non-negative integer', () => {
    expect(readPosition({ s: 18, 'r:a': 43 })).toEqual({ s: 18, 'r:a': 43 });
  });

  it('refuses anything else', () => {
    for (const raw of [null, 7, 's', [1, 2], { s: -1 }, { s: 1.5 }, { s: '3' }])
      expect(readPosition(raw)).toBeNull();
  });
});

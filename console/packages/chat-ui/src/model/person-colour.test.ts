import { describe, expect, it } from 'vitest';
import { personColour } from './person-colour';

describe('personColour', () => {
  it('gives a person the same colour every time', () => {
    expect(personColour('user-1')).toEqual(personColour('user-1'));
  });

  it('tells apart people who would otherwise look alike', () => {
    const colours = new Set(
      Array.from({ length: 24 }, (_, i) => personColour(`user-${i}`).backgroundColor)
    );
    expect(colours.size).toBeGreaterThan(6);
  });
});

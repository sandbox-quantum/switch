import { describe, expect, it } from 'vitest';
import { introScale } from './intro-scale';

describe('introScale', () => {
  it('plays at full size wherever the stage fits, never larger', () => {
    expect(introScale({ width: 1440, height: 900 })).toBe(1);
    expect(introScale({ width: 2560, height: 1440 })).toBe(1);
  });

  it('shrinks to fit a smaller window, keeping its shape', () => {
    expect(introScale({ width: 720, height: 900 })).toBe(0.5);
    expect(introScale({ width: 1440, height: 450 })).toBe(0.5);
    expect(introScale({ width: 700, height: 500 })).toBeCloseTo(0.486, 3);
  });
});

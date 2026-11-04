import { describe, expect, it } from 'vitest';
import { pickAccent } from '@renderer/utils/pick-accent';

const pixels = (...rgba: number[][]) => new Uint8ClampedArray(rgba.flat());
const many = (count: number, rgba: number[]) => Array.from({ length: count }, () => rgba);

describe('pickAccent', () => {
  it('picks the dominant vivid colour, averaged within its bucket', () => {
    const data = pixels(
      ...many(5, [40, 180, 60, 255]),
      [42, 182, 62, 255],
      ...many(3, [60, 90, 220, 255])
    );
    expect(pickAccent(data)).toEqual([40, 180, 60]);
  });

  it('ignores transparent, grey, near-white and near-black pixels', () => {
    const data = pixels(
      ...many(10, [255, 0, 0, 0]),
      ...many(10, [128, 128, 130, 255]),
      ...many(10, [250, 248, 240, 255]),
      ...many(10, [10, 20, 30, 255]),
      [60, 90, 220, 255]
    );
    expect(pickAccent(data)).toEqual([60, 90, 220]);
  });

  it('has no accent for an image without colour', () => {
    expect(pickAccent(pixels(...many(4, [200, 200, 200, 255])))).toBeNull();
  });
});

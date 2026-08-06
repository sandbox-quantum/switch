import { describe, expect, it } from 'vitest';
import { compareSidecarVersions, sidecarMajor, SIDECAR_VERSION } from './sidecar-version';

const older = (a: string | null, b: string | null) => compareSidecarVersions(a, b) < 0;
const newer = (a: string | null, b: string | null) => compareSidecarVersions(a, b) > 0;
const same = (a: string | null, b: string | null) => compareSidecarVersions(a, b) === 0;

describe('sidecarMajor', () => {
  it('reads the major, treating a missing or unparseable version as 0', () => {
    expect(sidecarMajor('2.4')).toBe(2);
    expect(sidecarMajor(null)).toBe(0);
    expect(sidecarMajor('nonsense')).toBe(0);
  });
});

describe('compareSidecarVersions', () => {
  it('orders by major first', () => {
    expect(older('1.9', '2.0')).toBe(true);
    expect(newer('2.0', '1.9')).toBe(true);
  });

  it('orders by minor within a major', () => {
    expect(older('1.6', '1.7')).toBe(true);
    expect(newer('1.10', '1.9')).toBe(true);
    expect(same('1.7', '1.7')).toBe(true);
  });

  it('treats a missing or unparseable version as the oldest', () => {
    // A sidecar predating the version field reports none, and must never look
    // newer than the client — that would make it un-upgradeable forever.
    expect(older(null, SIDECAR_VERSION)).toBe(true);
    expect(older('nonsense', SIDECAR_VERSION)).toBe(true);
    expect(same(null, '0.0')).toBe(true);
  });

  it('is antisymmetric, so two clients cannot each consider the other newer', () => {
    // The property the shared-host fix rests on: if A does not replace B, B must
    // be free to replace A, or the sidecar can never be upgraded at all.
    for (const [a, b] of [
      ['1.6', '1.7'],
      ['1.7', '1.7'],
      ['2.0', '1.9'],
      [null, '1.0'],
    ] as Array<[string | null, string | null]>) {
      // `|| 0` normalises -0, which `Object.is` distinguishes from 0.
      expect(Math.sign(compareSidecarVersions(a, b)) || 0).toBe(
        -Math.sign(compareSidecarVersions(b, a)) || 0
      );
    }
  });
});

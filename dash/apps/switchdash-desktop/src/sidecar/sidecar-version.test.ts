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

  it('orders by patch within a minor', () => {
    expect(older('1.7.0', '1.7.1')).toBe(true);
    expect(newer('1.7.10', '1.7.9')).toBe(true);
  });

  it('reads a two-part version as patch 0, so 1.7 and 1.7.0 are the same', () => {
    // The property the three-part migration rests on (CHOO-1865). Sidecars
    // deployed before it report `1.7`, and switchdash installs in the field
    // parse only two parts. Both sides must read the pair as equal, or each
    // sees the other as an upgrade and they replace one another forever
    // (CHOO-1937).
    expect(same('1.7', '1.7.0')).toBe(true);
    expect(same('1.7.0', '1.7')).toBe(true);
  });

  it('keeps this release on major 1, so installs in the field still accept it', () => {
    // Every switchdash already out there judges compatibility on the major.
    // Going to 2.0.0 would make all of them treat this sidecar as incompatible
    // and replace it on sight.
    expect(sidecarMajor(SIDECAR_VERSION)).toBe(1);
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

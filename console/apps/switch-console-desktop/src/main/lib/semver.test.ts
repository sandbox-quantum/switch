import { describe, expect, it } from 'vitest';
import { compareVersions, isNewerVersion } from './semver';

describe('compareVersions', () => {
  it('orders releases', () => {
    expect(compareVersions('0.3.0', '0.11.0')).toBe(-1);
    expect(compareVersions('0.11.0', '0.3.0')).toBe(1);
    expect(compareVersions('0.11.0', '0.11.0')).toBe(0);
  });

  it('coerces the decorations real version strings carry', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('switch-core 1.2.3', 'v1.2.4')).toBe(-1);
  });

  it('compares minor and patch numerically, not lexically', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.9', '1.0.10')).toBe(-1);
  });

  it('returns null when either side is not a version', () => {
    expect(compareVersions('latest', '1.2.3')).toBeNull();
    expect(compareVersions('1.2.3', 'main')).toBeNull();
    expect(compareVersions('', '1.2.3')).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('is true only when the candidate is strictly newer', () => {
    expect(isNewerVersion('1.2.3', '1.2.4')).toBe(true);
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.2.4', '1.2.3')).toBe(false);
  });

  it('keeps what it has when the pair is not comparable', () => {
    expect(isNewerVersion('latest', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.2.3', 'latest')).toBe(false);
  });
});

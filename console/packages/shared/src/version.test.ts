import { describe, expect, it } from 'vitest';
import { compareVersions } from './version';

describe('compareVersions', () => {
  it('compares each segment as a number', () => {
    expect(compareVersions('1.19.5', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('2.10.0', '2.9.1')).toBeGreaterThan(0);
  });

  it('counts missing trailing segments as 0', () => {
    expect(compareVersions('18', '18.0.0')).toBe(0);
  });
});

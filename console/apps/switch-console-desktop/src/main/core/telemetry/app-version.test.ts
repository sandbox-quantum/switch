import { describe, expect, it } from 'vitest';
import { appVersionOf } from './app-version';

describe('an app version as a reportable value', () => {
  it('passes a stable and a canary version through', () => {
    expect(appVersionOf('0.40.1')).toBe('0.40.1');
    expect(appVersionOf('0.41.0-canary.3')).toBe('0.41.0-canary.3');
    expect(appVersionOf('1.2.0-canary.rc.1')).toBe('1.2.0-canary.rc.1');
  });

  it('refuses anything that is not a version, so no free text reaches a payload', () => {
    for (const raw of [
      '',
      'latest',
      '0.40',
      '/Users/ada/app',
      '0.40.1 extra',
      '0.40.1-' + 'x'.repeat(40),
    ]) {
      expect(appVersionOf(raw)).toBe('unknown');
    }
  });
});

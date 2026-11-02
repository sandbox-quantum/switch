import { describe, expect, it } from 'vitest';
import { skipsFirstRun } from './feature-flags';

const asked = { VITE_SKIP_FIRST_RUN: '1' };

describe('skipping the first-run pages (test Consoles only)', () => {
  it('skips only in a development run asked to with VITE_SKIP_FIRST_RUN=1', () => {
    expect(skipsFirstRun(true, false, asked)).toBe(true);
  });

  it('never skips outside a development run, whatever the setting', () => {
    expect(skipsFirstRun(false, false, asked)).toBe(false);
  });

  it('never skips in a release build, even one built in development mode', () => {
    expect(skipsFirstRun(true, true, asked)).toBe(false);
    expect(skipsFirstRun(false, true, asked)).toBe(false);
  });

  it('keeps the first-run pages by default, and for any other value', () => {
    expect(skipsFirstRun(true, false, undefined)).toBe(false);
    expect(skipsFirstRun(true, false, {})).toBe(false);
    for (const value of ['0', 'true', 'yes', ''])
      expect(skipsFirstRun(true, false, { VITE_SKIP_FIRST_RUN: value })).toBe(false);
  });
});

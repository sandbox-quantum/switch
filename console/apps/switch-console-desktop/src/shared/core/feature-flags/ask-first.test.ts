import { describe, expect, it } from 'vitest';
import { addsWithoutAsking, flagsAddWithoutAsking } from './ask-first';
import { allFeatureFlagsOff } from './feature-flags';

const state = (over: { fetchedAt?: number | null; error?: string | null; hostedV2?: boolean }) => ({
  fetchedAt: over.fetchedAt ?? null,
  error: over.error ?? null,
  flags: { ...allFeatureFlagsOff(), hosted_v2: over.hostedV2 ?? false },
});

// B38: a machine is added without a click only after a good read that says v2 is off.
describe('addsWithoutAsking', () => {
  it('only after a good read that says hosted_v2 is off', () => {
    expect(addsWithoutAsking(true, false)).toBe(true);
    expect(addsWithoutAsking(true, true)).toBe(false);
    expect(addsWithoutAsking(false, false)).toBe(false);
    expect(addsWithoutAsking(true, null)).toBe(false);
  });
});

describe('flagsAddWithoutAsking', () => {
  it('a good read with v2 off: as upstream', () => {
    expect(flagsAddWithoutAsking(state({ fetchedAt: 1 }))).toBe(true);
  });

  it('a good read with v2 on: asks', () => {
    expect(flagsAddWithoutAsking(state({ fetchedAt: 1, hostedV2: true }))).toBe(false);
  });

  it('a read that failed while signed in (every flag off): asks', () => {
    expect(flagsAddWithoutAsking(state({ error: 'The server did not answer in time.' }))).toBe(
      false
    );
  });

  it('a later read that failed after a good one (old flags kept): asks', () => {
    expect(
      flagsAddWithoutAsking(state({ fetchedAt: 1, error: 'The server did not answer in time.' }))
    ).toBe(false);
  });

  it('never read: asks', () => {
    expect(flagsAddWithoutAsking(state({}))).toBe(false);
  });
});

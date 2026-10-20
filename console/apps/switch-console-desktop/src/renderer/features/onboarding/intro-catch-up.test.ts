import { describe, expect, it } from 'vitest';
import { shouldCatchUpIntro } from './intro-catch-up';

/**
 * An install set up before the intro existed, opening on the workspace after
 * the update — the case the catch-up is for. Each test names only what it
 * changes about it.
 */
function catchUp(differences: Partial<Parameters<typeof shouldCatchUpIntro>[0]>) {
  return shouldCatchUpIntro({
    shape: 'workspace',
    loaded: true,
    installIsEmpty: false,
    onboardingInProgress: false,
    onboardingEnabled: true,
    introSeen: false,
    ...differences,
  });
}

describe('playing the intro over the app for an install onboarded before it', () => {
  it('plays for an install with servers that has never seen it', () => {
    expect(catchUp({})).toBe(true);
  });

  it('does not play again once seen, here or at Welcome', () => {
    expect(catchUp({ introSeen: true })).toBe(false);
  });

  it('leaves a fresh install to see it at Welcome', () => {
    expect(catchUp({ shape: 'onboarding', installIsEmpty: true })).toBe(false);
    // Settings opened from Welcome draws the workspace over an empty install.
    expect(catchUp({ installIsEmpty: true })).toBe(false);
  });

  it('never stands beside a flow in progress, even one stepped out of into Settings', () => {
    expect(catchUp({ shape: 'onboarding', onboardingInProgress: true })).toBe(false);
    expect(catchUp({ onboardingInProgress: true })).toBe(false);
  });

  it('waits for the server list before deciding', () => {
    // Settings can be drawn before the read, when no install looks like it has anything.
    expect(catchUp({ loaded: false })).toBe(false);
    expect(catchUp({ shape: 'loading', loaded: false })).toBe(false);
  });

  it('does not play over a window whose server list failed to load', () => {
    expect(catchUp({ shape: 'failed', loaded: false })).toBe(false);
  });

  it('does not play in a build without the first-run pages', () => {
    expect(catchUp({ onboardingEnabled: false })).toBe(false);
  });
});

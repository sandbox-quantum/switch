import { describe, expect, it } from 'vitest';
import { onboardingStore } from './onboarding-store';

describe('replaying the first-run pages', () => {
  it('keeps the flow on screen from its welcome page', () => {
    onboardingStore.reset();
    expect(onboardingStore.inProgress).toBe(false);

    onboardingStore.rehearse();

    expect(onboardingStore.page).toBe('welcome');
    expect(onboardingStore.inProgress).toBe(true);
  });

  it('survives walking back to the welcome page', () => {
    onboardingStore.rehearse();
    onboardingStore.goTo('whoRuns');
    onboardingStore.goTo('welcome');

    expect(onboardingStore.inProgress).toBe(true);
  });

  it('ends when the flow is finished or left', () => {
    onboardingStore.rehearse();
    onboardingStore.reset();

    expect(onboardingStore.rehearsal).toBe(false);
    expect(onboardingStore.inProgress).toBe(false);
  });
});

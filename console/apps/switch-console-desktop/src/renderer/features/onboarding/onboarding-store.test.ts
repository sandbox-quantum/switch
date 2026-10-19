import { describe, expect, it, vi } from 'vitest';

// The store reads whether the intro has played as it is created; Node has no localStorage.
vi.hoisted(() => {
  const stored = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
    clear: () => stored.clear(),
    key: (index: number) => [...stored.keys()][index] ?? null,
    get length() {
      return stored.size;
    },
  };
});

import { onboardingStore } from './onboarding-store';

describe('the first-run intro', () => {
  it('plays on a fresh install, then not again until the pages are replayed', () => {
    expect(onboardingStore.introPending).toBe(true);
    onboardingStore.introPlayed();
    expect(onboardingStore.introPending).toBe(false);
    expect(localStorage.getItem('onboarding.introPlayed')).not.toBeNull();
    onboardingStore.reset();
    expect(onboardingStore.introPending).toBe(false);
    onboardingStore.rehearse();
    expect(onboardingStore.introPending).toBe(true);
  });
});

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
    onboardingStore.goTo('howToRun');
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

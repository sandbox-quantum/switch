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

import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { onboardingStore, type OnboardingPage } from './onboarding-store';

describe('the first-run intro', () => {
  it('plays on a fresh install, then not again until the pages are replayed', () => {
    expect(onboardingStore.introPending).toBe(true);
    expect(onboardingStore.introSeen).toBe(false);
    onboardingStore.introPlayed();
    expect(onboardingStore.introPending).toBe(false);
    expect(onboardingStore.introSeen).toBe(true);
    expect(localStorage.getItem('onboarding.introPlayed')).not.toBeNull();
    onboardingStore.reset();
    expect(onboardingStore.introPending).toBe(false);
    onboardingStore.rehearse();
    expect(onboardingStore.introPending).toBe(true);
  });

  it('stays seen through a rehearsal, so the app does not offer it again', () => {
    onboardingStore.introPlayed();
    onboardingStore.rehearse();
    onboardingStore.reset();

    expect(onboardingStore.introSeen).toBe(true);
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

const SERVER = {
  id: 'srv-1',
  name: 'switch.example.com',
  url: 'https://switch.example.com',
  dashboardUrl: null,
} as SwitchServer;

/** Press Back until it stops moving, recording each page it lands on. */
function backToTheStart(): OnboardingPage[] {
  const visited: OnboardingPage[] = [];
  for (let i = 0; i < 10; i++) {
    const before = onboardingStore.page;
    const after = onboardingStore.back();
    if (after === before) return visited;
    visited.push(after);
  }
  throw new Error('Back never came to rest');
}

describe('going back through the first-run pages', () => {
  it('walks Switch Cloud back to the welcome page and stays in the flow', () => {
    onboardingStore.reset();
    onboardingStore.goTo('howToRun');
    onboardingStore.connected(SERVER, 'cloud', false);
    onboardingStore.goTo('pickWorkspace');

    expect(backToTheStart()).toEqual(['signIn', 'howToRun', 'welcome']);
    // The Cloud is in the server list by now: a welcome page that was no
    // longer in progress would hand the window to the workspace.
    expect(onboardingStore.inProgress).toBe(true);
    expect(onboardingStore.page).toBe('welcome');
  });

  it('walks a typed-in server back through its address form', () => {
    onboardingStore.reset();
    onboardingStore.goTo('howToRun');
    onboardingStore.goTo('connect');
    onboardingStore.connected(SERVER, 'external', false);
    onboardingStore.goTo('pickWorkspace');

    expect(backToTheStart()).toEqual(['signIn', 'connect', 'howToRun', 'welcome']);
    expect(onboardingStore.inProgress).toBe(true);
  });

  it('walks the stack on this computer back to the question, not to a sign-in it never had', () => {
    onboardingStore.reset();
    onboardingStore.goTo('howToRun');
    onboardingStore.goTo('local');
    onboardingStore.registered('local', SERVER.id);
    onboardingStore.startedLocally(SERVER);

    expect(onboardingStore.page).toBe('pickWorkspace');
    expect(backToTheStart()).toEqual(['howToRun', 'welcome']);
    expect(onboardingStore.inProgress).toBe(true);
  });

  it('goes back from the local setup page to the question', () => {
    onboardingStore.reset();
    onboardingStore.goTo('howToRun');
    onboardingStore.goTo('local');

    expect(backToTheStart()).toEqual(['howToRun', 'welcome']);
    expect(onboardingStore.inProgress).toBe(true);
  });

  it('skips the sign-in page on the way back when the server was already signed in to', () => {
    onboardingStore.reset();
    onboardingStore.goTo('howToRun');
    onboardingStore.connected(SERVER, 'cloud', true);

    expect(onboardingStore.page).toBe('pickWorkspace');
    expect(backToTheStart()).toEqual(['howToRun', 'welcome']);

    onboardingStore.goTo('howToRun');
    onboardingStore.goTo('connect');
    onboardingStore.connected(SERVER, 'external', true);

    expect(backToTheStart()).toEqual(['connect', 'howToRun', 'welcome']);
  });

  it('goes back from the picker drawn in place of switch-buddy the way the picker does', () => {
    onboardingStore.reset();
    onboardingStore.goTo('howToRun');
    onboardingStore.goTo('local');
    onboardingStore.startedLocally(SERVER);
    onboardingStore.goTo('meetBuddy');

    expect(onboardingStore.previousPage).toBe('howToRun');
  });

  it('goes back from creating a workspace only when the picker offered a choice', () => {
    onboardingStore.reset();
    onboardingStore.goTo('howToRun');
    onboardingStore.connected(SERVER, 'external', false);
    onboardingStore.goTo('pickWorkspace');
    onboardingStore.resolved([], 0);
    onboardingStore.goTo('createWorkspace');

    expect(onboardingStore.previousPage).toBeNull();
    expect(onboardingStore.back()).toBe('createWorkspace');

    onboardingStore.resolved([], 1);
    expect(onboardingStore.back()).toBe('pickWorkspace');
  });

  it('stays on the welcome page, and forgets the attempt, when Back is pressed there', () => {
    onboardingStore.reset();
    onboardingStore.goTo('howToRun');
    onboardingStore.connected(SERVER, 'cloud', false);
    backToTheStart();

    expect(onboardingStore.back()).toBe('welcome');
    expect(onboardingStore.server).toBeNull();
    expect(onboardingStore.signInSkipped).toBe(false);
  });

  it('is not in progress on a welcome page nobody has left yet', () => {
    onboardingStore.reset();
    expect(onboardingStore.back()).toBe('welcome');
    expect(onboardingStore.inProgress).toBe(false);
  });
});

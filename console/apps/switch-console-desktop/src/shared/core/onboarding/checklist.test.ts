import { describe, expect, it } from 'vitest';
import {
  anyProviderConnected,
  countCompletedSteps,
  deriveOnboardingSteps,
  EMPTY_ONBOARDING_PROGRESS,
  isOnboardingComplete,
  type OnboardingProgress,
} from './checklist';

function progress(overrides: Partial<OnboardingProgress> = {}): OnboardingProgress {
  return { ...EMPTY_ONBOARDING_PROGRESS, ...overrides };
}

describe('deriveOnboardingSteps', () => {
  it('makes the first step active on a fresh install', () => {
    const steps = deriveOnboardingSteps(progress());
    expect(steps.map((s) => s.status)).toEqual(['active', 'upcoming', 'upcoming', 'upcoming']);
  });

  it('advances the active step as earlier ones complete', () => {
    const steps = deriveOnboardingSteps(progress({ addServer: true }));
    expect(steps.map((s) => s.status)).toEqual(['done', 'active', 'upcoming', 'upcoming']);
  });

  it('marks a step done even when an earlier one is not', () => {
    // Someone who already had Claude Code installed satisfies the provider step
    // before they ever add a server. Showing it as pending would be a lie.
    const steps = deriveOnboardingSteps(progress({ agentProviders: true }));
    expect(steps.map((s) => s.status)).toEqual(['active', 'done', 'upcoming', 'upcoming']);
  });

  it('leaves no step active once everything is done', () => {
    const steps = deriveOnboardingSteps(
      progress({
        addServer: true,
        agentProviders: true,
        onboardAgents: true,
        createRoom: true,
      })
    );
    expect(steps.every((s) => s.status === 'done')).toBe(true);
  });

  it('keeps the steps in their declared order with their labels', () => {
    const steps = deriveOnboardingSteps(progress());
    expect(steps.map((s) => s.id)).toEqual([
      'addServer',
      'agentProviders',
      'onboardAgents',
      'createRoom',
    ]);
    expect(steps.map((s) => s.label)).toEqual([
      'Add a server',
      'Set up agent providers',
      'Onboard your agents',
      'Create a room',
    ]);
  });

  it('reverts to active when the thing a step produced is removed', () => {
    const done = deriveOnboardingSteps(progress({ addServer: true, agentProviders: true }));
    expect(done[0].status).toBe('done');

    const serverDeleted = deriveOnboardingSteps(progress({ agentProviders: true }));
    expect(serverDeleted[0].status).toBe('active');
  });
});

describe('isOnboardingComplete', () => {
  it('is false while any step is unmet', () => {
    expect(isOnboardingComplete(progress())).toBe(false);
    expect(
      isOnboardingComplete(
        progress({
          addServer: true,
          agentProviders: true,
          onboardAgents: true,
        })
      )
    ).toBe(false);
  });

  it('is true only when every step is met', () => {
    expect(
      isOnboardingComplete(
        progress({
          addServer: true,
          agentProviders: true,
          onboardAgents: true,
          createRoom: true,
        })
      )
    ).toBe(true);
  });
});

describe('countCompletedSteps', () => {
  it('counts met steps regardless of order', () => {
    expect(countCompletedSteps(progress())).toBe(0);
    expect(countCompletedSteps(progress({ agentProviders: true, createRoom: true }))).toBe(2);
  });
});

describe('anyProviderConnected', () => {
  const signedIn = { installed: true, status: 'authenticated' };
  const verified = {
    status: 'connected',
    kind: 'api-key',
    verified_at: '2026-01-01T00:00:00Z',
  } as const;
  const pending = {
    kind: 'api-key',
    verification_id: 'v-1',
    created_at: '2026-01-01T00:00:00Z',
    error: null,
  } as const;

  it('is false with nothing answered yet', () => {
    expect(anyProviderConnected([undefined], [undefined])).toBe(false);
    expect(anyProviderConnected([], [])).toBe(false);
  });

  it('does not count an installed CLI nobody has signed in to', () => {
    expect(anyProviderConnected([{ installed: true, status: 'unauthenticated' }], [])).toBe(false);
    expect(anyProviderConnected([{ installed: true, status: 'unknown' }], [])).toBe(false);
  });

  it('does not count a sign-in whose CLI is not installed', () => {
    expect(anyProviderConnected([{ installed: false, status: 'authenticated' }], [])).toBe(false);
  });

  it('counts a provider signed in on this computer', () => {
    expect(anyProviderConnected([undefined, signedIn], [])).toBe(true);
  });

  it('counts a provider connected on Switch Cloud', () => {
    expect(anyProviderConnected([], [{ status: 'not_connected' }, verified])).toBe(true);
    expect(anyProviderConnected([], [{ ...verified, status: 'configured' }])).toBe(true);
  });

  it('does not count a cloud credential still being checked or one that failed', () => {
    expect(anyProviderConnected([], [{ ...pending, status: 'verifying' }])).toBe(false);
    expect(anyProviderConnected([], [{ ...pending, status: 'failed', error: 'rejected' }])).toBe(
      false
    );
  });
});

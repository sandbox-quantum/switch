import { describe, expect, it } from 'vitest';
import type {
  HostSetupPlan,
  HostSetupStep,
  HostSetupStepState,
} from '@shared/core/remote-hosts/setup';
import { SettledStepTracker } from './settled-steps';

function step(id: string, state: HostSetupStepState, version: string | null = null): HostSetupStep {
  return {
    id,
    kind: id === 'node' ? 'core-dependency' : 'agent-cli',
    name: id,
    state,
    outcome: state === 'satisfied' ? 'satisfied' : state === 'pending' ? 'missing' : null,
    version,
    latestVersion: null,
    updateAvailable: false,
    error: null,
    output: null,
    optional: false,
    dependsOn: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function plan(sshHost: string, steps: HostSetupStep[]): HostSetupPlan {
  return {
    sshHost,
    status: 'idle',
    steps,
    currentStepId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('SettledStepTracker', () => {
  it('counts the first plan seen for a host, since nothing was known before it', () => {
    const tracker = new SettledStepTracker();

    expect(tracker.changed(plan('box', [step('node', 'satisfied', '22.0.0')]))).toBe(true);
  });

  it('counts an install that finished with the CLI in place', () => {
    const tracker = new SettledStepTracker();
    tracker.changed(plan('box', [step('claude', 'pending')]));

    expect(tracker.changed(plan('box', [step('claude', 'installing')]))).toBe(false);
    expect(tracker.changed(plan('box', [step('claude', 'satisfied', '2.1.0')]))).toBe(true);
  });

  it('ignores a re-check that found what was already known', () => {
    const tracker = new SettledStepTracker();
    const settled = [step('node', 'satisfied', '22.0.0'), step('claude', 'satisfied', '2.1.0')];
    tracker.changed(plan('box', settled));

    expect(tracker.changed(plan('box', [step('node', 'checking'), settled[1]!]))).toBe(false);
    expect(tracker.changed(plan('box', settled))).toBe(false);
  });

  it('counts a new version as a change', () => {
    const tracker = new SettledStepTracker();
    tracker.changed(plan('box', [step('claude', 'satisfied', '2.1.0')]));

    expect(tracker.changed(plan('box', [step('claude', 'satisfied', '2.2.0')]))).toBe(true);
  });

  it('keeps each host apart', () => {
    const tracker = new SettledStepTracker();
    tracker.changed(plan('box', [step('claude', 'satisfied', '2.1.0')]));

    expect(tracker.changed(plan('other-box', [step('claude', 'satisfied', '2.1.0')]))).toBe(true);
    expect(tracker.changed(plan('box', [step('claude', 'satisfied', '2.1.0')]))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { ParamSpec } from '@main/core/room-templates/controller';
import { agentCreateSteps, bridgeCandidates, prefillChoice } from './use-template-model';

function param(overrides: Partial<ParamSpec>): ParamSpec {
  return {
    name: 'p',
    type: 'string',
    description: null,
    default: null,
    enum: null,
    multiline: false,
    prefill: null,
    ...overrides,
  };
}

describe('bridgeCandidates', () => {
  it('puts the default app first, then the rest by name, and leaves out stopped ones', () => {
    expect(
      bridgeCandidates([
        { displayName: 'Teams', status: 'active', isDefault: false },
        { displayName: 'Slack', status: 'active', isDefault: true },
        { displayName: 'Discord', status: 'stopped', isDefault: false },
        { displayName: 'Mattermost', status: 'active', isDefault: false },
      ])
    ).toEqual(['Slack', 'Mattermost', 'Teams']);
  });
});

describe('prefillChoice', () => {
  it('selects the first candidate when the template asks for it', () => {
    expect(prefillChoice(param({ type: 'room', prefill: 'first' }), ['a', 'b'])).toBe('a');
  });

  it('selects the only messaging app without being asked', () => {
    expect(prefillChoice(param({ type: 'bridge' }), ['Slack'])).toBe('Slack');
    expect(prefillChoice(param({ type: 'bridge' }), ['Slack', 'Teams'])).toBeNull();
  });

  it('never selects the only agent without being asked', () => {
    expect(prefillChoice(param({ type: 'agent' }), ['helper'])).toBeNull();
  });

  it('leaves a param with a default, or with nothing to choose from, alone', () => {
    expect(
      prefillChoice(param({ type: 'bridge', prefill: 'first', default: 'Teams' }), ['Slack'])
    ).toBeNull();
    expect(prefillChoice(param({ type: 'bridge', prefill: 'first' }), [])).toBeNull();
  });
});

describe('agentCreateSteps', () => {
  const agent = {
    name: 'helper',
    clones: true,
    setsPolicy: true,
    cloneWarning: null,
  };

  it('marks the rows before the call in progress done and the ones after it waiting', () => {
    const steps = agentCreateSteps(0, { ...agent, status: 'creating', step: 'create' });
    expect(steps.map((s) => s.status)).toEqual(['done', 'running', 'waiting']);
  });

  it('fails the row of the call that failed, and keeps the agent row done', () => {
    const steps = agentCreateSteps(0, { ...agent, status: 'failed', step: 'policy' });
    expect(steps.map((s) => s.status)).toEqual(['done', 'done', 'failed']);
  });

  it('has no policy row for a template that leaves addressing alone', () => {
    const steps = agentCreateSteps(1, { ...agent, setsPolicy: false, status: 'idle', step: null });
    expect(steps.map((s) => s.key)).toEqual(['1:prepare', '1:create']);
  });

  it('carries a failed clone as a warning on the directory row', () => {
    const steps = agentCreateSteps(0, {
      ...agent,
      status: 'created',
      step: 'policy',
      cloneWarning: 'no network',
    });
    expect(steps[0]).toMatchObject({ status: 'done', warning: 'no network' });
  });
});

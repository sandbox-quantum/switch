import { describe, expect, it } from 'vitest';
import type { ParamSpec } from '@main/core/room-templates/controller';
import {
  agentCreateSteps,
  bridgeCandidates,
  paramLabel,
  resolveChain,
  sectionOf,
  serverInputs,
  valueProblem,
} from './use-template-model';

function param(overrides: Partial<ParamSpec>): ParamSpec {
  return {
    name: 'p',
    type: 'string',
    description: null,
    label: null,
    default: null,
    required: true,
    input: 'ask',
    enum: null,
    multiline: false,
    pattern: null,
    min: null,
    max: null,
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

describe('resolveChain', () => {
  it('takes the first candidate the server has, in the order the template wrote', () => {
    const p = param({ type: 'bridge', default: ['Teams', 'Mattermost', '$first'] });
    expect(resolveChain(p, ['Slack', 'Mattermost'])).toBe('Mattermost');
    expect(resolveChain(p, ['Slack'])).toBe('Slack');
    expect(resolveChain(p, [])).toBeNull();
  });

  it('resolves $new only for a room param when the template describes a room', () => {
    const p = param({ type: 'room', default: ['$new'] });
    expect(resolveChain(p, ['lobby'], true)).toBe('$new');
    expect(resolveChain(p, ['lobby'], false)).toBeNull();
    expect(resolveChain(param({ type: 'bridge', default: ['$new'] }), ['Slack'])).toBeNull();
  });

  it('is null for a plain default', () => {
    expect(resolveChain(param({ type: 'bridge', default: 'Slack' }), ['Slack'])).toBeNull();
  });
});

describe('valueProblem', () => {
  it('checks a string against its pattern as a whole', () => {
    const p = param({ pattern: '[a-z]+' });
    expect(valueProblem(p, 'alpha')).toBeNull();
    expect(valueProblem(p, 'Alpha1')).toMatch(/Must match/);
    expect(valueProblem(p, '')).toBeNull();
  });

  it('checks a number against its bounds', () => {
    const p = param({ type: 'number', min: 1, max: 5 });
    expect(valueProblem(p, 3)).toBeNull();
    expect(valueProblem(p, 0)).toBe('Must be at least 1');
    expect(valueProblem(p, 9)).toBe('Must be at most 5');
  });
});

describe('serverInputs', () => {
  it('sends only the params the server document declares, never a Console type', () => {
    const params = [
      param({ name: 'bridge', type: 'bridge' }),
      param({ name: 'provider', type: 'provider' }),
      param({ name: 'name' }),
      param({ name: 'size', type: 'number' }),
    ];
    const values = { bridge: 'Slack', provider: 'claude', name: 'Expert', size: '3' };
    expect(serverInputs(params, values, new Set(['bridge', 'size', 'provider']))).toEqual({
      bridge: 'Slack',
      size: 3,
    });
  });
});

describe('sectionOf', () => {
  const agents = [['{name}', '{provider}'], ['{other}']];
  const room = 'name: "Ask {agent}"\nbridge: "{bridge}"\n';
  it('puts a param with the agent that reads it, and the rest with the room', () => {
    expect(sectionOf(param({ name: 'provider' }), agents, room)).toEqual({
      section: 'agent',
      index: 0,
    });
    expect(sectionOf(param({ name: 'other' }), agents, room)).toEqual({
      section: 'agent',
      index: 1,
    });
    expect(sectionOf(param({ name: 'bridge' }), agents, room)).toEqual({ section: 'room' });
  });

  it('keeps a room param with the room even when an agent joins it', () => {
    expect(sectionOf(param({ name: 'where', type: 'room' }), [['{where}']], room)).toEqual({
      section: 'room',
    });
  });
});

describe('paramLabel', () => {
  it('prefers the template label, then a readable name for the common types', () => {
    expect(paramLabel(param({ name: 'bridge', type: 'bridge', label: 'Chat app' }))).toBe(
      'Chat app'
    );
    expect(paramLabel(param({ name: 'bridge', type: 'bridge' }))).toBe('Messaging app');
    expect(paramLabel(param({ name: 'team' }))).toBe('team');
  });
});

describe('agentCreateSteps', () => {
  const base = { name: 'a', clones: false, setsPolicy: true, cloneWarning: null } as const;

  it('marks the rows before the call in progress done, the one at it running', () => {
    const steps = agentCreateSteps(0, { ...base, status: 'creating', step: 'create' });
    expect(steps.map((s) => s.status)).toEqual(['done', 'running', 'waiting']);
  });

  it('marks every row done for a created agent, whatever step it stopped on', () => {
    const steps = agentCreateSteps(0, { ...base, status: 'created', step: 'policy' });
    expect(steps.map((s) => s.status)).toEqual(['done', 'done', 'done']);
  });

  it('marks the failed call failed and leaves the rest waiting', () => {
    const steps = agentCreateSteps(0, { ...base, status: 'failed', step: 'policy' });
    expect(steps.map((s) => s.status)).toEqual(['done', 'done', 'failed']);
  });

  it('has no policy row when the template sets no addressing', () => {
    expect(
      agentCreateSteps(0, { ...base, setsPolicy: false, status: 'idle', step: null })
    ).toHaveLength(2);
  });
});

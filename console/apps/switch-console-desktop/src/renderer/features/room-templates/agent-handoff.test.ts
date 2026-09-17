import { describe, expect, it } from 'vitest';
import { blockedHandoffs, type HandoffAgent } from './agent-handoff';

const ownerOnly = {
  rules: [{ rooms: '*' as const, room_groups: '*' as const, users: [], agents: [], owner: true }],
};

function agent(name: string, overrides: Partial<HandoffAgent> = {}): HandoffAgent {
  return { id: `id-${name}`, name, ownerId: 'u1', addressingPolicy: null, ...overrides };
}

describe('blockedHandoffs', () => {
  it('open agents hear each other', () => {
    expect(blockedHandoffs([agent('coder'), agent('reviewer')])).toEqual([]);
  });

  it('an owner-only agent does not hear the other agent', () => {
    const blocked = blockedHandoffs([
      agent('coder'),
      agent('reviewer', { addressingPolicy: ownerOnly }),
    ]);
    expect(blocked).toEqual([{ from: 'coder', to: 'reviewer' }]);
  });

  it('owner_agents admits an agent of the same owner and nobody else', () => {
    const policy = { rules: [{ ...ownerOnly.rules[0], owner_agents: true }] };
    const reviewer = agent('reviewer', { addressingPolicy: policy });
    expect(blockedHandoffs([agent('coder'), reviewer])).toEqual([]);
    expect(blockedHandoffs([agent('stranger', { ownerId: 'u2' }), reviewer])).toEqual([
      { from: 'stranger', to: 'reviewer' },
    ]);
  });

  it('an explicit agent id in the rule admits that agent', () => {
    const policy = {
      rules: [{ rooms: '*' as const, room_groups: '*' as const, users: [], agents: ['id-coder'] }],
    };
    expect(
      blockedHandoffs([agent('coder'), agent('reviewer', { addressingPolicy: policy })])
    ).toEqual([]);
  });
});

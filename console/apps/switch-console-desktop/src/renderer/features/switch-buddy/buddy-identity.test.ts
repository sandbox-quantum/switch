import { describe, expect, it } from 'vitest';
import { buddyAgentName, isBuddy } from './buddy-identity';

describe('buddyAgentName', () => {
  it('names the buddy after its person', () => {
    expect(buddyAgentName({ name: 'Max Müller', email: null }, new Set())).toBe(
      'switch-buddy-max-muller'
    );
  });

  it('falls back to the e-mail, then to no person at all', () => {
    expect(buddyAgentName({ name: '  ', email: 'max.m@acme.com' }, new Set())).toBe(
      'switch-buddy-max.m'
    );
    expect(buddyAgentName({ name: null, email: null }, new Set())).toBe('switch-buddy');
  });

  it('adds a number when the name is taken', () => {
    const taken = new Set(['switch-buddy-max', 'switch-buddy-max-2']);
    expect(buddyAgentName({ name: 'Max', email: null }, taken)).toBe('switch-buddy-max-3');
  });
});

describe('isBuddy', () => {
  it('knows a buddy by its name, whatever its picture', () => {
    expect(isBuddy({ name: 'switch-buddy-max' })).toBe(true);
    expect(isBuddy({ name: 'switch-buddy' })).toBe(true);
    expect(isBuddy({ name: 'helper' })).toBe(false);
    expect(isBuddy({ name: 'switch-buddyish' })).toBe(false);
  });
});

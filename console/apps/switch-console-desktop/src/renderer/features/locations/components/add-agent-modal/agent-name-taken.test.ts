import { describe, expect, it } from 'vitest';
import { isAgentNameTaken } from './agent-name-taken';

const base = {
  name: 'qweqwe-123',
  nameIsValid: true,
  takenNames: new Set(['qweqwe-123']),
  creating: false,
  createdName: null,
};

describe('isAgentNameTaken', () => {
  it('reports a name another agent on the server already has', () => {
    expect(isAgentNameTaken(base)).toBe(true);
  });

  it('reports nothing for a free name', () => {
    expect(isAgentNameTaken({ ...base, takenNames: new Set(['other']) })).toBe(false);
  });

  it('reports nothing for a name that is not valid yet', () => {
    expect(isAgentNameTaken({ ...base, nameIsValid: false })).toBe(false);
  });

  it('does not report the new agent while it is being created', () => {
    // The server lists the agent before the create call returns to the form.
    expect(isAgentNameTaken({ ...base, creating: true })).toBe(false);
  });

  it('does not report the agent this form just created while the form closes', () => {
    expect(isAgentNameTaken({ ...base, createdName: 'qweqwe-123' })).toBe(false);
  });

  it('still reports a clash when the name is changed after a create', () => {
    expect(
      isAgentNameTaken({
        ...base,
        name: 'taken',
        takenNames: new Set(['qweqwe-123', 'taken']),
        createdName: 'qweqwe-123',
      })
    ).toBe(true);
  });
});

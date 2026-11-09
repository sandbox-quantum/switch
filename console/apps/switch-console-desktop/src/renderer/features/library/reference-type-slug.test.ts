import { describe, expect, it } from 'vitest';
import { slugAsTyped, slugFromName, slugProblem } from './reference-type-slug';

const known = { builtin: new Set(['github']), taken: new Set(['linear']) };

describe('the reference type slug', () => {
  it('is made from the name', () => {
    expect(slugFromName('Linear issues')).toBe('linear_issues');
    expect(slugFromName('  Q4 / roadmap docs! ')).toBe('q4_roadmap_docs');
    expect(slugFromName('2024 Plans')).toBe('plans');
    expect(slugFromName('x'.repeat(80))).toHaveLength(63);
  });

  it('mends the common slips as it is typed', () => {
    expect(slugAsTyped('Linear Issues')).toBe('linear_issues');
    expect(slugAsTyped('my-type')).toBe('my_type');
    expect(slugAsTyped('café')).toBe('café');
  });

  it('says in words what is wrong', () => {
    expect(slugProblem('', known)).toBe('Give it a slug.');
    expect(slugProblem('café', known)).toBe('Use only letters, digits and underscores.');
    expect(slugProblem('2fa', known)).toBe('Start with a letter.');
    expect(slugProblem('a', known)).toBe('At least 2 characters.');
    expect(slugProblem(`a${'b'.repeat(63)}`, known)).toBe('At most 63 characters.');
    expect(slugProblem('github', known)).toBe('Switch already has a built-in type with this slug.');
    expect(slugProblem('linear', known)).toBe('Another type already uses this slug.');
    expect(slugProblem('linear_issues', known)).toBeNull();
  });
});

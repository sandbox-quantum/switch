import { describe, expect, it } from 'vitest';
import { AGENT_NAME_PATTERN, slugifyAgentNamePart } from './agent-slug';

const INPUTS = [
  '',
  'Switch Dev',
  'Buddy',
  '  ',
  '@@@',
  '.Foo',
  '_bar',
  'foo--bar',
  'Ünïcødé',
  'UPPER.Case_9',
  'x'.repeat(4096),
  // Separators are in the charset, so a run of them reaches the trailing strip
  // uncollapsed — the shape that made an earlier form of it quadratic.
  `a${'.'.repeat(50_000)}a`,
  '_'.repeat(50_000),
];

describe('slugifyAgentNamePart', () => {
  // The invariant the suggestion chip rests on: a slug is either offerable or
  // absent, never a name the validator would reject all over again.
  it.each(INPUTS)('returns an empty string or a valid name for %j', (input) => {
    const slug = slugifyAgentNamePart(input);
    expect(slug === '' || AGENT_NAME_PATTERN.test(slug)).toBe(true);
  });

  it('lowercases and keeps the allowed charset', () => {
    expect(slugifyAgentNamePart('My-Repo.v2_x')).toBe('my-repo.v2_x');
  });

  it('replaces disallowed characters with a single hyphen', () => {
    expect(slugifyAgentNamePart('foo bar//baz')).toBe('foo-bar-baz');
  });

  it('slugifies a spaced display name into a hyphenated one', () => {
    expect(slugifyAgentNamePart('Switch Dev')).toBe('switch-dev');
  });

  it('strips leading and trailing separators, not only hyphens', () => {
    expect(slugifyAgentNamePart('.Foo')).toBe('foo');
    expect(slugifyAgentNamePart('_bar')).toBe('bar');
    expect(slugifyAgentNamePart('baz_')).toBe('baz');
    expect(slugifyAgentNamePart('  @weird@  ')).toBe('weird');
  });

  it('returns empty when nothing survives', () => {
    expect(slugifyAgentNamePart('@@@')).toBe('');
    expect(slugifyAgentNamePart('   ')).toBe('');
    expect(slugifyAgentNamePart('')).toBe('');
  });

  it('offers nothing rather than a shortened name for an over-long one', () => {
    expect(slugifyAgentNamePart('a'.repeat(128))).toBe('a'.repeat(128));
    expect(slugifyAgentNamePart('a'.repeat(129))).toBe('');
  });

  it('leaves an already-valid name alone', () => {
    expect(slugifyAgentNamePart('buddy')).toBe('buddy');
  });
});

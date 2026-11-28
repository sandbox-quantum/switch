import { expect, it } from 'vitest';
import { isSafeId, safeId } from './safe-id';

it('accepts ids as servers and providers mint them', () => {
  for (const id of ['00000000-0000-4000-8000-0000000000a1', 'agent-1', 't1', 'a.b_c-d'])
    expect(isSafeId(id)).toBe(true);
});

it('refuses anything that could leave a directory or name a hidden file', () => {
  for (const id of [
    '',
    '.',
    '..',
    '.hidden',
    'a/b',
    'a\\b',
    'a..b',
    '../x',
    'a\0b',
    'a b',
    'x'.repeat(201),
  ])
    expect(isSafeId(id)).toBe(false);
  expect(() => safeId('../x', 'agent id')).toThrow(
    "The agent id '../x' cannot be used in a file name."
  );
});

import { describe, expect, it } from 'vitest';
import { keepFailure } from './use-state-bound-failure';

describe('a failure bound to the state it happened in', () => {
  const refused = { error: new Error('Bring back builder first.'), stateKey: 'running|builder' };

  it('stays while that state lasts', () => {
    expect(keepFailure(refused, 'running|builder')).toBe(refused);
  });

  it('is dropped once the state moves on', () => {
    expect(keepFailure(refused, 'running|')).toBeNull();
    expect(keepFailure(refused, 'removed|builder')).toBeNull();
  });

  it('stays empty when there is none', () => {
    expect(keepFailure(null, 'running|')).toBeNull();
  });
});

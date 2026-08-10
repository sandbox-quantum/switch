import { describe, expect, it } from 'vitest';
import {
  ensureUniqueSessionName,
  liveTransformSessionName,
  normalizeSessionName,
  sessionNameCollisionKey,
} from './sessionNames';

describe('sessionNames', () => {
  it('lowercases session names by default when transforming session names', () => {
    expect(liveTransformSessionName('feature PROJ-123')).toBe('feature-proj-123');
  });

  it('lowercases session names by default when normalizing session names', () => {
    expect(normalizeSessionName('  feature PROJ-123  ')).toBe('feature-proj-123');
  });

  it('preserves capital letters when configured', () => {
    expect(liveTransformSessionName('feature PROJ-123', { preserveCapitalization: true })).toBe(
      'feature-PROJ-123'
    );
    expect(normalizeSessionName('  feature PROJ-123  ', { preserveCapitalization: true })).toBe(
      'feature-PROJ-123'
    );
  });

  it('normalizes session names to a case-insensitive collision key', () => {
    expect(sessionNameCollisionKey('  feature PROJ-123  ')).toBe('feature-proj-123');
  });

  it('keeps generated unique session names distinct case-insensitively', () => {
    expect(ensureUniqueSessionName('Feature-PROJ-123', ['feature-proj-123'])).toBe(
      'feature-proj-123-2'
    );
  });

  it('keeps generated unique session names capitalized when configured', () => {
    expect(
      ensureUniqueSessionName('Feature-PROJ-123', ['feature-proj-123'], 6, {
        preserveCapitalization: true,
      })
    ).toBe('Feature-PROJ-123-2');
  });
});

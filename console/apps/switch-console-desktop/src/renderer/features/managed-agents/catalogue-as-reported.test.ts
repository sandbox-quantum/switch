import { describe, expect, it } from 'vitest';
import { catalogueAsReported } from './catalogue-as-reported';

const models = {
  kind: 'available' as const,
  models: [{ id: 'gpt-6-sol', name: 'GPT-6-Sol', variants: [] }],
};

describe('catalogueAsReported', () => {
  it('says what the machine reports when its provider is not ready', () => {
    expect(
      catalogueAsReported(models, 'FHXDK633MX', 'codex', { ready: false, problem: 'not signed in' })
    ).toEqual({
      kind: 'unavailable',
      reason: 'FHXDK633MX reports codex not signed in. You can enter a model ID.',
    });
  });

  it('does not call a provider the machine reports ready missing', () => {
    const outcome = catalogueAsReported(
      {
        kind: 'unavailable',
        reason: 'Codex is not installed or its selected executable cannot be found.',
      },
      'FHXDK633MX',
      'codex',
      { ready: true, problem: null }
    );
    expect(outcome?.kind).toBe('unavailable');
    expect(outcome && 'reason' in outcome ? outcome.reason : '').toMatch(
      /^FHXDK633MX reports codex ready/
    );
  });

  it('keeps the models when both agree, or the machine has not reported', () => {
    expect(catalogueAsReported(models, 'm', 'codex', { ready: true, problem: null })).toBe(models);
    expect(catalogueAsReported(models, 'm', 'codex', undefined)).toBe(models);
  });
});

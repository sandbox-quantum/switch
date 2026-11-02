import { eventBytes } from '@switch-console/shared/session-v1';
import { describe, expect, it } from 'vitest';
import { fitModelCatalog, type SessionModel } from './model-catalog';

function catalog(count: number): SessionModel[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `model-${i}`,
    label: `Model ${i} with a descriptive label`,
    options: { effort: ['low', 'medium', 'high'] },
  }));
}

describe('fitModelCatalog', () => {
  it('keeps a catalog that fits as it is', () => {
    const models = catalog(3);
    expect(fitModelCatalog(models, null, 10_000)).toEqual({
      models,
      omitted: 0,
      optionsDropped: false,
    });
  });

  it('drops the options first, but not the selected model’s', () => {
    const models = catalog(20);
    const fitted = fitModelCatalog(models, 'model-4', eventBytes(models) - 1);
    expect(fitted.omitted).toBe(0);
    expect(fitted.optionsDropped).toBe(true);
    expect(fitted.models.find((m) => m.id === 'model-4')?.options).toEqual(models[4]!.options);
    expect(fitted.models.find((m) => m.id === 'model-5')?.options).toEqual({});
  });

  it('then lists what fits, the selected model first, within the budget', () => {
    const models = catalog(500);
    const fitted = fitModelCatalog(models, 'model-499', 4_000);
    expect(fitted.models[0]!.id).toBe('model-499');
    expect(fitted.omitted).toBe(500 - fitted.models.length);
    expect(fitted.omitted).toBeGreaterThan(0);
    expect(eventBytes(fitted.models)).toBeLessThanOrEqual(4_000);
  });
});

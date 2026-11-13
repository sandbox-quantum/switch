import { eventBytes } from '@switch-console/shared/session-v1';
import type { Session } from '@switch-console/shared/session-v1';

export type SessionModel = NonNullable<Session['models']>[number];

/**
 * How much of a session event the model catalog may take. Every event is held
 * to 64 KiB, and the catalog rides on each `session.upsert` beside the rest of
 * the session record, which is small.
 */
export const MODEL_CATALOG_BYTES = 48 * 1024;

export type FittedCatalog = {
  models: SessionModel[];
  /** How many of the provider's models were left out to fit. */
  omitted: number;
  /** Whether the models' options were left out to fit (the selected one keeps its own). */
  optionsDropped: boolean;
};

/**
 * The provider's model catalog cut to fit `budget` bytes: whole if it fits;
 * else without the models' options (the selected model keeps its own); else
 * also without the models past what fits, the selected one always kept and
 * first. A provider with hundreds of models (OpenCode with many providers
 * signed in) would otherwise make every `session.upsert` too large to record.
 */
export function fitModelCatalog(
  models: SessionModel[],
  selectedId: string | null,
  budget = MODEL_CATALOG_BYTES
): FittedCatalog {
  if (eventBytes(models) <= budget) return { models, omitted: 0, optionsDropped: false };
  const bare = models.map((model) => (model.id === selectedId ? model : { ...model, options: {} }));
  if (eventBytes(bare) <= budget) return { models: bare, omitted: 0, optionsDropped: true };
  const selected = bare.filter((model) => model.id === selectedId);
  const rest = bare.filter((model) => model.id !== selectedId);
  const kept = [...selected];
  // The array's brackets, then each model and the comma before it.
  let used = 2 + kept.reduce((total, model) => total + eventBytes(model) + 1, 0);
  for (const model of rest) {
    const size = eventBytes(model) + 1;
    if (used + size > budget) break;
    kept.push(model);
    used += size;
  }
  return { models: kept, omitted: models.length - kept.length, optionsDropped: true };
}

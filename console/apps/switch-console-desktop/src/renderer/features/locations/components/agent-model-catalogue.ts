import type { LaunchProfileModel, RepoAgentField } from '@switch-console/core/agents/plugins';
import type { FormState } from './agent-definition-fields';

/**
 * What the main process could tell us about the models an agent's host offers.
 * Mirrors `AgentModelCatalogue`.
 */
export type ModelCatalogueResult =
  | { kind: 'available'; models: LaunchProfileModel[] }
  | { kind: 'unavailable'; reason: string };

/** How a catalogue-bound field should render, once the catalogue is known. */
export type FieldCatalogueState = {
  /** Replaces the field's own options when the catalogue supplies them. */
  options?: { value: string; label: string }[];
  /**
   * Models to offer as you type. Suggestions rather than options: the field
   * stays free text, because the catalogue is a snapshot and a model may be
   * about to exist.
   */
  suggestions?: LaunchProfileModel[];
  /** Nothing can be chosen — shown disabled with `note` as the reason. */
  disabled?: boolean;
  /** Something the user should read: why a value looks wrong, or why we can't tell. */
  note?: string;
  /** True when `note` is a problem rather than an explanation. */
  warning?: boolean;
};

const UNSET_OPTION = { value: '', label: 'Default' };

/**
 * Work out how one field should behave against the host catalogue.
 *
 * Everything here warns rather than blocks. The catalogue is a snapshot of a
 * machine that changes without us — a model can be pulled or a provider added a
 * second after it was read — so a value we cannot vouch for is flagged and still
 * saved. Refusing it would make a stale reading worse than no reading.
 */
export function fieldCatalogueState(
  field: RepoAgentField,
  form: FormState,
  catalogue: ModelCatalogueResult | undefined
): FieldCatalogueState {
  if (!field.catalogue) return {};
  if (!catalogue) return {};

  if (catalogue.kind === 'unavailable') {
    // Degrade visibly. The field still works; it just cannot check itself, and
    // saying so beats silently accepting anything as if it had been verified.
    return {
      note: `Couldn't read this host's models, so this isn't checked. ${catalogue.reason}`,
    };
  }

  if (field.catalogue.kind === 'model') {
    return modelFieldState(String(form[field.key] ?? '').trim(), catalogue.models);
  }
  return variantFieldState(
    String(form[field.catalogue.modelField] ?? '').trim(),
    String(form[field.key] ?? '').trim(),
    catalogue.models
  );
}

function modelFieldState(value: string, models: LaunchProfileModel[]): FieldCatalogueState {
  // Offered whatever the current value is, so the list is a way to discover what
  // this host has rather than only a check on what was typed.
  const suggestions = { suggestions: models };
  if (!value) return suggestions;
  if (models.some((model) => model.id === value)) return suggestions;

  return {
    ...suggestions,
    warning: true,
    note: `This host doesn't currently offer "${value}". It'll be saved anyway — check the name, or add the model to your OpenCode config first.`,
  };
}

function variantFieldState(
  modelValue: string,
  value: string,
  models: LaunchProfileModel[]
): FieldCatalogueState {
  // No model chosen: the agent runs on whatever the host's own config selects,
  // and we cannot know which that is, so we cannot say which variants apply.
  if (!modelValue) {
    return { note: 'Choose a model above to see the reasoning variants it accepts.' };
  }

  const model = models.find((candidate) => candidate.id === modelValue);
  // The model itself is already flagged on its own field; not repeated here.
  if (!model) return {};

  if (model.variants.length === 0) {
    return {
      disabled: true,
      note: `${modelValue} has no reasoning variants — most local models don't.`,
    };
  }

  return {
    options: [
      UNSET_OPTION,
      ...model.variants.map((variant) => ({ value: variant, label: variant })),
    ],
    // A value carried over from a different model is not silently dropped: it is
    // still stored, and OpenCode would ignore it without saying so.
    ...(value && !model.variants.includes(value)
      ? { warning: true, note: `${modelValue} doesn't accept "${value}" — it would be ignored.` }
      : {}),
  };
}

/**
 * The field as it should render, with catalogue-supplied choices folded in.
 *
 * A field whose choices come from the catalogue becomes a select; without them
 * it keeps the type the provider declared, which is what makes the degraded
 * path the same code as the working one.
 */
export function fieldWithCatalogue(
  field: RepoAgentField,
  state: FieldCatalogueState
): RepoAgentField {
  if (!state.options) return field;
  return { ...field, type: 'select', options: state.options };
}

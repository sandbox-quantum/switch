import type { LaunchProfileModel } from '@switch-console/core/agents/plugins';
import { useMemo } from 'react';
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from '@renderer/lib/ui/combobox';

/** One provider's model ids, so a long list reads as a few short ones. */
type ProviderGroup = { value: string; items: string[] };

/**
 * A model field: type freely, or pick from what the host actually offers.
 *
 * A plain select would be wrong here. The catalogue is a snapshot of a machine
 * that changes without us — a model can be pulled a second after it was read —
 * so a model that is not in the list has to stay typeable, and is flagged
 * elsewhere rather than prevented. The list is a shortcut, not a constraint.
 *
 * Grouped by provider because the whole point of the field is that a local
 * provider sits alongside the cloud ones, and forty entries in one flat list
 * hides that.
 *
 * **The items are model id strings, not model objects.** The combobox fills the
 * input by stringifying whatever item it was handed, and it derives that string
 * from an item's `label` or `value` — a shape like `{id, variants}` has neither,
 * so picking one wrote a serialized object into the field and every later check
 * then failed to match it against the catalogue. The wrapper deliberately does
 * not expose `itemToStringLabel`, so there is no hook to correct it with; the
 * item has to be the string the field stores. Variants are looked up for display
 * instead of being carried in the item.
 */
export function ModelCombobox({
  id,
  value,
  models,
  placeholder,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  models: LaunchProfileModel[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const groups = useMemo(() => groupByProvider(models), [models]);
  const variantsOf = useMemo(
    () => new Map(models.map((model) => [model.id, model.variants])),
    [models]
  );

  return (
    <Combobox
      items={groups}
      // The typed text is the value: picking an item fills the box, and what is
      // in the box is what gets saved, listed or not.
      inputValue={value}
      onInputValueChange={(next: string) => onChange(next)}
      onValueChange={(next: string | null) => onChange(next ?? '')}
      openOnInputClick
    >
      <ComboboxInput id={id} placeholder={placeholder} disabled={disabled} />
      <ComboboxContent>
        <ComboboxList>
          {(group: ProviderGroup) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(modelId: string) => (
                  <ComboboxItem key={modelId} value={modelId}>
                    <span className="truncate">{modelId}</span>
                    {(variantsOf.get(modelId)?.length ?? 0) > 0 && (
                      <span className="ml-auto shrink-0 pr-1 text-xs text-foreground-muted">
                        {variantsOf.get(modelId)!.join(' · ')}
                      </span>
                    )}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
        {/* Not an error: a name that matches nothing is still allowed, and the
            field's own note says whether the host knows it. */}
        <ComboboxEmpty>No model of that name on this host.</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  );
}

/**
 * Group model ids by their provider, each group's models in the order the host
 * listed them — that order is the host's own preference and is not ours to
 * re-sort.
 */
export function groupByProvider(models: LaunchProfileModel[]): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  for (const model of models) {
    const provider = model.id.split('/')[0] ?? '';
    const group = groups.find((candidate) => candidate.value === provider);
    if (group) group.items.push(model.id);
    else groups.push({ value: provider, items: [model.id] });
  }
  return groups;
}

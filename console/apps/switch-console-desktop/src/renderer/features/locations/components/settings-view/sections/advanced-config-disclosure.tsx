import { AdvancedConfigDisclosure as Disclosure } from '@switch-console/chat-ui/components/advanced-config-disclosure';
import type { RepoAgentField } from '@switch-console/core/agents/plugins';
import {
  DefinitionFieldInput,
  type FormState,
  type FormValue,
} from '@renderer/features/locations/components/agent-definition-fields';
import {
  fieldCatalogueState,
  fieldWithCatalogue,
  type ModelCatalogueResult,
} from '@renderer/features/locations/components/agent-model-catalogue';

/**
 * An agent page's "Advanced configuration", each field drawn with Console's
 * definition inputs and the model fields checked against what the agent's
 * host offers. Whoever renders it owns the values and saving them.
 */
export function AdvancedConfigDisclosure({
  fields,
  form,
  summary,
  catalogue,
  intro,
  onFieldChange,
  children,
}: {
  fields: RepoAgentField[];
  form: FormState;
  /** What the saved values are, for the collapsed row; see `summariseValues`. */
  summary: string;
  catalogue: ModelCatalogueResult | undefined;
  intro: React.ReactNode;
  onFieldChange: (key: string, value: FormValue) => void;
  /** Below the fields, such as a notice about sessions running on the old values. */
  children?: React.ReactNode;
}) {
  return (
    <Disclosure
      fields={fields}
      summary={summary}
      intro={intro}
      renderField={(field) => {
        const catalogueState = fieldCatalogueState(field, form, catalogue);
        return {
          input: (
            <DefinitionFieldInput
              field={fieldWithCatalogue(field, catalogueState)}
              value={form[field.key] ?? (field.type === 'boolean' ? false : '')}
              disabled={catalogueState.disabled}
              suggestions={catalogueState.suggestions}
              onChange={(value) => onFieldChange(field.key, value)}
            />
          ),
          note: catalogueState.note
            ? { text: catalogueState.note, warning: catalogueState.warning === true }
            : null,
        };
      }}
    >
      {children}
    </Disclosure>
  );
}
